/**
 * SLICE-ACT4 (RED-first) — the bin ADVERTISES the action family to the brain (Hermes) via the bin's MCP
 * server, DENY-BY-DEFAULT, routed through the SAME governed pipeline (`runGovernedToolCall`).
 *
 * THE POSTURE THIS PINS: exposing "send an email / delete a file" to an untrusted/autonomous brain is a
 * deliberate security decision, so it is OFF unless `AGENTOS_ADVERTISE_ACTIONS` is EXACTLY `"true"`/`"1"`
 * (or `opts.actionAdvertise`). When OFF (the default), the bin is BYTE-IDENTICAL to today: tools/list is
 * the 16 exec tools ONLY (no gmail.send/drive.read/...), and a `gmail.send` tools/call is DENIED (the name
 * is neither registered nor allow-ruled) with NO effect. When ON (+ an injected FakeActionConnector — NO
 * network), the action tools are advertised with their derived inputSchema, and a `gmail.send` tools/call
 * routes through the FULL governed pipeline (egress fold + approval + commit-before-effect + boundary)
 * before it ever reaches the FAKE connector.
 *
 * What this file pins (RED-first; `actionAdvertiseFromEnv` + the dispatcher + the gated wiring do not exist
 * yet):
 *  - ADVERTISE-OFF (default): tools/list = the 16 exec tools ONLY; a gmail.send tools/call => isError:true
 *    (denied — unknown/unauthorized), the fake connector is NEVER called.
 *  - ADVERTISE-ON: tools/list INCLUDES gmail.send/drive.read/... with the correct derived inputSchema; a
 *    gmail.send tools/call routes through the governed gates:
 *      • egress fold: NO gmail host on the egress allowlist => DENIED at policy, the fake is NEVER called;
 *      • approval: gmail.send is destructive + NOT pre-authorized => DENIED at approval, fake NEVER called;
 *      • pre-authorized + gmail host on the allowlist => proceeds to the dispatcher => the FAKE connector
 *        (the descriptor's service/method are composer-fixed gmail/send), and the boundary WORM event is
 *        appended (external network-egress effect) => 2 appends (intent + boundary).
 *  - DISPATCH correctness: an exec tool (exec.echo) routes to the EXEC effect (the substrate runs); an
 *    action tool (gmail.send) routes to the ACTION effect (the FAKE connector runs, substrate untouched).
 *    NON-VACUITY: a dispatcher that ALWAYS uses the exec effect makes the gmail.send routing test RED (the
 *    fake connector would never be called; the call would hit the exec path / error).
 *  - CREDENTIAL-BLIND: a brain-proposed gmail.send with a canary token in the injected env reaches the fake
 *    connector descriptor's env ONLY as a placeholder (openshell:resolve:env:<KEY>); the canary token NEVER
 *    appears in the descriptor env, the tools/call response, or the WORM append bytes.
 *
 * FakeActionConnector (records every descriptor; NO real network / OAuth / MCP) + Fake substrate + a
 * counting Fake kernel transport. verify is network-free.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AppendTransport } from "../../../../../audit/index.js";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
} from "../../../../substrate/index.js";
import { type ActionDescriptor, FakeActionConnector } from "../action-closed-loop.js";
import { type BuildBinOpts, actionAdvertiseFromEnv, buildBinDeps } from "./exec-mcp-server-bin.js";
import { runExecMcpStdio } from "./exec-mcp-stdio.js";

// ==================================================================================================
// Test doubles.
// ==================================================================================================

/** A spying Fake substrate: counts exec calls so a test can assert the EXEC effect ran (or did not). */
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
 * A counting kernel transport: a well-formed receipt per append (so commit-before-effect treats it
 * durable) AND captures the canonical bytes of EVERY append (intent + any boundary), so a test can count
 * them and assert the credential-blind invariant on the wire.
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

/**
 * Drive ONE tools/call through the bin's REAL deps (Fake substrate + Fake kernel + an injected
 * FakeActionConnector when supplied) over in-memory stdio; return the MCP result + the append log +
 * the spy substrate + the fake connector.
 */
async function driveOneCall(
  opts: BuildBinOpts,
  toolCall: { name: string; arguments?: Record<string, unknown> },
): Promise<{
  result: { isError: boolean; content: { text: string }[] };
  appends: string[];
  spy: SpyFakeSandboxAdapter;
  connector: FakeActionConnector;
}> {
  const spy = new SpyFakeSandboxAdapter();
  const connector = (opts.actionConnector as FakeActionConnector) ?? new FakeActionConnector();
  const { transport, appends } = countingKernelTransport();
  const { deps } = await buildBinDeps(false, {
    ingestTransport: transport,
    substrate: spy,
    actionConnector: connector,
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
  return { result, appends, spy, connector };
}

/** Drive ONE tools/list through the bin's REAL deps over in-memory stdio; return the advertised names. */
async function listTools(opts: BuildBinOpts): Promise<string[]> {
  const spy = new SpyFakeSandboxAdapter();
  const { transport } = countingKernelTransport();
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
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
  input.end();
  await done;
  const responses = Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return (responses[0]?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
}

/** The 16 exec tools the default (advertise-off) bin advertises — byte-identical to today. */
const EXEC_16 = [
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
];

// ==================================================================================================
// ENV-GATE — actionAdvertiseFromEnv (deny-by-default; mirrors actionLiveFromEnv: exact "true"/"1").
// ==================================================================================================
describe("ACT4 — actionAdvertiseFromEnv is deny-by-default (exact true/1)", () => {
  it("'true' or '1' => true; unset / blank / any other string => false", () => {
    expect(actionAdvertiseFromEnv({ AGENTOS_ADVERTISE_ACTIONS: "true" })).toBe(true);
    expect(actionAdvertiseFromEnv({ AGENTOS_ADVERTISE_ACTIONS: "1" })).toBe(true);
    expect(actionAdvertiseFromEnv({})).toBe(false);
    expect(actionAdvertiseFromEnv({ AGENTOS_ADVERTISE_ACTIONS: "" })).toBe(false);
    expect(actionAdvertiseFromEnv({ AGENTOS_ADVERTISE_ACTIONS: "TRUE" })).toBe(false);
    expect(actionAdvertiseFromEnv({ AGENTOS_ADVERTISE_ACTIONS: "yes" })).toBe(false);
    expect(actionAdvertiseFromEnv({ AGENTOS_ADVERTISE_ACTIONS: "true " })).toBe(false);
    expect(actionAdvertiseFromEnv({ AGENTOS_ADVERTISE_ACTIONS: "false" })).toBe(false);
  });
});

// ==================================================================================================
// ADVERTISE-OFF (default) — byte-identical: tools/list = the 16 exec tools ONLY; a gmail.send tools/call
//   is DENIED (unknown/unauthorized), the fake connector is NEVER called.
// ==================================================================================================
describe("ACT4 — advertise OFF (default): the bin is byte-identical (16 exec; action denied)", () => {
  it("tools/list advertises EXACTLY the 16 exec tools (no gmail.send / drive.read / ...)", async () => {
    const names = await listTools({});
    expect(names.sort()).toEqual([...EXEC_16].sort());
    // No action tool leaks into the default advertisement.
    expect(names).not.toContain("gmail.send");
    expect(names).not.toContain("drive.read");
    expect(names).not.toContain("drive.files.delete");
    expect(names).not.toContain("calendar.events.create");
  });

  it("a gmail.send tools/call is DENIED (deny-by-default) — the fake connector is NEVER called", async () => {
    const connector = new FakeActionConnector();
    const { result, appends, spy } = await driveOneCall(
      { actionConnector: connector },
      {
        name: "gmail.send",
        arguments: { to: "x@example.test", subject: "s", body: "b" },
      },
    );
    expect(result.isError).toBe(true);
    // Denied at a governed gate (policy: not registered / no allow rule) — never a fabricated ok.
    expect(result.content[0]?.text).toContain("DENIED");
    // The fake connector NEVER ran; the exec substrate NEVER ran; no effect => no boundary append.
    expect(connector.invokeCalls.length).toBe(0);
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// ADVERTISE-ON — tools/list INCLUDES the action tools with the correct derived inputSchema.
// ==================================================================================================
describe("ACT4 — advertise ON: tools/list includes the action family (derived inputSchema)", () => {
  it("the 16 exec tools PLUS the 6 action tools are advertised; gmail.send inputSchema matches its argSchema", async () => {
    const spy = new SpyFakeSandboxAdapter();
    const { transport } = countingKernelTransport();
    const { deps } = await buildBinDeps(false, {
      ingestTransport: transport,
      substrate: spy,
      actionAdvertise: true,
      actionConnector: new FakeActionConnector(),
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    const done = runExecMcpStdio(deps, { input, output });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
    input.end();
    await done;
    const tools = (
      Buffer.concat(chunks)
        .toString("utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>)[0]?.result as {
        tools: { name: string; inputSchema: unknown }[];
      }
    ).tools;
    const names = tools.map((t) => t.name);
    // The exec family is unchanged; the action family is ADDED.
    for (const n of EXEC_16) expect(names).toContain(n);
    for (const n of [
      "gmail.send",
      "drive.read",
      "drive.files.delete",
      "calendar.events.create",
      "calendar.events.list",
      "gmail.search",
    ]) {
      expect(names).toContain(n);
    }
    // gmail.send's inputSchema is DERIVED from its strict argSchema (no hand-written drift).
    const gmail = tools.find((t) => t.name === "gmail.send");
    expect(gmail?.inputSchema).toEqual({
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    });
  });
});

// ==================================================================================================
// ADVERTISE-ON — the governed gates apply to a brain-proposed action (egress fold + approval).
// ==================================================================================================
describe("ACT4 — advertise ON: a brain-proposed gmail.send is governed (egress fold)", () => {
  it("NO gmail host on the egress allowlist => DENIED at policy; the fake connector is NEVER called", async () => {
    const connector = new FakeActionConnector();
    const { result, appends } = await driveOneCall(
      {
        actionAdvertise: true,
        actionConnector: connector,
        // gmail.send is pre-authorized (so approval would pass) but the egress allowlist lacks the host.
        approve: () => ({ status: "approved", reason: "pre-authorized (test)" }),
        egressAllow: ["example.test"], // NOT gmail.googleapis.com
      },
      { name: "gmail.send", arguments: { to: "x@example.test", subject: "s", body: "b" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy");
    // Denied at the egress fold (BEFORE commit/effect): the fake connector never ran, nothing appended.
    expect(connector.invokeCalls.length).toBe(0);
    expect(appends.length).toBe(0);
  });
});

describe("ACT4 — advertise ON: a brain-proposed gmail.send is governed (approval)", () => {
  it("destructive gmail.send + NO pre-auth => DENIED at approval; the fake connector is NEVER called", async () => {
    const connector = new FakeActionConnector();
    const { result, appends } = await driveOneCall(
      {
        actionAdvertise: true,
        actionConnector: connector,
        // The gmail host IS allowlisted (egress would pass), but gmail.send is NOT pre-authorized.
        egressAllow: ["gmail.googleapis.com"],
        approve: () => ({ status: "denied", reason: "not pre-authorized (deny-by-default)" }),
      },
      { name: "gmail.send", arguments: { to: "x@example.test", subject: "s", body: "b" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DENIED: approval");
    // Approval is BEFORE commit-before-effect => the fake connector never ran, nothing appended.
    expect(connector.invokeCalls.length).toBe(0);
    expect(appends.length).toBe(0);
  });
});

// ==================================================================================================
// DISPATCH — exec tool routes to the EXEC effect; action tool routes to the ACTION effect (fake
//   connector). NON-VACUITY: a dispatcher that always uses the exec effect makes the gmail.send routing
//   test RED (the fake connector would never run).
// ==================================================================================================
describe("ACT4 — DISPATCH: gmail.send (fully authorized) routes to the ACTION effect (fake connector)", () => {
  it("pre-authorized + gmail host allowlisted => the FAKE connector runs (composer-fixed gmail/send); the substrate is untouched; intent + boundary appended", async () => {
    const connector = new FakeActionConnector();
    const { result, appends, spy } = await driveOneCall(
      {
        actionAdvertise: true,
        actionConnector: connector,
        egressAllow: ["gmail.googleapis.com"],
        approve: () => ({ status: "approved", reason: "pre-authorized (test)" }),
      },
      { name: "gmail.send", arguments: { to: "x@example.test", subject: "s", body: "b" } },
    );
    // The governed pipeline reached the ACTION effect: the FAKE connector ran exactly once.
    expect(result.isError).toBe(false);
    expect(connector.invokeCalls.length).toBe(1);
    // The descriptor's service/method are COMPOSER-FIXED (never brain-supplied).
    const descriptor = connector.invokeCalls[0]?.descriptor as ActionDescriptor;
    expect(descriptor.service).toBe("gmail");
    expect(descriptor.method).toBe("send");
    expect(descriptor.params).toEqual({ to: "x@example.test", subject: "s", body: "b" });
    // The EXEC substrate was NOT touched (this is the action path, not the exec path).
    expect(spy.execCalls.length).toBe(0);
    // gmail.send is network-egress => external => intent + boundary appended (2 events).
    expect(appends.length).toBe(2);
    expect(appends.filter((a) => a.includes("effect.boundary-crossed")).length).toBe(1);
  });
});

describe("ACT4 — DISPATCH: exec.echo routes to the EXEC effect (substrate), even with advertise ON", () => {
  it("an exec tool runs on the substrate; the action connector is NEVER called", async () => {
    const connector = new FakeActionConnector();
    const { result, spy } = await driveOneCall(
      { actionAdvertise: true, actionConnector: connector },
      { name: "exec.echo", arguments: { text: "hi" } },
    );
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("echo hi");
    // The EXEC effect ran on the substrate; the ACTION connector was NEVER called (dispatch correctness).
    expect(spy.execCalls.length).toBe(1);
    expect(connector.invokeCalls.length).toBe(0);
  });
});

// ==================================================================================================
// CREDENTIAL-BLIND — a brain-proposed gmail.send with a canary token in the injected env reaches the
//   fake connector descriptor's env as a PLACEHOLDER only; the canary appears in NEITHER the descriptor
//   env, the tools/call response, NOR any WORM append byte.
// ==================================================================================================
describe("ACT4 — CREDENTIAL-BLIND: a canary token NEVER reaches the descriptor env / response / WORM", () => {
  it("gmail.send's descriptor env carries only the placeholder; a process-env canary is in NO observable byte", async () => {
    // The canary stands in for the REAL Gmail OAuth token the operator would put in process.env at the
    // KEY the descriptor's placeholder resolves at egress. The brain-proposed gmail.send must build a
    // descriptor carrying ONLY the PLACEHOLDER (openshell:resolve:env:<KEY>) — never the literal token — so
    // the canary must NOT appear in the descriptor env, the tools/call response, or any WORM byte. Built at
    // RUNTIME so the secret scanner stays clean.
    const canary = ["CANARY", "tok", Math.random().toString(36).slice(2)].join("_");
    const KEY = "AGENTOS_GMAIL_OAUTH_KEY";
    const prev = process.env[KEY];
    process.env[KEY] = canary;
    try {
      const connector = new FakeActionConnector();
      const { result, appends } = await driveOneCall(
        {
          actionAdvertise: true,
          actionConnector: connector,
          egressAllow: ["gmail.googleapis.com"],
          approve: () => ({ status: "approved", reason: "pre-authorized (test)" }),
        },
        { name: "gmail.send", arguments: { to: "x@example.test", subject: "s", body: "b" } },
      );
      expect(result.isError).toBe(false);
      expect(connector.invokeCalls.length).toBe(1);
      const descriptor = connector.invokeCalls[0]?.descriptor as ActionDescriptor;
      // The descriptor env carries ONLY the placeholder — NEVER the literal token (the brain/connector
      // never sees the resolved secret; the transport resolves the placeholder at egress, not in tests).
      const envValues = Object.values(descriptor.env ?? {});
      expect(envValues).toContain("openshell:resolve:env:AGENTOS_GMAIL_OAUTH_KEY");
      for (const v of envValues) expect(v).not.toContain(canary);
      // The canary never appears in the tools/call response, nor in ANY WORM append byte (intent + boundary).
      expect(result.content[0]?.text).not.toContain(canary);
      for (const a of appends) expect(a).not.toContain(canary);
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  });
});
