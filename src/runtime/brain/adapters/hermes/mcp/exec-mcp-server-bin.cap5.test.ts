/**
 * SLICE-CAP5 (RED-first) — the egress-allowlist PDP defense-in-depth layer is folded END-TO-END on the
 * AUTONOMOUS (bin) path.
 *
 * THE GAP THIS CLOSES: CAP5 builds the egress-allowlist PRIMITIVE (deny-all default). The substrate seal
 * (OpenShell network policy) is the PRIMARY no-egress enforcement (a deploy fact). This file pins the
 * IN-REPO, testable PDP defense-in-depth LAYER: the bin's authorize closure, for a tool whose
 * governanceProjection carries `networkHosts`, folds `egressDecisionForProjection(networkHosts,
 * binEgressAllow)` into the decision alongside the PDP + advisory secondaries (any-deny-wins). The bin's
 * `binEgressAllow` is config (default EMPTY = deny-all).
 *
 * NO REAL NETWORK TOOL: git.push / net.fetch (the first real network-egress tools) are CAP6. CAP5 proves
 * the END-TO-END MECHANISM with a SYNTHETIC tool whose `governanceProjector` emits `networkHosts` — it is
 * `containment:"in-sandbox"` so it rides the Fake substrate (no real egress is ever attempted), and the
 * projection's `networkHosts` exercises the PDP egress fold WITHOUT a real network capability.
 *
 * What this file pins (the bin seams + closure egress fold do not exist yet => RED):
 *  - SYNTHETIC tool with projection.networkHosts=["evil.com"] + binEgressAllow=["api.allowed.example"]
 *    => authorize DENY (egress) => the effect runs 0 times (the egress fold is BEFORE the effect);
 *  - SYNTHETIC tool with projection.networkHosts=["api.allowed.example"] + same allowlist => NOT denied
 *    for egress (the call proceeds; effect runs once);
 *  - the 14 EXISTING bin tools (NO networkHosts) => the egress check is NOT triggered => byte-identical
 *    (exec.echo executes even with an EMPTY binEgressAllow — deny-all egress never touches a no-host tool).
 *
 * NON-VACUITY: a mutation where the bin's authorize closure does NOT fold the egress decision flips the
 * evil-host test RED — the call would NOT deny (the effect would run) even though "evil.com" is not on
 * the allowlist.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { GovernanceProjection } from "../../../../../policy/index.js";
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
// A SYNTHETIC network-shaped tool (the real network tool net.fetch/git.push is CAP6). It is
// `containment:"in-sandbox"` so it RIDES the Fake substrate (no real egress is ever attempted), but its
// `governanceProjector` emits a `networkHosts` projection so the PDP egress fold is exercised. It is
// `sideEffect:"write"` so it is IN-SCOPE (effectful) for buildProjectionForCall.
// ==================================================================================================
function syntheticNetworkManifest(): ToolManifest {
  return {
    name: "synthetic.net",
    version: "1.0.0",
    description:
      "a synthetic network-shaped tool (projects networkHosts) — proves the bin egress fold",
    action: "tool:invoke",
    resourcePattern: "synthetic/net",
    sideEffect: "write",
    idempotent: false,
    requiresApproval: false,
    bundleRefOnly: false,
    containment: "in-sandbox",
  };
}

/**
 * Build the synthetic binding whose `governanceProjector` emits a projection carrying the given
 * `networkHosts`. echo-style argv so a reached effect runs visibly on the Fake substrate.
 */
function syntheticNetworkBinding(networkHosts: readonly string[]): ExecToolBinding {
  return {
    argvPrefix: ["echo"],
    argSchema: z.object({ note: z.string() }).strict(),
    toArgv: (a) => [(a as { note: string }).note],
    governanceProjector: (_validated): GovernanceProjection => ({
      version: 1,
      operationClass: "network",
      argv0: "echo",
      argc: 2,
      argvRedacted: ["echo", "note"],
      truncated: false,
      usesShellInterpreter: false,
      networkHosts: [...networkHosts],
      destructiveFlags: [],
    }),
  };
}

/** The allow rule that makes the synthetic tool PDP-authorizable (alongside the exec/git rules). */
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
// CAP5-DENY — a projected host NOT on the bin's egress allowlist => authorize DENY (egress) => the
//   effect runs 0 times. NON-VACUITY: a mutation that drops the egress fold makes this call PROCEED
//   (the effect runs) — flipping this test RED.
// ==================================================================================================
describe("CAP5 — the bin DENIES a tool whose projected egress host is not on the allowlist", () => {
  it("networkHosts=['evil.com'] + binEgressAllow=['api.allowed.example'] => DENIED, effect runs 0 times", async () => {
    const { result, spy } = await driveOneCall(
      {
        extraSeedTools: [
          {
            manifest: syntheticNetworkManifest(),
            binding: syntheticNetworkBinding(["evil.com"]),
          },
        ],
        extraAllowRules: [ALLOW_SYNTHETIC],
        egressAllow: ["api.allowed.example"],
      },
      { name: "synthetic.net", arguments: { note: "hello" } },
    );
    expect(result.isError).toBe(true);
    // The egress fold is part of authorize (the policy stage), BEFORE commit-before-effect.
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// CAP5-ALLOW — every projected host IS on the bin's egress allowlist => NOT denied for egress => the
//   call proceeds and the effect runs once.
// ==================================================================================================
describe("CAP5 — the bin ALLOWS a tool whose projected egress host is on the allowlist", () => {
  it("networkHosts=['api.allowed.example'] + same allowlist => NOT denied for egress, effect runs once", async () => {
    const { result, spy } = await driveOneCall(
      {
        extraSeedTools: [
          {
            manifest: syntheticNetworkManifest(),
            binding: syntheticNetworkBinding(["api.allowed.example"]),
          },
        ],
        extraAllowRules: [ALLOW_SYNTHETIC],
        egressAllow: ["api.allowed.example"],
      },
      { name: "synthetic.net", arguments: { note: "hello" } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
  });
});

// ==================================================================================================
// CAP5-BYTE-IDENTICAL — the 14 EXISTING bin tools have NO networkHosts => the egress check is NOT
//   triggered => behavior UNCHANGED, even with an EMPTY (deny-all) binEgressAllow. exec.echo executes.
// ==================================================================================================
describe("CAP5 — tools with NO networkHosts skip the egress check (byte-identical, deny-all egress default)", () => {
  it("exec.echo executes with an EMPTY (deny-all) egressAllow (no networkHosts => egress never gates it)", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: [] },
      { name: "exec.echo", arguments: { text: "hello" } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
  });

  it("exec.echo executes with NO egressAllow opt at all (env-default deny-all; no-host tool unaffected)", async () => {
    const { result, spy } = await driveOneCall(
      {},
      { name: "exec.echo", arguments: { text: "hello" } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
  });
});

// ==================================================================================================
// CAP5-WIRED — the bin wires "egress-allowlist" into its registry's WIRED set (coupled: the bin now
//   enforces egress, so a network-egress tool may REGISTER on it). A `containment:"network-egress"`
//   manifest registers on the bin WITHOUT throwing the REFUSE-to-register gate. (Before CAP5 the bin's
//   wired set was {"approval"} only, so this manifest would be refused at registration => RED.)
// ==================================================================================================
describe("CAP5 — the bin wires 'egress-allowlist' into WIRED (a network-egress tool may register)", () => {
  it("a network-egress containment tool registers on the bin (no REFUSE-to-register throw)", async () => {
    const networkEgressManifest: ToolManifest = {
      name: "synthetic.egress",
      version: "1.0.0",
      description: "a synthetic network-egress tool — proves egress-allowlist is WIRED on the bin",
      action: "tool:invoke",
      resourcePattern: "synthetic/egress",
      sideEffect: "read",
      idempotent: true,
      requiresApproval: false,
      bundleRefOnly: false,
      containment: "network-egress",
    };
    const binding: ExecToolBinding = {
      argvPrefix: ["echo"],
      argSchema: z.object({ note: z.string() }).strict(),
      toArgv: (a) => [(a as { note: string }).note],
    };
    // buildBinDeps builds the registry via seedRegistry(binWired, ...). If "egress-allowlist" is NOT in
    // binWired, assertRegisterable THROWS for this network-egress manifest and buildBinDeps rejects.
    await expect(
      buildBinDeps(false, {
        ingestTransport: fakeKernelTransport(),
        substrate: new SpyFakeSandboxAdapter(),
        extraSeedTools: [{ manifest: networkEgressManifest, binding }],
        extraAllowRules: [ALLOW_SYNTHETIC],
      }),
    ).resolves.toBeDefined();
  });
});
