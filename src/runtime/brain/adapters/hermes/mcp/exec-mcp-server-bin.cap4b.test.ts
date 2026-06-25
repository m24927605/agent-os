/**
 * SLICE-CAP4b — the approval stage is wired END-TO-END on the AUTONOMOUS (bin) path.
 *
 * THE GAP THIS CLOSES: CAP4a built the fail-closed approval STAGE in `runGovernedToolCall`, but the BIN
 * (the path a real user actually takes: Hermes -> spawned bin -> `runGovernedToolCall`) never (a) set
 * `requiresApproval` on its AuthorizeDecision, (b) injected an `approve` seam, or (c) wired "approval"
 * into its registry — so a destructive (approval-requiring) tool could neither register NOR be gated.
 * CAP4b wires all three: the bin's authorize closure sets `requiresApproval` FROM THE MANIFEST
 * (`registry.lookup(tc.tool)?.requiresApproval ?? false`), the bin injects a budget approver, and the
 * bin builds its registry with `wired ⊇ {"approval"}` so a destructive tool can register there.
 *
 * REAL DESTRUCTIVE TOOL DEFERRED: git.push (the first real destructive+network tool) needs egress
 * (Slice 5) and is Slice 6. CAP4b proves the END-TO-END MECHANISM with a SYNTHETIC destructive seed tool
 * (sideEffect:"destructive", requiresApproval:true, containment:"in-sandbox") injected via a new
 * `BuildBinOpts` seam, plus an injected budget approver.
 *
 * What this file pins (RED-first; the bin seams + closure `requiresApproval` do not exist yet):
 *  - PRE-AUTHORIZED budget approver + the synthetic destructive tool => approval stage APPROVES => the
 *    effect RUNS (substrate executed once, isError:false);
 *  - NON-pre-authorized (deny-all) budget approver => `DENIED: approval` => the effect runs 0 times
 *    (cost/commit/effect all 0 — approval is BEFORE the effect);
 *  - the 14 EXISTING bin tools (requiresApproval:false) => the approval stage is SKIPPED => behavior
 *    UNCHANGED (exec.echo executes with NO approver consulted; byte-identical).
 *
 * NON-VACUITY: a mutation where the bin's authorize closure does NOT set `requiresApproval` (stays
 * false) bypasses the destructive tool's approval gate — it would EXECUTE without approval, flipping the
 * "NON-pre-authorized => denied@approval, effect 0" test RED (the effect would run).
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolManifest } from "../../../../../tools/index.js";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
} from "../../../../substrate/index.js";
import type { ExecToolBinding } from "../exec-closed-loop.js";
import { buildBinDeps } from "./exec-mcp-server-bin.js";
import { runExecMcpStdio } from "./exec-mcp-stdio.js";

// ==================================================================================================
// Test doubles.
// ==================================================================================================

/** A spying Fake substrate: counts exec calls so a test can assert the substrate ran 0 (or 1) times. */
class SpyFakeSandboxAdapter extends FakeSandboxAdapter {
  readonly execCalls: ExecCommandSpec[] = [];
  override createSandbox(ctx: unknown, spec: SandboxSpec): Promise<AdapterResult> {
    return super.createSandbox(ctx, spec);
  }
  override execSandbox(
    ctx: unknown,
    sandboxId: string,
    spec: ExecCommandSpec,
  ): Promise<ExecResult> {
    this.execCalls.push(spec);
    return super.execSandbox(ctx, sandboxId, spec);
  }
}

/** A FakeKernelTransport returning a well-formed receipt (so commit-before-effect treats it durable). */
function fakeKernelTransport(): import("../../../../../audit/index.js").AppendTransport {
  let sequence = 0;
  return {
    append() {
      sequence += 1;
      return Promise.resolve({
        receipt: {
          sequence,
          contentHash: `content-${sequence}`,
          prevHash: sequence === 1 ? "GENESIS" : `content-${sequence - 1}`,
          entryHash: `entry-${sequence}`,
        },
      });
    },
  };
}

// ==================================================================================================
// A SYNTHETIC destructive seed tool (the real destructive tool git.push is Slice 6). in-sandbox so it
// rides the Fake substrate; destructive => requiresApproval:true (manifest schema FORCES it). The
// binding echoes its argv (FakeSandboxAdapter default), so a reached effect runs visibly.
// ==================================================================================================
const destructiveManifest: ToolManifest = {
  name: "synthetic.destructive",
  version: "1.0.0",
  description: "a synthetic destructive tool (requires approval) — proves the bin approval wiring",
  action: "tool:invoke",
  resourcePattern: "synthetic/destructive",
  sideEffect: "destructive",
  idempotent: false,
  requiresApproval: true,
  bundleRefOnly: false,
  containment: "in-sandbox",
};

/** echo-style binding so the effect, when REACHED, runs an argv the Fake substrate echoes back. */
const destructiveBinding: ExecToolBinding = {
  argvPrefix: ["echo"],
  argSchema: z.object({ note: z.string() }).strict(),
  toArgv: (a) => [(a as { note: string }).note],
};

/** The allow rule that makes the synthetic destructive tool PDP-authorizable (alongside the exec/git rules). */
const ALLOW_SYNTHETIC = {
  id: "allow-synthetic",
  action: "tool:invoke",
  resource: "synthetic.**",
  tenantId: "tenant-bin",
};

// ==================================================================================================
// Driver: run ONE tools/call through the bin's REAL deps (Fake substrate + Fake kernel) over in-memory
// stdio, returning the MCP result + the spy substrate.
// ==================================================================================================
async function driveOneCall(
  opts: Parameters<typeof buildBinDeps>[1],
  toolCall: { name: string; arguments: Record<string, unknown> },
): Promise<{
  result: { isError: boolean; content: { text: string }[] };
  spy: SpyFakeSandboxAdapter;
}> {
  const spy = new SpyFakeSandboxAdapter();
  const { deps } = await buildBinDeps(false, {
    ingestTransport: fakeKernelTransport(),
    substrate: spy,
    ...opts,
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  const done = runExecMcpStdio(deps, { input, output });
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: toolCall })}\n`,
  );
  input.end();
  await done;
  const responses = Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const result = responses[0]?.result as { isError: boolean; content: { text: string }[] };
  return { result, spy };
}

// ==================================================================================================
// CAP4b-APPROVED — a PRE-AUTHORIZED budget approver approves the synthetic destructive tool => the
//   approval stage passes => the effect RUNS (substrate executed once, isError:false).
// ==================================================================================================
describe("CAP4b — the bin gates a destructive tool through the approval stage (PRE-AUTHORIZED => approved)", () => {
  it("pre-authorized budget approver => the destructive tool's approval stage APPROVES => effect runs", async () => {
    const { result, spy } = await driveOneCall(
      {
        extraSeedTools: [{ manifest: destructiveManifest, binding: destructiveBinding }],
        extraAllowRules: [ALLOW_SYNTHETIC],
        approve: () => ({ status: "approved", reason: "pre-authorized (test)" }),
      },
      { name: "synthetic.destructive", arguments: { note: "hello" } },
    );
    expect(result.isError).toBe(false);
    // The effect RAN exactly once (approval passed before commit-before-effect -> effect).
    expect(spy.execCalls.length).toBe(1);
  });
});

// ==================================================================================================
// CAP4b-DENIED — a NON-pre-authorized (deny-all) budget approver denies the synthetic destructive tool
//   at the APPROVAL stage => the effect runs 0 times. NON-VACUITY: a mutation where the bin closure does
//   NOT set `requiresApproval` (stays false) bypasses the approval gate — the effect would RUN (flips RED).
// ==================================================================================================
describe("CAP4b — the bin DENIES a destructive tool at the approval stage (NON-pre-authorized => effect 0)", () => {
  it("non-pre-authorized (deny-all) budget approver => DENIED: approval, the effect runs 0 times", async () => {
    const { result, spy } = await driveOneCall(
      {
        extraSeedTools: [{ manifest: destructiveManifest, binding: destructiveBinding }],
        extraAllowRules: [ALLOW_SYNTHETIC],
        approve: () => ({ status: "denied", reason: "not pre-authorized (deny-by-default)" }),
      },
      { name: "synthetic.destructive", arguments: { note: "hello" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DENIED: approval");
    // The effect NEVER ran — approval is BEFORE commit-before-effect (the substrate is untouched).
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// CAP4b-BYTE-IDENTICAL — the 14 EXISTING bin tools are requiresApproval:false => the approval stage is
//   SKIPPED => behavior UNCHANGED. exec.echo executes even with a deny-all approver injected (it is never
//   consulted for a requiresApproval:false tool). Proves the 14 tools are byte-identical.
// ==================================================================================================
describe("CAP4b — the 14 existing bin tools (requiresApproval:false) skip the approval stage (byte-identical)", () => {
  it("exec.echo executes even with a DENY-ALL approver injected (the stage is skipped for requiresApproval:false)", async () => {
    const { result, spy } = await driveOneCall(
      {
        // A deny-all approver is present, but exec.echo (requiresApproval:false) must NEVER consult it.
        approve: () => ({
          status: "denied",
          reason: "deny-all (must not be consulted for read tools)",
        }),
      },
      { name: "exec.echo", arguments: { text: "hello" } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
  });
});
