/**
 * SLICE-CAP6 (RED-first) — the bin's CAP5 egress fold GATES the REAL `net.fetch` tool END-TO-END.
 *
 * CAP5 proved the egress fold END-TO-END with a SYNTHETIC in-sandbox tool whose `governanceProjector`
 * emitted `networkHosts`. CAP6 ships the FIRST REAL network-egress tool — `net.fetch`
 * (`curl -sS -- <url>`) — and pins that the SAME egress fold REALLY gates it in-repo:
 *
 *  - net.fetch -> https://api.allowed.example/x with binEgressAllow=["api.allowed.example"]
 *      => NOT denied for egress (the call proceeds; the effect runs once; argv built from the binding);
 *  - net.fetch -> https://evil.com/x with the SAME allowlist
 *      => DENIED@policy (the egress fold; "evil.com" not on the allowlist); the effect runs 0 times;
 *  - net.fetch -> ANY url with the DEFAULT (empty) allowlist
 *      => deny-all egress => DENIED; the effect runs 0 times.
 *
 * net.fetch is a DEFAULT seed tool now (its required "egress-allowlist" primitive is wired on the bin),
 * so it registers + advertises + is authorizable on the bin WITHOUT any test injection. The bin carries a
 * permanent "net" allow rule (alongside the exec + git allow rules).
 *
 * NON-VACUITY: a mutation that removes net.fetch's `governanceProjector` (so the call carries NO
 * networkHosts) makes the evil-host call PROCEED (the effect runs) — the egress fold can no longer gate it
 * — flipping the evil-host test RED. This file injects that mutation explicitly (via a binding override)
 * to PROVE the projector is load-bearing for the egress gate.
 *
 * FAKE substrate (records argv + env; NO real network). The egress GATING is in-repo (the PDP
 * networkHosts fold); the real network reach + the SecretResolver-at-egress credential resolution are
 * deploy/EXEC2-gated.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildExecRunProjection } from "../../../../../policy/index.js";
import type { Primitive } from "../../../../../tools/index.js";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
} from "../../../../substrate/index.js";
import type { ExecToolBinding } from "../exec-closed-loop.js";
import {
  NET_FETCH_ARGV_PREFIX,
  netFetchBinding,
  seedBindings,
  seedRegistry,
} from "../exec-seed-tools.js";
import { buildProjectionForCall } from "../governance-projection-for-call.js";
import { buildBinDeps } from "./exec-mcp-server-bin.js";
import { runExecMcpStdio } from "./exec-mcp-stdio.js";

/** The egress-wired set the BIN uses (so seedRegistry/seedBindings carry net.fetch, as on the bin). */
const EGRESS_WIRED: ReadonlySet<Primitive> = new Set<Primitive>(["egress-allowlist"]);

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
 * net.fetch is a default seed tool, so no extraSeedTools/extraAllowRules are needed (the bin carries the
 * net.** allow rule). `egressAllow` is the per-sandbox allowlist (default empty = deny-all).
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
// CAP6-ADVERTISE — the BIN advertises net.fetch (the FIRST network-egress tool), because the bin is the
//   composition that WIRES "egress-allowlist" + ENFORCES the egress fold. A composition that has NOT wired
//   egress (the default loopback/stdio/server kits) does not advertise net.fetch — "a WIRED primitive ⟺
//   enforcement present" stays honest. SLICE-CAP6b: the bin now ALSO advertises git.push (the FIRST
//   destructive tool — egress + approval BOTH wired), so the bin set is 16 (the exact set is asserted in
//   the sibling exec-mcp-server-bin.cap6b.test.ts).
// ==================================================================================================
describe("CAP6 — the bin advertises net.fetch (the FIRST network-egress tool)", () => {
  it("tools/list on the bin includes net.fetch (and git.push, the CAP6b destructive tool)", async () => {
    const spy = new SpyFakeSandboxAdapter();
    const { deps } = await buildBinDeps(false, {
      ingestTransport: fakeKernelTransport(),
      substrate: spy,
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    const done = runExecMcpStdio(deps, { input, output });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
    input.end();
    await done;
    const responses = Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const tools = (responses[0]?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "exec.cat",
      "exec.echo",
      "exec.grep",
      "exec.head",
      "exec.ls",
      "exec.pwd",
      "exec.run",
      "exec.wc",
      "exec.write_file",
      "git.add",
      "git.commit",
      "git.diff",
      "git.log",
      "git.push",
      "git.status",
      "net.fetch",
    ]);
    // CAP6: net.fetch is advertised; CAP6b: git.push (the first destructive tool) is advertised too.
    expect(tools.map((t) => t.name)).toContain("net.fetch");
    expect(tools.map((t) => t.name)).toContain("git.push");
  });
});

// ==================================================================================================
// CAP6-ALLOW — the projected host IS on the bin's egress allowlist => NOT denied for egress => the call
//   proceeds; the effect runs once; the argv was built from the net.fetch binding (curl -sS -- <url>).
// ==================================================================================================
describe("CAP6 — the bin ALLOWS net.fetch to an allowlisted host (the egress fold passes a real tool)", () => {
  it("net.fetch https://api.allowed.example/x + allowlist ['api.allowed.example'] => effect runs once", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: ["api.allowed.example"] },
      { name: "net.fetch", arguments: { url: "https://api.allowed.example/x" } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
    // The argv reached the substrate built FROM THE BINDING — config/proxy-disabled curl + `--` + <url>.
    expect(spy.execCalls[0]?.argv).toEqual([
      ...NET_FETCH_ARGV_PREFIX,
      "https://api.allowed.example/x",
    ]);
  });

  it("net.fetch to an allowlisted host on an EXPLICIT PORT passes (host-based allowlist, no host:port)", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: ["api.allowed.example"] }, // a HOST entry — no port
      { name: "net.fetch", arguments: { url: "https://api.allowed.example:8443/x" } },
    );
    // The projector emits the BARE host, so the host-only allowlist matches the ported URL.
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
    expect(spy.execCalls[0]?.argv).toEqual([
      ...NET_FETCH_ARGV_PREFIX,
      "https://api.allowed.example:8443/x",
    ]);
  });
});

// ==================================================================================================
// CAP6-DENY — the projected host is NOT on the bin's egress allowlist => DENIED@policy (the egress fold)
//   => the effect runs 0 times. This is the CORE in-repo proof that CAP5's egress primitive GATES a REAL
//   network tool.
// ==================================================================================================
describe("CAP6 — the bin DENIES net.fetch to a non-allowlisted host (egress fold gates the REAL tool)", () => {
  it("net.fetch https://evil.com/x + allowlist ['api.allowed.example'] => DENIED@policy, effect 0 times", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: ["api.allowed.example"] },
      { name: "net.fetch", arguments: { url: "https://evil.com/x" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy");
    // The egress fold is part of authorize (the policy stage), BEFORE commit-before-effect.
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// CAP6-EGRESS-FOLD-IS-GENERAL — the egress fold gates EVERY projectable network host, not just net.fetch.
//   The general `exec.run` tool ALSO declares a governanceProjector (buildExecRunProjection), so
//   `exec.run {argv:["curl","https://evil.com/x"]}` projects networkHosts=["evil.com"] and is DENIED by the
//   SAME fold — proving an agent cannot trivially route around net.fetch via exec.run for a projectable
//   URL. HONEST BOUNDARY (the deploy fact, per the spec): a NON-projectable form (e.g. `curl evil.com`
//   with no scheme, where extractHost yields nothing) is NOT caught by the PDP fold — it relies on the
//   PRIMARY substrate seal (the sealed no-egress sandbox / OpenShell network policy, now also carried via
//   SandboxSpec.egressAllow). The PDP fold is in-repo defense-in-depth, NOT the sole enforcement.
// ==================================================================================================
describe("CAP6 — the egress fold gates ANY projectable host (exec.run curl to evil host is denied too)", () => {
  it("exec.run {argv:['curl','https://evil.com/x']} + allowlist ['api.allowed.example'] => DENIED, effect 0", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: ["api.allowed.example"] },
      { name: "exec.run", arguments: { argv: ["curl", "https://evil.com/x"] } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy");
    expect(spy.execCalls.length).toBe(0);
  });

  it("exec.run {argv:['curl','https://api.allowed.example/x']} + same allowlist => allowed, effect runs", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: ["api.allowed.example"] },
      { name: "exec.run", arguments: { argv: ["curl", "https://api.allowed.example/x"] } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
  });
});

// ==================================================================================================
// CAP6-DEFAULT-DENY-ALL — the DEFAULT (empty) egress allowlist => deny-all egress => net.fetch to ANY url
//   is denied; the effect runs 0 times.
// ==================================================================================================
describe("CAP6 — the bin DENY-ALLs net.fetch under the default (empty) egress allowlist", () => {
  it("net.fetch to an otherwise-fine host is DENIED with the DEFAULT empty allowlist (deny-all)", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: [] },
      { name: "net.fetch", arguments: { url: "https://api.allowed.example/x" } },
    );
    expect(result.isError).toBe(true);
    expect(spy.execCalls.length).toBe(0);
  });

  it("net.fetch with NO egressAllow opt at all (env-default deny-all) is DENIED", async () => {
    const KEY = "AGENTOS_EGRESS_ALLOW";
    const prev = process.env[KEY];
    try {
      delete process.env[KEY];
      const { result, spy } = await driveOneCall(
        {},
        { name: "net.fetch", arguments: { url: "https://api.allowed.example/x" } },
      );
      expect(result.isError).toBe(true);
      expect(spy.execCalls.length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  });
});

// ==================================================================================================
// CAP6-FAIL-CLOSED — a `containment:"network-egress"` tool whose projection has NO host (a broken/removed
//   projector, an unparseable URL) is DENIED, NOT skipped. So a network-egress tool can NEVER egress with
//   an unknown destination: the gate fail-closes. This is a HARD non-vacuity that does NOT depend on the
//   e2e host test — even a network-egress binding with NO governanceProjector is denied.
// ==================================================================================================
describe("CAP6 — a network-egress tool with NO projectable host is DENIED (fail-closed, not skipped)", () => {
  it("a network-egress manifest whose binding has NO projector => DENIED@policy, effect 0 times", async () => {
    // A synthetic network-egress tool whose binding declares NO governanceProjector (echo-style argv so a
    // reached effect would visibly run). With the fail-closed rule it must NOT reach the effect.
    const noProjectorNetManifest = {
      name: "synthetic.egressnoproj",
      version: "1.0.0",
      description: "a network-egress tool with NO projector (fail-closed test)",
      action: "tool:invoke",
      resourcePattern: "synthetic/egressnoproj",
      sideEffect: "read" as const,
      idempotent: false,
      requiresApproval: false,
      bundleRefOnly: false,
      containment: "network-egress" as const,
    };
    const noProjectorBinding: ExecToolBinding = {
      argvPrefix: ["echo"],
      argSchema: z.object({}).strict(),
      toArgv: () => ["hi"],
      // governanceProjector intentionally OMITTED.
    };
    const { result, spy } = await driveOneCall(
      {
        egressAllow: ["api.allowed.example"], // a non-empty allowlist — yet the host is unknown => deny
        extraSeedTools: [{ manifest: noProjectorNetManifest, binding: noProjectorBinding }],
        extraAllowRules: [
          {
            id: "allow-synth",
            action: "tool:invoke",
            resource: "synthetic.**",
            tenantId: "tenant-bin",
          },
        ],
      },
      { name: "synthetic.egressnoproj", arguments: {} },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy");
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// CAP6-NON-VACUITY (structural) — the egress gate's INPUT is net.fetch's projector. A net.fetch binding
//   WITHOUT a projector yields NO projection (buildProjectionForCall === undefined) => the bin egress fold
//   (`projection !== undefined && projection.networkHosts.length > 0`) gets NOTHING to gate on, so the
//   evil-host call would PROCEED. The REAL net.fetch binding DOES carry the projector, so the SAME evil
//   host yields networkHosts=["evil.com"] — the gate input that the CAP6-DENY test above turns into a
//   denial. Together these PIN that the projector is load-bearing for the egress gate.
//
//   A source-level twin (physically delete net.fetch's `governanceProjector` in exec-seed-tools.ts) flips
//   the CAP6-DENY evil-host test from DENIED to RUNS — exercised + reverted in the RED→GREEN drive.
// ==================================================================================================
describe("CAP6 — NON-VACUITY: net.fetch's projector is the egress gate's load-bearing input", () => {
  it("WITH the projector the evil host yields networkHosts=['evil.com']; WITHOUT a projector => no projection", () => {
    // net.fetch is registered/bound ONLY in an egress-wired composition (the bin) — build the kit WITH
    // egress wired (mirrors the bin).
    const registry = seedRegistry(EGRESS_WIRED);
    const bindings = seedBindings(new Map(), EGRESS_WIRED);
    const lookup = (n: string) => registry.lookup(n);

    // WITH the real projector: the evil host is projected (the gate input the CAP6-DENY test denies on).
    const withProjector = buildProjectionForCall(
      { tool: "net.fetch", args: { url: "https://evil.com/x" } },
      bindings,
      lookup,
      "effectful",
    );
    expect(withProjector?.networkHosts).toEqual(["evil.com"]);

    // WITHOUT a projector: the SAME call yields NO projection (the egress fold has nothing to gate on).
    const noProjectorBinding: ExecToolBinding = {
      argvPrefix: netFetchBinding.argvPrefix,
      argSchema: netFetchBinding.argSchema,
      toArgv: netFetchBinding.toArgv,
      ...(netFetchBinding.toEnv !== undefined ? { toEnv: netFetchBinding.toEnv } : {}),
      // governanceProjector intentionally OMITTED (the mutation).
    };
    const mutated = new Map(bindings);
    mutated.set("net.fetch", noProjectorBinding);
    const withoutProjector = buildProjectionForCall(
      { tool: "net.fetch", args: { url: "https://evil.com/x" } },
      mutated,
      lookup,
      "effectful",
    );
    expect(withoutProjector).toBeUndefined();

    // The canonical builder agrees the host is "evil.com" (single source of truth for the gate input).
    expect(
      buildExecRunProjection({ argv: [...NET_FETCH_ARGV_PREFIX, "https://evil.com/x"] })
        .networkHosts,
    ).toEqual(["evil.com"]);
  });
});
