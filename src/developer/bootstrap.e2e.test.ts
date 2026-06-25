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
import type { AuditEvent, LogEntry } from "../audit/index.js";
import type { AgentContext } from "../iam/ids.js";
import { ReplayError } from "../orchestration/index.js";
// ALIGNMENT TARGET (test-only import; dep-cruiser excludes test files): the system's real
// plain-language timeline projection. DV3 proves forensic replay LINES UP with it 1:1.
import { buildTaskTimeline } from "../personal/timeline/index.js";
import { createDeveloperKit } from "./bootstrap.js";
import { type ForensicState, foldForensicState, projectWormToReplayEvents } from "./forensic.js";

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
    containment: "in-sandbox",
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

  it("(DV3 ALIGNMENT) replayFold(WORM).steps line up 1:1 with buildTaskTimeline(same entries)", async () => {
    // Build a REAL WORM by running several governed tools through the kit — the entries are genuine
    // commit-before-effect AuditEvents (the appender synthesizes them), so this is the system's true
    // history, not a hand-built fixture.
    const kit = createDeveloperKit();
    kit.authorTool(validManifest("dev:echo"));
    kit.authorTool({ ...validManifest("dev:build"), resourcePattern: "dev:build:*" });
    kit.authorTool({ ...validManifest("dev:deploy"), resourcePattern: "dev:deploy:*" });

    await kit.runTool(toolCall("dev:echo", { note: "one" }));
    await kit.runTool(toolCall("dev:build", { note: "two" }));
    await kit.runTool(toolCall("dev:deploy", { note: "three" }));

    const tl = kit.replayFold();
    expect(tl.steps.length).toBe(3);

    // Reconstruct the WORM LogEntry[] from the replay steps (buildTaskTimeline reads only .sequence +
    // .event). The SAME entries fed to both projections is the alignment premise.
    const entries: LogEntry[] = tl.steps.map((step) => ({
      sequence: step.sequence,
      event: step.event as AuditEvent,
      prevHash: `sha256:${"0".repeat(64)}`,
      entryHash: `sha256:${"1".repeat(64)}`,
    }));
    const timeline = buildTaskTimeline(entries);

    // 1:1 length.
    expect(timeline.length).toBe(tl.steps.length);

    // Per-index: SAME sequence, and the replay step's underlying AuditEvent action/resource matches
    // the AuditEvent buildTaskTimeline projected at that sequence.
    for (let i = 0; i < tl.steps.length; i++) {
      const step = tl.steps[i];
      const tev = timeline[i];
      expect(step).toBeDefined();
      expect(tev).toBeDefined();
      if (step === undefined || tev === undefined) continue;
      // Same per-index sequence (neither projection renumbers).
      expect(step.sequence).toBe(tev.sequence);
      const replayEvent = step.event as AuditEvent;
      // Genuine cross-check (NOT a same-object tautology): buildTaskTimeline is an INDEPENDENT projection
      // of the same WORM; its plain-language headline embeds `${action} ${resource}`. So asserting the
      // replay step's action+resource appear in buildTaskTimeline's headline at this sequence proves the
      // two projections agree on what happened — a dropped/reordered replay step breaks the per-index
      // sequence match above and this headline match.
      expect(tev.headline).toContain(replayEvent.action);
      expect(tev.headline).toContain(replayEvent.resource);
    }

    // The expected resource order, in WORM-append (sequence) order.
    expect(tl.steps.map((s) => (s.event as AuditEvent).resource)).toEqual([
      "dev:echo",
      "dev:build",
      "dev:deploy",
    ]);
    // NON-VACUITY: a mutation that DROPPED a replay step (length 2) or REORDERED them would break
    // the length/per-index/resource-order assertions above.
  });

  it("(DV3 ALIGNMENT non-vacuity) the REAL projectWormToReplayEvents aligns; a tampered projection breaks 1:1", async () => {
    const kit = createDeveloperKit();
    kit.authorTool(validManifest("dev:echo"));
    kit.authorTool({ ...validManifest("dev:build"), resourcePattern: "dev:build:*" });
    await kit.runTool(toolCall("dev:echo", { note: "one" }));
    await kit.runTool(toolCall("dev:build", { note: "two" }));

    // Reconstruct the kit's WORM LogEntry[] from the replay steps, then drive the PRODUCTION projection
    // helper over them (not a hand-rolled local map) — the SAME helper replayFold/forensicState use.
    const tl = kit.replayFold();
    const entries: LogEntry[] = tl.steps.map((step) => ({
      sequence: step.sequence,
      event: step.event as AuditEvent,
      prevHash: `sha256:${"0".repeat(64)}`,
      entryHash: `sha256:${"1".repeat(64)}`,
    }));
    const projected = projectWormToReplayEvents(entries);
    const timeline = buildTaskTimeline(entries);

    // The REAL helper output aligns 1:1 with buildTaskTimeline (length + per-index sequence/resource).
    expect(projected.length).toBe(timeline.length);
    for (let i = 0; i < projected.length; i++) {
      expect(projected[i]?.sequence).toBe(timeline[i]?.sequence);
      expect(timeline[i]?.headline).toContain((projected[i]?.event as AuditEvent).resource);
    }

    // A DROPPED step (a projection that lost an entry) no longer matches buildTaskTimeline's length.
    const dropped = projected.slice(0, -1);
    expect(dropped.length).not.toBe(timeline.length);

    // A REORDERED projection (per-index resource diverges from buildTaskTimeline) — proving the
    // per-index resource assertion above is load-bearing, not vacuous.
    const reordered = [...projected].reverse();
    const mismatch = reordered.some(
      (re, i) =>
        !(timeline[i]?.headline ?? "").includes((re.event as AuditEvent).resource) ||
        re.sequence !== timeline[i]?.sequence,
    );
    expect(mismatch).toBe(true);
  });

  it("(DV3 POINT-IN-TIME) forensicState(uptoSeq=k) reflects ONLY entries seq<=k; replayFold cut matches", async () => {
    const kit = createDeveloperKit();
    kit.authorTool(validManifest("dev:echo"));
    kit.authorTool({ ...validManifest("dev:build"), resourcePattern: "dev:build:*" });
    kit.authorTool({ ...validManifest("dev:deploy"), resourcePattern: "dev:deploy:*" });

    // Three governed runs -> WORM sequences 0,1,2.
    await kit.runTool(toolCall("dev:echo", { note: "one" }));
    await kit.runTool(toolCall("dev:build", { note: "two" }));
    await kit.runTool(toolCall("dev:deploy", { note: "three" }));

    // As-of-0: only the FIRST entry (dev:echo) is in view.
    const asOf0: ForensicState = kit.forensicState(0);
    expect(asOf0.eventCount).toBe(1);
    expect(asOf0.executed).toBe(1);
    expect(Object.keys(asOf0.byResource).sort()).toEqual(["dev:echo"]);
    expect(asOf0.byResource["dev:echo"]).toEqual({
      lastAction: "tool:invoke",
      lastResult: "success",
    });
    // replayFold cut at the same point holds 1 step.
    expect(kit.replayFold(0).steps.length).toBe(1);

    // As-of-1: the first TWO entries (dev:echo, dev:build).
    const asOf1 = kit.forensicState(1);
    expect(asOf1.eventCount).toBe(2);
    expect(Object.keys(asOf1.byResource).sort()).toEqual(["dev:build", "dev:echo"]);
    expect(kit.replayFold(1).steps.length).toBe(2);

    // As-of-2 (== head): all three.
    const asOf2 = kit.forensicState(2);
    expect(asOf2.eventCount).toBe(3);
    expect(Object.keys(asOf2.byResource).sort()).toEqual(["dev:build", "dev:deploy", "dev:echo"]);

    // Default (no uptoSeq) folds the WHOLE WORM (== as-of-head).
    expect(kit.forensicState()).toEqual(asOf2);

    // NON-VACUITY: a forensicState that IGNORED uptoSeq (always folded all) would make asOf0.eventCount
    // === 3, flipping the as-of-0 assertions RED.
  });

  it("(DV3 POINT-IN-TIME) an out-of-range uptoSeq -> ReplayError (same fail-closed as replayFold)", async () => {
    const kit = createDeveloperKit();
    kit.authorTool(validManifest("dev:echo"));
    await kit.runTool(toolCall("dev:echo", { note: "one" })); // WORM has only sequence 0.

    // uptoSeq beyond head -> the replayTimeline cut-point validation throws ReplayError; forensicState
    // reuses replayFold's validated steps so the SAME error propagates.
    expect(() => kit.forensicState(5)).toThrow(ReplayError);
    expect(() => kit.replayFold(5)).toThrow(ReplayError);

    // A non-integer cut-point also fails closed.
    expect(() => kit.forensicState(0.5)).toThrow(ReplayError);
  });

  it("(DV3) forensicState reuses the SAME projection helper; replayFold determinism still holds", async () => {
    const kit = createDeveloperKit();
    kit.authorTool(validManifest("dev:echo"));
    await kit.runTool(toolCall("dev:echo", { note: "one" }));

    // replayFold is still deterministic over the same WORM (same timelineHash) — DV1 invariant intact.
    expect(kit.replayFold().timelineHash).toBe(kit.replayFold().timelineHash);

    // The standalone projection helper, fed the steps' events, folds to the same forensic state the
    // kit reports (the kit's forensicState is the projection helper + foldForensicState over the WORM).
    const steps = kit.replayFold().steps;
    const events = steps.map((s) => ({ sequence: s.sequence, event: s.event }));
    expect(foldForensicState(events)).toEqual(kit.forensicState());

    // The projection helper is credential-blind: nothing in the forensic state is a literal secret.
    expect(JSON.stringify(kit.forensicState())).not.toContain("sk-");
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
