/**
 * SLICE-CAP6b (RED-first) — the bin runs the FIRST REAL DESTRUCTIVE tool `git.push` END-TO-END through the
 * FULL seal-punch governance chain: screen -> authorize (PDP + egress fold) -> approval (CAP4) ->
 * commit-before-effect -> effect -> boundary event (CAP7).
 *
 * CAP4b proved the approval STAGE with a SYNTHETIC destructive tool; CAP6 proved the egress fold with the
 * REAL net.fetch (a network READ). CAP6b is the FIRST tool that is BOTH destructive (=> approval-gated) AND
 * network-egress (=> egress-gated), so it is the FIRST place ALL of approval + egress + boundary +
 * credential-placeholder run together on a REGISTERED REAL tool:
 *
 *  - git.push -> allowlisted host + PRE-AUTHORIZED approver
 *      => approved => the effect runs once + a boundary event (intent + boundary = 2 appends);
 *  - git.push -> allowlisted host + NON-pre-authorized approver
 *      => DENIED@approval => the effect runs 0 times + NO boundary;
 *  - git.push -> NON-allowlisted host (even pre-authorized)
 *      => DENIED@policy (egress fold, BEFORE approval) => the effect runs 0 times + NO boundary;
 *  - git.push under the DEFAULT (empty) egress allowlist => deny-all egress => DENIED, effect 0.
 *
 * git.push is a DEFAULT seed tool on the bin now (its required primitives — "approval" + "egress-allowlist"
 * — are BOTH wired on the bin), so it registers + advertises + is authorizable on the bin WITHOUT any test
 * injection. The bin already carries the `git.**` allow rule (CAP2) which covers git.push; the bin's
 * authorize closure already sets requiresApproval (CAP4b) + external (CAP7) + the egress fold (CAP5/6) from
 * the manifest/containment/projection — so NO bin closure change is needed.
 *
 * The bin advertises 16 tools now (15 + git.push).
 *
 * FAKE substrate (records argv + env; NO real git, NO real network, NO real push). The approval + egress
 * GATING + boundary record + credential placeholder are REAL in-repo; the real push reaching a remote + the
 * SecretResolver-at-egress credential resolution are deploy/EXEC2-gated.
 */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppendTransport } from "../../../../../audit/index.js";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
} from "../../../../substrate/index.js";
import { buildBinDeps } from "./exec-mcp-server-bin.js";
import { runExecMcpStdio } from "./exec-mcp-stdio.js";

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

/**
 * A counting kernel transport: a well-formed receipt per append (so commit-before-effect treats it durable)
 * AND it captures the canonical bytes of EVERY append (the intent + any boundary), so a test can count them
 * and assert the boundary action string appears (or not) — and that NO argvRedacted / url leaks.
 */
function countingKernelTransport(): { transport: AppendTransport; appends: string[] } {
  const appends: string[] = [];
  let sequence = 0;
  return {
    appends,
    transport: {
      append(req: { canonicalEvent: Uint8Array }) {
        appends.push(new TextDecoder().decode(req.canonicalEvent));
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
    },
  };
}

/** Drive ONE tools/call through the bin's REAL deps over in-memory stdio; return result + append log + spy. */
async function driveOneCall(
  opts: Parameters<typeof buildBinDeps>[1],
  toolCall: { name: string; arguments: Record<string, unknown> },
): Promise<{
  result: { isError: boolean; content: { text: string }[] };
  appends: string[];
  spy: SpyFakeSandboxAdapter;
}> {
  const spy = new SpyFakeSandboxAdapter();
  const { transport, appends } = countingKernelTransport();
  const { deps } = await buildBinDeps(false, {
    ingestTransport: transport,
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
  return { result, appends, spy };
}

/** How many of the recorded appends carry the boundary action (`effect.boundary-crossed`)? */
function boundaryCount(appends: string[]): number {
  return appends.filter((a) => a.includes("effect.boundary-crossed")).length;
}

// A PRE-AUTHORIZED approver naming git.push; and a deny-all approver (NOT pre-authorized).
const APPROVE_GIT_PUSH = () => ({ status: "approved" as const, reason: "pre-authorized (test)" });
const DENY_ALL = () => ({
  status: "denied" as const,
  reason: "not pre-authorized (deny-by-default)",
});

const PUSH_OK = { url: "https://github.com/o/r.git", branch: "main" };

// ==================================================================================================
// CAP6b-ADVERTISE — the BIN advertises EXACTLY 16 tools: the 15 (incl. net.fetch) + git.push. This is the
//   15 -> 16 capability-surface bump — it appears ONLY on the bin, because the bin is the composition that
//   WIRES BOTH "approval" + "egress-allowlist" + ENFORCES approval + the egress fold.
// ==================================================================================================
describe("CAP6b — the bin advertises 16 tools (the 15 tools + git.push)", () => {
  it("tools/list on the bin includes git.push (the 16th tool)", async () => {
    const spy = new SpyFakeSandboxAdapter();
    const { transport } = countingKernelTransport();
    const { deps } = await buildBinDeps(false, { ingestTransport: transport, substrate: spy });
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
    expect(tools.length).toBe(16);
  });
});

// ==================================================================================================
// CAP6b-APPROVAL+EGRESS+BOUNDARY (the CORE) — allowlisted host + PRE-AUTHORIZED => approved => the effect
//   runs once + a boundary event (intent + boundary = 2 appends). The argv reached the substrate built
//   FROM the binding (git push -- <url> <branch>).
// ==================================================================================================
describe("CAP6b — the bin RUNS git.push when egress-allowlisted AND pre-authorized (approval+egress+boundary)", () => {
  it("git.push allowlisted host + pre-authorized approver => effect runs once + boundary (2 appends)", async () => {
    const { result, appends, spy } = await driveOneCall(
      { egressAllow: ["github.com"], approve: APPROVE_GIT_PUSH },
      { name: "git.push", arguments: PUSH_OK },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
    // The argv built FROM the binding — git push -- <url> <branch>.
    expect(spy.execCalls[0]?.argv).toEqual([
      "git",
      "push",
      "--",
      "https://github.com/o/r.git",
      "main",
    ]);
    // Two WORM appends: the commit-before-effect intent + the post-effect boundary (network-egress).
    expect(appends.length).toBe(2);
    expect(boundaryCount(appends)).toBe(1);
  });

  it("the boundary event records networkHosts=[host] but NO argvRedacted / NO url (credential-blind WORM)", async () => {
    const { result, appends, spy } = await driveOneCall(
      { egressAllow: ["github.com"], approve: APPROVE_GIT_PUSH },
      {
        name: "git.push",
        arguments: { url: "https://github.com/o/secret-repo.git", branch: "main" },
      },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
    const boundary = appends.find((a) => a.includes("effect.boundary-crossed"));
    expect(boundary).toBeDefined();
    if (boundary === undefined) return;
    // The SAFE summary is retained: the host appears (it is the very thing the egress gate decided on).
    expect(boundary).toContain("github.com");
    // The CAP7 credential-blind invariant: NO argvRedacted/argv0/argc keys, and the full url path (the
    // repo path that could carry a token or sensitive name) does NOT leak into the boundary bytes.
    expect(boundary).not.toContain("argvRedacted");
    expect(boundary).not.toContain("argv0");
    expect(boundary).not.toContain("secret-repo.git");
  });

  it("a URL-query token in an admitted git.push URL NEVER reaches the WORM (credential-blind)", async () => {
    // isAllowedFetchUrl validates protocol/userinfo/host but NOT the path/query, so a `?token=<canary>` URL
    // is ADMITTED + executed; the boundary WORM must record ONLY host/operationClass, never the raw url.
    // The canary is built at RUNTIME so the secret scanner stays clean.
    const canary = ["CANARY", "qtok", Math.random().toString(36).slice(2)].join("_");
    const { result, appends, spy } = await driveOneCall(
      { egressAllow: ["github.com"], approve: APPROVE_GIT_PUSH },
      {
        name: "git.push",
        arguments: { url: `https://github.com/o/r.git?token=${canary}`, branch: "main" },
      },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
    expect(appends.length).toBe(2);
    expect(boundaryCount(appends)).toBe(1);
    for (const a of appends) {
      expect(a).not.toContain(canary);
      expect(a).not.toContain("token=");
    }
  });
});

// ==================================================================================================
// CAP6b-APPROVAL-DENY (the CORE for "first destructive tool") — allowlisted host but NON-pre-authorized
//   approver => DENIED@approval => the effect runs 0 times + NO boundary. This is the approval gate REALLY
//   blocking the first registered destructive tool. NON-VACUITY: drop the manifest's requiresApproval:true
//   (impossible — superRefine forces it) OR the bin's requiresApproval wiring (CAP4b) => it would execute.
// ==================================================================================================
describe("CAP6b — the bin DENIES git.push at the approval stage when NOT pre-authorized (effect 0, no boundary)", () => {
  it("allowlisted host + deny-all approver => DENIED: approval, effect 0, NO boundary", async () => {
    const { result, appends, spy } = await driveOneCall(
      { egressAllow: ["github.com"], approve: DENY_ALL },
      { name: "git.push", arguments: PUSH_OK },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DENIED: approval");
    // Approval is AFTER the egress fold but BEFORE commit-before-effect -> the effect NEVER ran.
    expect(spy.execCalls.length).toBe(0);
    // No effect => no intent? Approval denies before commit-before-effect, so NO append at all, NO boundary.
    expect(boundaryCount(appends)).toBe(0);
  });
});

// ==================================================================================================
// CAP6b-EGRESS-DENY — NON-allowlisted host => DENIED@policy (the egress fold, at the policy stage, BEFORE
//   approval) => the effect runs 0 times + NO boundary. EVEN pre-authorized: egress is checked at authorize,
//   before the approval stage, so a pre-auth cannot smuggle a push to a non-allowlisted host.
// ==================================================================================================
describe("CAP6b — the bin DENIES git.push to a non-allowlisted host (egress fold gates BEFORE approval)", () => {
  it("non-allowlisted host (even pre-authorized) => DENIED@policy, effect 0, NO boundary", async () => {
    const { result, appends, spy } = await driveOneCall(
      { egressAllow: ["github.com"], approve: APPROVE_GIT_PUSH },
      { name: "git.push", arguments: { url: "https://evil.example/o/r.git", branch: "main" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy");
    expect(spy.execCalls.length).toBe(0);
    expect(boundaryCount(appends)).toBe(0);
  });

  it("DEFAULT (empty) egress allowlist => deny-all egress => git.push DENIED, effect 0", async () => {
    const { result, spy } = await driveOneCall(
      { egressAllow: [], approve: APPROVE_GIT_PUSH },
      { name: "git.push", arguments: PUSH_OK },
    );
    expect(result.isError).toBe(true);
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// CAP6b-ENV-APPROVER — the LIVE bin builds its approver from AGENTOS_APPROVE_PREAUTH (the env-driven
//   default, no injected `approve`). git.push pre-authorized via env => approved (with an allowlisted host);
//   git.push NOT in the env allowlist => deny-all => DENIED@approval, effect 0. This proves the REAL bin
//   path (not just the injected test seam) gates the first destructive tool.
// ==================================================================================================
describe("CAP6b — the env-driven (LIVE) approver gates git.push (AGENTOS_APPROVE_PREAUTH)", () => {
  const PRE = "AGENTOS_APPROVE_PREAUTH";
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[PRE];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[PRE];
    else process.env[PRE] = prev;
  });

  it("AGENTOS_APPROVE_PREAUTH='git.push' + allowlisted host => approved, effect runs", async () => {
    process.env[PRE] = "git.push";
    // No injected approve => the bin builds createBudgetApprover(preAuthFromEnv(process.env)).
    const { result, spy } = await driveOneCall(
      { egressAllow: ["github.com"] },
      { name: "git.push", arguments: PUSH_OK },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
  });

  it("AGENTOS_APPROVE_PREAUTH WITHOUT git.push => deny-all => DENIED@approval, effect 0", async () => {
    process.env[PRE] = "exec.echo"; // git.push NOT in the allowlist
    const { result, spy } = await driveOneCall(
      { egressAllow: ["github.com"] },
      { name: "git.push", arguments: PUSH_OK },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DENIED: approval");
    expect(spy.execCalls.length).toBe(0);
  });

  it("UNCONFIGURED pre-auth (unset) => deny-all => DENIED@approval, effect 0 (fail-closed)", async () => {
    delete process.env[PRE];
    const { result, spy } = await driveOneCall(
      { egressAllow: ["github.com"] },
      { name: "git.push", arguments: PUSH_OK },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DENIED: approval");
    expect(spy.execCalls.length).toBe(0);
  });
});
