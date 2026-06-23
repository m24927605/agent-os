/**
 * END-TO-END composition proof for the Developer vertical (SLICE-DV1).
 *
 * This drives the in-memory composition root `createDeveloperKit` through the WHOLE Developer-surface
 * spine — `authorTool(registry deny-by-default) → runTool(governed: screen→authorize→cost→
 * commit-before-effect→effect) → WORM → replayFold + verifyEvidenceChain(INDEPENDENT)` — with the REAL
 * in-tree fakes (ToolRegistry, FakeSandboxAdapter, InMemoryCostGate, screenBrainEvent, authorizeToolInvoke,
 * InMemoryAppendOnlyLog). It proves:
 *   (1) HAPPY full chain: author a 9-field manifest -> ToolBinding pins name/version/resourcePattern/action;
 *       runTool(that registered tool) -> executed + a FakeSandbox created + the WORM gained ONE AuditEvent;
 *       replayFold() -> a deterministic TaskTimeline reflecting the step.
 *   (2) REGISTRY deny-by-default (the surface's core): runTool an UNREGISTERED tool -> denied@policy
 *       (authorizeToolInvoke deny-by-default), the effect never ran, the WORM gained NOTHING.
 *   (3) manifest guardrail: a destructive+no-approval manifest -> rejected (guardrail B); an unknown
 *       field -> rejected (.strict). Both via verifyToolManifest AND authorTool (fail-closed throw).
 *   (4) credential-blind: a runtime-assembled `sk-` canary in the toolCall args -> denied@screen (effect
 *       not run); bundleRefFor produces a `bundle://` value that passes the screen.
 *   (5) INDEPENDENT verify spawn-relay contract (the moat — proven here with a TEST-DOUBLE verifier):
 *       point AGENTOS_VERIFIER_BIN at a tiny stub script that exits 0/1/2; assert verifyEvidenceChain
 *       maps exit 0->{ok:true}, 1->{ok:false,broken}, 2->{ok:false,bad-input}, and absent-binary->{ok:false}
 *       fail-closed. (The REAL verifier-binary intact/broken proof is DV2.) Also asserts, by reading
 *       bootstrap.ts source, that it imports NO Go and does NOT re-implement chain hashing in TS.
 *
 * RED-first: `./bootstrap.js` does not exist yet, so the import below fails and the suite cannot run.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../iam/ids.js";
import { createDeveloperKit } from "./bootstrap.js";

// A runtime-assembled secret canary — never a literal in source, so scan_secrets.sh stays clean.
const CANARY = `sk-${"d".repeat(24)}`;

const ctx: AgentContext = {
  actorId: "agent:dev",
  tenantId: "tenant-dev",
  projectId: "proj-dev",
  taskId: "task-dev",
  requestId: "req-dev",
} as AgentContext;

/** A valid 9-field manifest in the kit's default `dev:` namespace (so the default allow rule matches). */
function validManifest(name = "dev:echo"): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    description: "echo tool for the developer kit",
    action: "invoke",
    resourcePattern: "dev:echo:*",
    sideEffect: "read",
    idempotent: true,
    requiresApproval: false,
    bundleRefOnly: true,
  };
}

/** A tool call whose `tool` is the manifest `name` (the registry key / authorize resource). */
function toolCall(
  tool: string,
  args: Record<string, unknown> = {},
): {
  readonly tool: string;
  readonly context: AgentContext;
  readonly args: Record<string, unknown>;
} {
  return { tool, context: ctx, args };
}

describe("createDeveloperKit — end-to-end Developer vertical over the real in-memory fakes", () => {
  it("(1) HAPPY FULL CHAIN: authorTool -> ToolBinding pins fields; runTool(registered) -> executed + sandbox + WORM+1; replayFold deterministic", async () => {
    const kit = createDeveloperKit();

    // authorTool a valid 9-field manifest -> a ToolBinding that pins name/version/resourcePattern/action.
    const binding = kit.authorTool(validManifest("dev:echo"));
    expect(binding.name).toBe("dev:echo");
    expect(binding.version).toBe("1.0.0");
    expect(binding.resourcePattern).toBe("dev:echo:*");
    expect(binding.action).toBe("invoke");

    // The registry snapshot now contains exactly that manifest.
    const tools = kit.registeredTools();
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe("dev:echo");

    // runTool the REGISTERED tool -> the governed pipeline executes (every gate passed).
    const outcome = await kit.runTool(toolCall("dev:echo", { note: "hello" }));
    expect(outcome.status).toBe("executed");
    if (outcome.status !== "executed") return;

    // A FakeSandbox was really created during the effect (the kit reports it).
    expect(outcome.sandboxCreated).toBe(true);

    // The WORM gained EXACTLY ONE AuditEvent (commit-before-effect appended it before the effect ran).
    const tl = kit.replayFold();
    expect(tl.steps.length).toBe(1);
    expect(tl.headSequence).toBe(0);

    // replayFold is DETERMINISTIC: a second fold over the same WORM yields the SAME timelineHash.
    const tl2 = kit.replayFold();
    expect(tl2.timelineHash).toBe(tl.timelineHash);
    expect(tl.timelineHash.startsWith("sha256:")).toBe(true);

    // The folded step reflects the governed tool invocation (a real AuditEvent for dev:echo).
    const step = tl.steps[0];
    expect(step?.sequence).toBe(0);
    const event = step?.event as { resource?: string; action?: string; result?: string };
    expect(event.resource).toBe("dev:echo");
    expect(event.action).toBe("tool:invoke");
    expect(event.result).toBe("success");
  });

  it("(2) REGISTRY DENY-BY-DEFAULT: runTool an UNREGISTERED tool -> denied@policy, NO effect, WORM empty", async () => {
    // NOTE (non-vacuity mutation): if runTool's authorize were a hardcoded allow (ignoring the registry),
    // this UNREGISTERED tool would EXECUTE and the WORM would gain an entry — flipping this test RED.
    const kit = createDeveloperKit();

    // No authorTool was called -> "dev:never-registered" is NOT in the registry.
    const outcome = await kit.runTool(toolCall("dev:never-registered", { note: "x" }));
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") return;
    // authorizeToolInvoke denies an unregistered tool BEFORE the PDP/cost/effect -> stage "policy".
    expect(outcome.stage).toBe("policy");

    // The effect never ran and NOTHING was committed to the WORM.
    expect(kit.replayFold().steps.length).toBe(0);
  });

  it("(3) MANIFEST GUARDRAIL: destructive+no-approval rejected (guardrail B); unknown field rejected (.strict)", () => {
    const kit = createDeveloperKit();

    // Guardrail B: a destructive tool MUST require approval; verifyToolManifest is fail-closed.
    const destructive = {
      ...validManifest("dev:rm"),
      sideEffect: "destructive",
      requiresApproval: false,
    };
    expect(() => kit.verifyToolManifest(destructive)).toThrow();
    // authorTool MUST NOT swallow the throw (it mirrors the registry/parse contract).
    expect(() => kit.authorTool(destructive)).toThrow();

    // .strict: an unknown field is an attack surface, not silently accepted.
    const unknownField = { ...validManifest("dev:extra"), surpriseField: "nope" };
    expect(() => kit.verifyToolManifest(unknownField)).toThrow();
    expect(() => kit.authorTool(unknownField)).toThrow();

    // Neither rejected manifest leaked into the registry (fail-closed register).
    expect(kit.registeredTools().length).toBe(0);
  });

  it("(4) CREDENTIAL-BLIND: a runtime-assembled sk- canary in args -> denied@screen, NO effect; bundleRefFor passes", async () => {
    // NOTE (non-vacuity mutation): if the effect ran BEFORE the credential screen, the canary-bearing
    // call would create a sandbox and commit a WORM entry — flipping this test RED.
    const kit = createDeveloperKit();
    kit.authorTool(validManifest("dev:echo"));

    // The canary rides in the tool-call args (defense in depth: a secret slipped past the author).
    const denied = await kit.runTool(toolCall("dev:echo", { leaked: CANARY }));
    expect(denied.status).toBe("denied");
    if (denied.status !== "denied") return;
    expect(denied.stage).toBe("screen");

    // The effect never ran and nothing was committed; the canary never reaches the WORM/timeline.
    const tl = kit.replayFold();
    expect(tl.steps.length).toBe(0);
    expect(JSON.stringify(tl)).not.toContain(CANARY);

    // A bundleRef is the credential-blind way to reference a credential: the VALUE is a `bundle://`
    // pointer (no literal secret), so it passes the screen and executes. The arg is held under a
    // benign key (NOT a secret-named key like `credential`/`token`, which the by-KEY detector redacts
    // regardless of value) so this test isolates the by-VALUE proof: a `bundle://` value is clean.
    const ref = kit.bundleRefFor("dev/echo/cred-handle");
    expect(ref).toBe("bundle://dev/echo/cred-handle");
    const ok = await kit.runTool(toolCall("dev:echo", { target: ref }));
    expect(ok.status).toBe("executed");
  });

  it("(5) INDEPENDENT verify spawn-relay (the moat, proven with a TEST-DOUBLE): exit 0/1/2 mapped + absent-binary fail-closed", async () => {
    // A tiny STUB verifier script standing in for the released `agentos-verifier` (DV1 proves the
    // spawn-relay CONTRACT hermetically; DV2 swaps in the REAL binary for intact/broken proofs). It
    // exits with the code named by an env marker so this test can drive each relay branch.
    const dir = mkdtempSync(join(tmpdir(), "dv1-verifier-"));
    const stub = join(dir, "stub-verifier.sh");
    // The stub IGNORES its args (it does not actually verify) and exits the marker code.
    writeFileSync(stub, '#!/usr/bin/env bash\nexit "${DV1_STUB_EXIT:-0}"\n');
    chmodSync(stub, 0o755);
    const pubkey = join(dir, "pub.pem");
    // A non-empty pubkey file (the stub never reads it, but verifyEvidenceChain must pass a real path).
    writeFileSync(pubkey, "-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----\n");

    const kit = createDeveloperKit();
    kit.authorTool(validManifest("dev:echo"));
    await kit.runTool(toolCall("dev:echo", { note: "for-the-chain" }));

    // exit 0 -> intact.
    const intact = await kit.verifyEvidenceChain(pubkey, {
      AGENTOS_VERIFIER_BIN: stub,
      DV1_STUB_EXIT: "0",
    });
    expect(intact.ok).toBe(true);

    // exit 1 -> broken (NOT swallowed into intact).
    // NOTE (non-vacuity mutation): if verifyEvidenceChain swallowed the exit code (always {ok:true}),
    // this and the bad-input/absent branches would all flip RED.
    const broken = await kit.verifyEvidenceChain(pubkey, {
      AGENTOS_VERIFIER_BIN: stub,
      DV1_STUB_EXIT: "1",
    });
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.reason).toContain("broken");

    // exit 2 -> bad input.
    const badInput = await kit.verifyEvidenceChain(pubkey, {
      AGENTOS_VERIFIER_BIN: stub,
      DV1_STUB_EXIT: "2",
    });
    expect(badInput.ok).toBe(false);
    if (badInput.ok) return;
    expect(badInput.reason).toContain("bad");

    // Absent binary -> fail-closed (NEVER reported intact).
    const absent = await kit.verifyEvidenceChain(pubkey, {
      AGENTOS_VERIFIER_BIN: join(dir, "does-not-exist"),
    });
    expect(absent.ok).toBe(false);
  });

  it("(MOAT INVARIANT) bootstrap.ts imports NO Go and does NOT re-implement chain hashing in TS", () => {
    // INDEPENDENT VERIFIABILITY by construction: the kit DELEGATES chain verification to the released
    // verifier across a PROCESS boundary (spawn), and NEVER re-derives entry/checkpoint hashes in TS.
    const here = fileURLToPath(new URL(".", import.meta.url));
    const source = readFileSync(join(here, "bootstrap.ts"), "utf8");

    // No Go / kernel-internal imports (the verifier is consumed by spawn, not import).
    expect(source).not.toMatch(/from\s+["'][^"']*kernel\//);
    expect(source).not.toMatch(/\.go["']/);
    // No TS re-implementation of the chain hash recompute (those primitives live in the verifier).
    expect(source).not.toContain("computeEntryHash");
    expect(source).not.toContain("checkpointBytes");
    expect(source).not.toMatch(/createHash\(\s*["']sha256["']\s*\)/);
    // It DOES delegate across the process boundary.
    expect(source).toContain("spawnSync");
  });
});
