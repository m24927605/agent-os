/**
 * SLICE-EXEC-HARDENING (RED-first) — the CAP6 cross-cutting gap: `exec.run` with a KNOWN network binary
 * (curl/wget/nc/ssh/scp/ftp) and an UNVERIFIABLE target (no projectable host) is FAIL-CLOSED DENIED.
 *
 * THE GAP THIS CLOSES: `exec.run` (containment:"in-sandbox") can run any command — including a network
 * binary. A URL-shaped target (`curl https://evil.com/x`) is ALREADY gated by the CAP5/6 egress fold
 * (buildExecRunProjection extracts networkHosts=["evil.com"] -> the host fold denies a non-allowlisted
 * host). But a BARE-HOST target with NO scheme (`curl evil.com`) projects networkHosts=[] -> the egress
 * fold (which fires only for networkHosts.length > 0) does NOT trigger -> before this slice it relied
 * SOLELY on the substrate seal. This slice folds a PDP defense-in-depth DENY: a projection with
 * `operationClass === "network"` (the buildExecRunProjection bucket for NETWORK_CMDS) AND
 * `networkHosts.length === 0` (the target cannot be verified against the egress allowlist) => DENY.
 *
 * What this file pins (the new fold does NOT exist yet => RED):
 *  - exec.run {argv:["curl","evil.com"]} (no scheme => networkHosts [], operationClass network) => DENIED,
 *    substrate effect runs 0 times;
 *  - exec.run {argv:["wget","internal-host"]} => DENIED, effect 0 times;
 *  - exec.run {argv:["curl","https://api.allowed.example/x"]} + allowlist ['api.allowed.example']
 *    => NOT denied by THIS rule (networkHosts=["api.allowed.example"] => the egress fold ALLOWS it) =>
 *    the effect RUNS once (proves the new rule does NOT fire when a host IS projectable);
 *  - exec.run {argv:["echo","evil.com"]} (echo NOT in NETWORK_CMDS => operationClass "unknown", even
 *    though the arg CONTAINS a hostname-like string) => NOT affected => the effect RUNS;
 *  - exec.run {argv:["cat","f"]} (filesystem) => NOT affected => the effect RUNS.
 *
 * ⚠️ NON-VACUITY: a source mutation that REMOVES the new fold flips the `curl evil.com` test RED — it
 * should DENY but the effect would RUN (the bare-host network call slips past the PDP). Exercised +
 * reverted in the RED->GREEN drive.
 *
 * FAKE substrate (records argv; NO real network). The PDP fold is IN-REPO defense-in-depth that SHRINKS
 * the PDP's exec.run network blind spot for KNOWN network binaries with unverifiable targets; the
 * substrate seal (the sealed no-egress sandbox / OpenShell network policy) remains the PRIMARY no-egress
 * enforcement (a deploy fact). A non-NETWORK_CMDS custom binary or a shell-wrapped network call can still
 * evade the PDP — this is best-effort, NOT complete interception.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
} from "../../../../substrate/index.js";
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

/**
 * Drive ONE tools/call through the bin's REAL deps (Fake substrate + Fake kernel) over in-memory stdio.
 * exec.run is a default seed tool (the exec.** allow rule covers it), so no extraSeedTools/extraAllowRules
 * are needed. `egressAllow` is the per-sandbox allowlist (default empty = deny-all).
 */
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
// CORE — a KNOWN network binary (curl/wget) with NO projectable host (bare host, no scheme) is DENIED,
//   fail-closed, BEFORE the effect. This is the CAP6 cross-cutting gap this slice closes.
//   ⚠️ NON-VACUITY: removing the new fold makes `curl evil.com` PROCEED (effect runs) => this flips RED.
// ==================================================================================================
describe("EXEC-HARDENING — exec.run with a network binary + unverifiable target is FAIL-CLOSED denied", () => {
  it("exec.run {argv:['curl','evil.com']} (no scheme => networkHosts []) => DENIED, effect 0 times", async () => {
    // A non-empty allowlist — yet the bare host is not even projectable, so the egress allowlist cannot
    // help and the network-binary fail-closed rule denies (the target is unverifiable).
    const { result, spy } = await driveOneCall(
      { egressAllow: ["api.allowed.example"] },
      { name: "exec.run", arguments: { argv: ["curl", "evil.com"] } },
    );
    expect(result.isError).toBe(true);
    // The fold is part of authorize (the policy stage), BEFORE commit-before-effect.
    expect(result.content[0]?.text).toContain("policy");
    expect(spy.execCalls.length).toBe(0);
  });

  it("exec.run {argv:['wget','internal-host']} (no scheme => networkHosts []) => DENIED, effect 0 times", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: ["api.allowed.example"] },
      { name: "exec.run", arguments: { argv: ["wget", "internal-host"] } },
    );
    expect(result.isError).toBe(true);
    expect(spy.execCalls.length).toBe(0);
  });

  it("exec.run {argv:['ssh','some-host']} (no scheme => networkHosts []) => DENIED, effect 0 times", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: ["api.allowed.example"] },
      { name: "exec.run", arguments: { argv: ["ssh", "some-host"] } },
    );
    expect(result.isError).toBe(true);
    expect(spy.execCalls.length).toBe(0);
  });

  it("DENIES the bare-host network command even with the DEFAULT (empty) allowlist (deny-all stays)", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: [] },
      { name: "exec.run", arguments: { argv: ["curl", "evil.com"] } },
    );
    expect(result.isError).toBe(true);
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// NO FALSE-POSITIVE (networkHosts NON-empty) — a KNOWN network binary with a URL-shaped (PROJECTABLE)
//   target is NOT denied by the NEW rule: it carries networkHosts, so the EXISTING egress fold gates it
//   (allowlisted => pass). The effect runs once — proving the new rule keys on EMPTY networkHosts only.
// ==================================================================================================
describe("EXEC-HARDENING — a network binary with a PROJECTABLE (allowlisted) host is NOT denied by the new rule", () => {
  it("exec.run {argv:['curl','https://api.allowed.example/x']} + allowlist ['api.allowed.example'] => effect runs once", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: ["api.allowed.example"] },
      { name: "exec.run", arguments: { argv: ["curl", "https://api.allowed.example/x"] } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
    // The argv reached the substrate VERBATIM (exec.run runs the raw vector, no shell).
    expect(spy.execCalls[0]?.argv).toEqual(["curl", "https://api.allowed.example/x"]);
  });

  it("a PROJECTABLE host that is NOT allowlisted is still denied — by the EXISTING egress fold (not the new rule)", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: ["api.allowed.example"] },
      { name: "exec.run", arguments: { argv: ["curl", "https://evil.com/x"] } },
    );
    // Denied by the egress host fold (networkHosts=["evil.com"] not on the allowlist) — unchanged from CAP6.
    expect(result.isError).toBe(true);
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// NO FALSE-POSITIVE (non-network operationClass) — a NON-network command is NOT affected, even if an arg
//   merely CONTAINS a hostname-like string. echo/cat are not in NETWORK_CMDS => operationClass is not
//   "network" => the new rule never fires => byte-identical (the effect runs).
// ==================================================================================================
describe("EXEC-HARDENING — non-network commands are byte-identical (the new rule keys on operationClass network)", () => {
  it("exec.run {argv:['echo','evil.com']} (echo NOT a network binary, arg contains a host string) => effect runs", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: [] },
      { name: "exec.run", arguments: { argv: ["echo", "evil.com"] } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
    expect(spy.execCalls[0]?.argv).toEqual(["echo", "evil.com"]);
  });

  it("exec.run {argv:['cat','f']} (filesystem, no host) => effect runs", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: [] },
      { name: "exec.run", arguments: { argv: ["cat", "f"] } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
  });

  it("exec.echo (a read-only in-sandbox seed tool, no network) is byte-identical (effect runs, deny-all egress)", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: [] },
      { name: "exec.echo", arguments: { text: "hello" } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
  });
});
