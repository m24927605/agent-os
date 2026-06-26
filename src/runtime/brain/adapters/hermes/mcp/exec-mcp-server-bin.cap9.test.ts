/**
 * SLICE-CAP9 (RED-first) — the host-write-target PDP defense-in-depth layer is folded END-TO-END on the
 * AUTONOMOUS (bin) path. A precise PARALLEL to CAP5's egress fold.
 *
 * THE GAP THIS CLOSES: CAP9 builds the host-write-target PRIMITIVE (deny-all default). The substrate seal
 * (sandbox host-mount + kernel realpath) is the PRIMARY host-write enforcement (a deploy fact). This file
 * pins the IN-REPO, testable PDP defense-in-depth LAYER: the bin's authorize closure, for a tool whose
 * governanceProjection carries `writeTargets`, folds `hostWriteDecisionForProjection(writeTargets,
 * binHostWriteAllow)` into the decision alongside the PDP + egress + advisory secondaries (any-deny-wins).
 * The bin's `binHostWriteAllow` is config (default EMPTY = deny-all).
 *
 * NO REAL HOST-WRITE TOOL: the first real host-fs-write tool is a later slice. CAP9 proves the END-TO-END
 * MECHANISM with a SYNTHETIC tool whose `governanceProjector` emits `writeTargets` — it is
 * `containment:"in-sandbox"` so it rides the Fake substrate (no real host write is ever attempted), and the
 * projection's `writeTargets` exercises the PDP host-write fold WITHOUT a real host-write capability.
 *
 * What this file pins (the bin seams + closure host-write fold do not exist yet => RED):
 *  - SYNTHETIC tool with projection.writeTargets=["/etc/passwd"] + binHostWriteAllow=["/work"]
 *    => authorize DENY (host-write) => the effect runs 0 times (the fold is BEFORE the effect);
 *  - SYNTHETIC tool with projection.writeTargets=["/work/out.txt"] + same allowlist => NOT denied
 *    for host-write (the call proceeds; effect runs once);
 *  - the EXISTING bin tools (NO writeTargets) => the host-write check is NOT triggered => byte-identical
 *    (exec.echo executes even with an EMPTY binHostWriteAllow — deny-all never touches a no-target tool);
 *  - FAIL-CLOSED: a `containment:"host-fs-write"` tool with NO projectable writeTarget => DENIED (parallel
 *    to CAP6's network-egress fail-closed). So a host-fs-write tool can NEVER write with an unknown target.
 *
 * NON-VACUITY: a mutation where the bin's authorize closure does NOT fold the host-write decision flips the
 * /etc/passwd test RED — the call would NOT deny (the effect would run) even though "/etc/passwd" is not
 * under any allowed root.
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
// A SYNTHETIC host-write-shaped tool (the real host-fs-write tool is a later slice). It is
// `containment:"in-sandbox"` so it RIDES the Fake substrate (no real host write is ever attempted), but
// its `governanceProjector` emits a `writeTargets` projection so the PDP host-write fold is exercised. It
// is `sideEffect:"write"` so it is IN-SCOPE (effectful) for buildProjectionForCall.
// ==================================================================================================
function syntheticWriteManifest(): ToolManifest {
  return {
    name: "synthetic.hostwrite",
    version: "1.0.0",
    description:
      "a synthetic host-write-shaped tool (projects writeTargets) — proves the bin host-write fold",
    action: "tool:invoke",
    resourcePattern: "synthetic/hostwrite",
    sideEffect: "write",
    idempotent: false,
    requiresApproval: false,
    bundleRefOnly: false,
    containment: "in-sandbox",
  };
}

/**
 * Build the synthetic binding whose `governanceProjector` emits a projection carrying the given
 * `writeTargets`. echo-style argv so a reached effect runs visibly on the Fake substrate.
 */
function syntheticWriteBinding(writeTargets: readonly string[]): ExecToolBinding {
  return {
    argvPrefix: ["echo"],
    argSchema: z.object({ note: z.string() }).strict(),
    toArgv: (a) => [(a as { note: string }).note],
    governanceProjector: (_validated): GovernanceProjection => ({
      version: 1,
      operationClass: "filesystem",
      argv0: "echo",
      argc: 2,
      argvRedacted: ["echo", "note"],
      truncated: false,
      usesShellInterpreter: false,
      networkHosts: [],
      destructiveFlags: [],
      writeTargets: [...writeTargets],
    }),
  };
}

/** The allow rule that makes the synthetic tool PDP-authorizable (alongside the exec/git/net rules). */
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
// CAP9-DENY — a projected target NOT under the bin's host-write allowlist => authorize DENY (host-write)
//   => the effect runs 0 times. NON-VACUITY: a mutation that drops the host-write fold makes this call
//   PROCEED (the effect runs) — flipping this test RED.
// ==================================================================================================
describe("CAP9 — the bin DENIES a tool whose projected write target is not under an allowed root", () => {
  it("writeTargets=['/etc/passwd'] + binHostWriteAllow=['/work'] => DENIED, effect runs 0 times", async () => {
    const { result, spy } = await driveOneCall(
      {
        extraSeedTools: [
          {
            manifest: syntheticWriteManifest(),
            binding: syntheticWriteBinding(["/etc/passwd"]),
          },
        ],
        extraAllowRules: [ALLOW_SYNTHETIC],
        hostWriteAllow: ["/work"],
      },
      { name: "synthetic.hostwrite", arguments: { note: "hello" } },
    );
    expect(result.isError).toBe(true);
    // The host-write fold is part of authorize (the policy stage), BEFORE commit-before-effect.
    expect(spy.execCalls.length).toBe(0);
  });

  it("writeTargets=['/work/../etc/passwd'] (traversal) + binHostWriteAllow=['/work'] => DENIED", async () => {
    const { result, spy } = await driveOneCall(
      {
        extraSeedTools: [
          {
            manifest: syntheticWriteManifest(),
            binding: syntheticWriteBinding(["/work/../etc/passwd"]),
          },
        ],
        extraAllowRules: [ALLOW_SYNTHETIC],
        hostWriteAllow: ["/work"],
      },
      { name: "synthetic.hostwrite", arguments: { note: "hello" } },
    );
    expect(result.isError).toBe(true);
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// CAP9-ALLOW — every projected target IS under the bin's host-write allowlist => NOT denied for
//   host-write => the call proceeds and the effect runs once.
// ==================================================================================================
describe("CAP9 — the bin ALLOWS a tool whose projected write target is under an allowed root", () => {
  it("writeTargets=['/work/out.txt'] + binHostWriteAllow=['/work'] => NOT denied for host-write, effect runs once", async () => {
    const { result, spy } = await driveOneCall(
      {
        extraSeedTools: [
          {
            manifest: syntheticWriteManifest(),
            binding: syntheticWriteBinding(["/work/out.txt"]),
          },
        ],
        extraAllowRules: [ALLOW_SYNTHETIC],
        hostWriteAllow: ["/work"],
      },
      { name: "synthetic.hostwrite", arguments: { note: "hello" } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
  });
});

// ==================================================================================================
// CAP9-BYTE-IDENTICAL — the EXISTING bin tools have NO writeTargets => the host-write check is NOT
//   triggered => behavior UNCHANGED, even with an EMPTY (deny-all) binHostWriteAllow. exec.echo executes.
// ==================================================================================================
describe("CAP9 — tools with NO writeTargets skip the host-write check (byte-identical, deny-all default)", () => {
  it("exec.echo executes with an EMPTY (deny-all) hostWriteAllow (no writeTargets => never gates it)", async () => {
    const { result, spy } = await driveOneCall(
      { hostWriteAllow: [] },
      { name: "exec.echo", arguments: { text: "hello" } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
  });

  it("exec.echo executes with NO hostWriteAllow opt at all (env-default deny-all; no-target tool unaffected)", async () => {
    const { result, spy } = await driveOneCall(
      {},
      { name: "exec.echo", arguments: { text: "hello" } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
  });
});

// ==================================================================================================
// CAP9-FAIL-CLOSED — a `containment:"host-fs-write"` tool whose projection has NO writeTarget (a
//   broken/removed projector) is DENIED, NOT skipped (parallel to CAP6's network-egress fail-closed). So a
//   host-fs-write tool can NEVER write with an unknown target: the gate fail-closes. This is a HARD
//   non-vacuity that does NOT depend on the e2e target test — even a host-fs-write binding with NO
//   governanceProjector is denied.
// ==================================================================================================
describe("CAP9 — a host-fs-write tool with NO projectable write target is DENIED (fail-closed, not skipped)", () => {
  it("a host-fs-write manifest whose binding has NO projector => DENIED@policy, effect 0 times", async () => {
    // A synthetic host-fs-write tool whose binding declares NO governanceProjector (echo-style argv so a
    // reached effect would visibly run). With the fail-closed rule it must NOT reach the effect.
    const noProjectorWriteManifest: ToolManifest = {
      name: "synthetic.hostwritenoproj",
      version: "1.0.0",
      description: "a host-fs-write tool with NO projector (fail-closed test)",
      action: "tool:invoke",
      resourcePattern: "synthetic/hostwritenoproj",
      sideEffect: "write",
      idempotent: false,
      requiresApproval: false,
      bundleRefOnly: false,
      containment: "host-fs-write",
    };
    const noProjectorBinding: ExecToolBinding = {
      argvPrefix: ["echo"],
      argSchema: z.object({}).strict(),
      toArgv: () => ["hi"],
      // governanceProjector intentionally OMITTED.
    };
    const { result, spy } = await driveOneCall(
      {
        hostWriteAllow: ["/work"], // a non-empty allowlist — yet the target is unknown => deny
        extraSeedTools: [{ manifest: noProjectorWriteManifest, binding: noProjectorBinding }],
        extraAllowRules: [ALLOW_SYNTHETIC],
      },
      { name: "synthetic.hostwritenoproj", arguments: {} },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy");
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// CAP9-WIRED — the bin wires "host-write-target" into its registry's WIRED set (coupled: the bin now
//   enforces host-write, so a host-fs-write tool may REGISTER on it). A `containment:"host-fs-write"`
//   manifest registers on the bin WITHOUT throwing the REFUSE-to-register gate. (Before CAP9 the bin's
//   wired set was {"approval","egress-allowlist"} only, so this manifest would be refused at
//   registration => RED.)
// ==================================================================================================
describe("CAP9 — the bin wires 'host-write-target' into WIRED (a host-fs-write tool may register)", () => {
  it("a host-fs-write containment tool registers on the bin (no REFUSE-to-register throw)", async () => {
    const hostWriteManifest: ToolManifest = {
      name: "synthetic.fswrite",
      version: "1.0.0",
      description: "a synthetic host-fs-write tool — proves host-write-target is WIRED on the bin",
      action: "tool:invoke",
      resourcePattern: "synthetic/fswrite",
      sideEffect: "write",
      idempotent: false,
      requiresApproval: false,
      bundleRefOnly: false,
      containment: "host-fs-write",
    };
    const binding: ExecToolBinding = {
      argvPrefix: ["echo"],
      argSchema: z.object({ note: z.string() }).strict(),
      toArgv: (a) => [(a as { note: string }).note],
      governanceProjector: (_v): GovernanceProjection => ({
        version: 1,
        operationClass: "filesystem",
        argv0: "echo",
        argc: 2,
        argvRedacted: ["echo", "note"],
        truncated: false,
        usesShellInterpreter: false,
        networkHosts: [],
        destructiveFlags: [],
        writeTargets: ["/work/x"],
      }),
    };
    // buildBinDeps builds the registry via seedRegistry(binWired, ...). If "host-write-target" is NOT in
    // binWired, assertRegisterable THROWS for this host-fs-write manifest and buildBinDeps rejects.
    await expect(
      buildBinDeps(false, {
        ingestTransport: fakeKernelTransport(),
        substrate: new SpyFakeSandboxAdapter(),
        extraSeedTools: [{ manifest: hostWriteManifest, binding }],
        extraAllowRules: [ALLOW_SYNTHETIC],
      }),
    ).resolves.toBeDefined();
  });
});
