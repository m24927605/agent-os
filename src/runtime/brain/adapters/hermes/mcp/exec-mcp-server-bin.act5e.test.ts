/**
 * SLICE-ACT5e (RED-first) — the bin ADVERTISES the BROWSER family to the brain (Hermes) via the bin's MCP
 * server, DENY-BY-DEFAULT, routed through the SAME governed pipeline (`runGovernedToolCall`). This is the
 * THIRD family branch on ACT4's dispatcher (exec | action | BROWSER), mirroring ACT4 exactly.
 *
 * THE POSTURE THIS PINS: exposing "drive a real browser" to an untrusted/autonomous brain is the HEAVIEST
 * security posture in the system, so it is OFF unless `AGENTOS_ADVERTISE_BROWSER` is EXACTLY `"true"`/`"1"`
 * (or `opts.browserAdvertise`). When OFF (the default), the bin is BYTE-IDENTICAL: tools/list carries NO
 * browser.* tools, and a `browser.navigate` tools/call is DENIED (the name is neither registered nor
 * allow-ruled) with NO effect — the FakeBrowserConnector is NEVER called. When ON (+ an injected
 * FakeBrowserConnector — NO real browser / network / ~/.env), the browser tools are advertised with their
 * derived inputSchema, and a `browser.navigate` tools/call routes through the FULL governed pipeline
 * (per-navigation egress fold) before it ever reaches the FAKE connector.
 *
 * What this file pins (RED-first; `browserAdvertiseFromEnv` + the 3-way dispatcher + the gated browser
 * wiring do not exist yet):
 *  - ADVERTISE-OFF (default): tools/list carries NO browser.* tool; a browser.navigate tools/call =>
 *    isError:true (denied — unknown/unauthorized), the fake connector is NEVER called. BYTE-IDENTICAL: the
 *    16 exec tools are unchanged, and (advertise-actions ON) the action family is unaffected.
 *  - ADVERTISE-ON: tools/list INCLUDES browser.navigate/read/click/type with the correct derived
 *    inputSchema (the SERVER-HELD session is NOT advertised as a tool — only the sessionId reference flows);
 *    a brain-proposed browser step routes through the governed gates:
 *      • navigate egress fold: NO host on the egress allowlist => DENIED at policy, fake NEVER called;
 *        allowlisted host => proceeds to the fake;
 *      • click/type are destructive => approval: NOT pre-authorized => DENIED at approval, fake NEVER
 *        called; pre-authorized + allowlisted => proceeds;
 *      • read => the data-OUT sanitizer applies: a page canary reaches the brain redacted/truncated/untrusted;
 *      • type placeholder => credential-blind: a canary token in env never rides the tools/call response /WORM.
 *  - 3-WAY DISPATCH correctness: exec.echo => the EXEC effect (substrate runs); gmail.send => the ACTION
 *    effect (fake action connector); browser.navigate => the BROWSER effect (fake browser connector).
 *    NON-VACUITY: a dispatcher that drops the browser branch makes the browser.navigate routing test RED;
 *    a projection that drops the browser branch makes the navigate-egress test RED (CAP6 fail-closed).
 *
 * FakeBrowserConnector (server-held session map; NO real browser / network / ~/.env) + FakeActionConnector
 * + a Fake substrate + a counting Fake kernel transport. verify is browser- and network-free.
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
import { FakeActionConnector } from "../action-closed-loop.js";
import { FakeBrowserConnector } from "../browser-closed-loop.js";
import { type BuildBinOpts, browserAdvertiseFromEnv, buildBinDeps } from "./exec-mcp-server-bin.js";
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

/** Runtime-built `sk-...` canary (NOT a source literal — secret-scan clean). */
function skCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`;
}

/**
 * Drive ONE tools/call through the bin's REAL deps (Fake substrate + Fake kernel + an injected
 * FakeBrowserConnector / FakeActionConnector when supplied) over in-memory stdio; return the MCP result +
 * the append log + the spy substrate + the fake connectors. The browser connector is created here (with a
 * SERVER-HELD session opened) so a test can drive a brain-proposed step against a live sessionId.
 */
async function driveOneCall(
  opts: BuildBinOpts & { browserConnector?: FakeBrowserConnector },
  toolCall: { name: string; arguments?: Record<string, unknown> },
): Promise<{
  result: { isError: boolean; content: { text: string }[] };
  appends: string[];
  spy: SpyFakeSandboxAdapter;
  browser: FakeBrowserConnector;
  action: FakeActionConnector;
}> {
  const spy = new SpyFakeSandboxAdapter();
  const browser = (opts.browserConnector as FakeBrowserConnector) ?? new FakeBrowserConnector();
  const action = (opts.actionConnector as FakeActionConnector) ?? new FakeActionConnector();
  const { transport, appends } = countingKernelTransport();
  const { deps } = await buildBinDeps(false, {
    ingestTransport: transport,
    substrate: spy,
    browserConnector: browser,
    actionConnector: action,
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
  return { result, appends, spy, browser, action };
}

/** Drive ONE tools/list through the bin's REAL deps over in-memory stdio; return the advertised names. */
async function listTools(
  opts: BuildBinOpts & { browserConnector?: FakeBrowserConnector },
): Promise<{ names: string[]; tools: { name: string; inputSchema: unknown }[] }> {
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
  const tools = (responses[0]?.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
  return { names: tools.map((t) => t.name), tools };
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

/**
 * The browser tools the seeded family advertises. ACT5f CLOSED the session-bootstrap gap: the governed
 * session lifecycle (browser.session.open/close) is now ADVERTISED alongside the 4 step primitives
 * (navigate/read/click/type), so a brain can MINT a sessionId and drive the browser end-to-end. The
 * sessionId itself is still NEVER advertised — session.open MINTS + returns ONLY the opaque id (the moat).
 */
const BROWSER_STEP_4 = ["browser.navigate", "browser.read", "browser.click", "browser.type"];
const BROWSER_SESSION_2 = ["browser.session.open", "browser.session.close"];
const BROWSER_6 = [...BROWSER_SESSION_2, ...BROWSER_STEP_4];

// ==================================================================================================
// ENV-GATE — browserAdvertiseFromEnv (deny-by-default; mirrors actionAdvertiseFromEnv: exact "true"/"1").
// ==================================================================================================
describe("ACT5e — browserAdvertiseFromEnv is deny-by-default (exact true/1)", () => {
  it("'true' or '1' => true; unset / blank / any other string => false", () => {
    expect(browserAdvertiseFromEnv({ AGENTOS_ADVERTISE_BROWSER: "true" })).toBe(true);
    expect(browserAdvertiseFromEnv({ AGENTOS_ADVERTISE_BROWSER: "1" })).toBe(true);
    expect(browserAdvertiseFromEnv({})).toBe(false);
    expect(browserAdvertiseFromEnv({ AGENTOS_ADVERTISE_BROWSER: "" })).toBe(false);
    expect(browserAdvertiseFromEnv({ AGENTOS_ADVERTISE_BROWSER: "TRUE" })).toBe(false);
    expect(browserAdvertiseFromEnv({ AGENTOS_ADVERTISE_BROWSER: "yes" })).toBe(false);
    expect(browserAdvertiseFromEnv({ AGENTOS_ADVERTISE_BROWSER: "true " })).toBe(false);
    expect(browserAdvertiseFromEnv({ AGENTOS_ADVERTISE_BROWSER: "false" })).toBe(false);
  });
});

// ==================================================================================================
// ADVERTISE-OFF (default) — byte-identical: tools/list carries NO browser.* tool; a browser.navigate
//   tools/call is DENIED (unknown/unauthorized), the fake connector is NEVER called.
// ==================================================================================================
describe("ACT5e — advertise OFF (default): the bin is byte-identical (no browser; browser denied)", () => {
  it("tools/list carries the 16 exec tools ONLY (no browser.* tool — step OR session)", async () => {
    const { names } = await listTools({});
    expect(names.sort()).toEqual([...EXEC_16].sort());
    // Deny-by-default: NO browser tool when advertise-browser is OFF — neither the step primitives nor
    // the (ACT5f) governed session lifecycle.
    for (const n of BROWSER_6) expect(names).not.toContain(n);
  });

  it("advertise-actions ON but browser OFF: tools/list is exec + action ONLY (no browser leak)", async () => {
    const { names } = await listTools({
      actionAdvertise: true,
      actionConnector: new FakeActionConnector(),
    });
    for (const n of EXEC_16) expect(names).toContain(n);
    expect(names).toContain("gmail.send");
    for (const n of BROWSER_6) expect(names).not.toContain(n);
  });

  it("a browser.navigate tools/call is DENIED (deny-by-default) — the fake connector is NEVER called", async () => {
    const browser = new FakeBrowserConnector();
    const sid = browser.openSession();
    const { result, appends, spy } = await driveOneCall(
      { browserConnector: browser },
      { name: "browser.navigate", arguments: { sessionId: sid, url: "https://allowed.example/x" } },
    );
    expect(result.isError).toBe(true);
    // Denied at a governed gate (policy: not registered / no allow rule) — never a fabricated ok.
    expect(result.content[0]?.text).toContain("DENIED");
    // The fake browser connector NEVER ran; the exec substrate NEVER ran; no effect => no boundary append.
    expect(browser.steps.length).toBe(0);
    expect(spy.execCalls.length).toBe(0);
    expect(appends.length).toBe(0);
  });
});

// ==================================================================================================
// ADVERTISE-ON — tools/list INCLUDES the browser tools with the correct derived inputSchema.
// ==================================================================================================
describe("ACT5e — advertise ON: tools/list includes the browser family (derived inputSchema)", () => {
  it("the 16 exec tools PLUS the 6 browser tools are advertised; browser.navigate inputSchema matches its argSchema", async () => {
    const { names, tools } = await listTools({
      browserAdvertise: true,
      browserConnector: new FakeBrowserConnector(),
    });
    for (const n of EXEC_16) expect(names).toContain(n);
    // ACT5f: the advertised browser set is the 4 step primitives PLUS the governed session lifecycle.
    for (const n of BROWSER_6) expect(names).toContain(n);
    // browser.navigate's inputSchema is DERIVED from its strict argSchema (sessionId + url, both strings).
    const nav = tools.find((t) => t.name === "browser.navigate");
    expect(nav?.inputSchema).toEqual({
      type: "object",
      properties: {
        sessionId: { type: "string" },
        url: { type: "string" },
      },
      required: ["sessionId", "url"],
      additionalProperties: false,
    });
    // browser.type advertises sessionId + selector + text (the text is a credential placeholder at egress).
    const type = tools.find((t) => t.name === "browser.type");
    expect(type?.inputSchema).toEqual({
      type: "object",
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
      },
      required: ["sessionId", "selector", "text"],
      additionalProperties: false,
    });
    // ACT5f: browser.session.open takes NO params (it MINTS a sessionId) — its strict {} derives an empty
    // object schema; browser.session.close takes ONLY the opaque sessionId reference to release.
    const open = tools.find((t) => t.name === "browser.session.open");
    expect(open?.inputSchema).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    const close = tools.find((t) => t.name === "browser.session.close");
    expect(close?.inputSchema).toEqual({
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    });
  });

  it("ACT5f SESSION ADVERTISED: with browser ON, the GOVERNED session lifecycle IS a tool (gap closed)", async () => {
    // ACT5f CLOSED the ACT5e gap: session.open/close are now GOVERNED tools so a brain can MINT a sessionId
    // and drive the browser end-to-end. The advertised browser set is EXACTLY the 6 (session.open/close +
    // navigate/read/click/type). The MOAT holds: session.open MINTS + returns ONLY the opaque sessionId
    // (never the handle/cookie/url) — the sessionId-as-a-tool is the lifecycle, never the actor's session.
    const { names } = await listTools({
      browserAdvertise: true,
      browserConnector: new FakeBrowserConnector(),
    });
    expect(names.sort().filter((n) => n.startsWith("browser."))).toEqual([...BROWSER_6].sort());
    expect(names).toContain("browser.session.open");
    expect(names).toContain("browser.session.close");
  });
});

// ==================================================================================================
// ADVERTISE-ON — the governed gates apply to a brain-proposed browser step.
// ==================================================================================================
describe("ACT5e — advertise ON: a brain-proposed browser.navigate is governed (egress fold)", () => {
  it("NO host on the egress allowlist => DENIED at policy; the fake connector is NEVER called", async () => {
    const browser = new FakeBrowserConnector();
    const sid = browser.openSession();
    const { result, appends } = await driveOneCall(
      {
        browserAdvertise: true,
        browserConnector: browser,
        egressAllow: ["example.test"], // NOT allowed.example
      },
      { name: "browser.navigate", arguments: { sessionId: sid, url: "https://allowed.example/x" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy");
    // Denied at the egress fold (BEFORE commit/effect): the fake never navigated, nothing appended.
    expect(browser.steps.length).toBe(0);
    expect(appends.length).toBe(0);
    // NON-VACUITY (projection-drop-browser): dropping the browser branch from the 3-way projection leaves
    // navigate with NO projectable host => the CAP6 fail-closed rule still denies, but the per-navigation
    // egress gate (which needs the projected host to compare against the allowlist) is silently skipped —
    // an allowlisted-host navigate (next test) would then ERRONEOUSLY proceed without an egress decision.
  });

  it("host IS allowlisted => navigate PROCEEDS to the fake connector (egress fold passes)", async () => {
    const browser = new FakeBrowserConnector();
    const sid = browser.openSession();
    const { result } = await driveOneCall(
      {
        browserAdvertise: true,
        browserConnector: browser,
        egressAllow: ["allowed.example"],
      },
      { name: "browser.navigate", arguments: { sessionId: sid, url: "https://allowed.example/x" } },
    );
    expect(result.isError).toBe(false);
    // The governed pipeline reached the BROWSER effect: the fake navigated exactly once.
    expect(browser.steps.length).toBe(1);
    expect(browser.steps[0]?.primitive).toBe("navigate");
  });
});

describe("ACT5e — advertise ON: destructive browser.click/type are governed (approval)", () => {
  it("browser.click + NO pre-auth => DENIED at approval; the fake connector is NEVER called", async () => {
    const browser = new FakeBrowserConnector();
    const sid = browser.openSession();
    const { result, appends } = await driveOneCall(
      {
        browserAdvertise: true,
        browserConnector: browser,
        egressAllow: ["allowed.example"],
        approve: () => ({ status: "denied", reason: "not pre-authorized (deny-by-default)" }),
      },
      { name: "browser.click", arguments: { sessionId: sid, selector: "#submit" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DENIED: approval");
    // Approval is BEFORE commit-before-effect => the fake never clicked, nothing appended.
    expect(browser.steps.length).toBe(0);
    expect(appends.length).toBe(0);
  });

  it("browser.click + pre-authorized => PROCEEDS to the fake connector", async () => {
    const browser = new FakeBrowserConnector();
    const sid = browser.openSession();
    const { result } = await driveOneCall(
      {
        browserAdvertise: true,
        browserConnector: browser,
        egressAllow: ["allowed.example"],
        approve: () => ({ status: "approved", reason: "pre-authorized (test)" }),
      },
      { name: "browser.click", arguments: { sessionId: sid, selector: "#submit" } },
    );
    expect(result.isError).toBe(false);
    expect(browser.steps.length).toBe(1);
    expect(browser.steps[0]?.primitive).toBe("click");
  });
});

// ==================================================================================================
// ADVERTISE-ON — browser.read applies the data-OUT sanitizer (page canary redacted/truncated/untrusted).
// ==================================================================================================
describe("ACT5e — advertise ON: browser.read content is data-OUT sanitized before the brain", () => {
  it("a page canary secret is REDACTED + TRUNCATED + marked untrusted in the tools/call response", async () => {
    const canary = skCanary();
    const browser = new FakeBrowserConnector({
      content: `leaked secret ${canary} ${"PAD".repeat(5000)}`,
    });
    const sid = browser.openSession();
    const { result } = await driveOneCall(
      { browserAdvertise: true, browserConnector: browser, egressAllow: ["allowed.example"] },
      { name: "browser.read", arguments: { sessionId: sid } },
    );
    expect(result.isError).toBe(false);
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain(canary);
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("untrusted");
    expect(text).toContain("truncated");
  });
});

// ==================================================================================================
// ADVERTISE-ON — browser.type placeholder is CREDENTIAL-BLIND: a canary token in env never rides the
//   response / WORM (the placeholder is materialized ONLY at the connector egress, on the actor side).
// ==================================================================================================
describe("ACT5e — advertise ON: browser.type placeholder is credential-blind (canary never leaks)", () => {
  it("a process-env canary the connector resolves at egress is in NO observable byte (response / WORM)", async () => {
    // The canary stands in for a REAL secret the operator puts in env at the KEY the placeholder resolves
    // at egress (on the actor side). The brain-proposed browser.type carries ONLY the placeholder; the
    // resolved value is what-the-connector-would-type, reachable only via peekLastTyped (a test probe). The
    // canary must NOT appear in the tools/call response or any WORM byte. Built at RUNTIME (secret-scan clean).
    const canary = ["CANARY", "tok", Math.random().toString(36).slice(2)].join("_");
    const KEY = "AGENTOS_BROWSER_TYPE_KEY";
    const browser = new FakeBrowserConnector({ env: { [KEY]: canary } });
    const sid = browser.openSession();
    const { result, appends } = await driveOneCall(
      {
        browserAdvertise: true,
        browserConnector: browser,
        egressAllow: ["allowed.example"],
        approve: () => ({ status: "approved", reason: "pre-authorized (test)" }),
      },
      {
        name: "browser.type",
        arguments: { sessionId: sid, selector: "#password", text: `openshell:resolve:env:${KEY}` },
      },
    );
    expect(result.isError).toBe(false);
    // The connector resolved the placeholder at egress (actor side) — what-it-would-type is the canary.
    expect(browser.peekLastTyped()).toBe(canary);
    // But the canary NEVER rides back: not in the tools/call response, not in any WORM append byte.
    expect(result.content[0]?.text ?? "").not.toContain(canary);
    for (const a of appends) expect(a).not.toContain(canary);
  });
});

// ==================================================================================================
// FAIL-CLOSED LIVE CONNECTOR — advertise-browser ON in REAL mode without an injected connector must NOT
//   silently back the advertised browser capability with a test double; it fails closed at startup.
// ==================================================================================================
describe("ACT5e — advertise ON in REAL mode without a connector fails closed (no fake-backed live browser)", () => {
  it("buildBinDeps(false, { browserAdvertise: true }) with NO browserConnector THROWS (deny-by-default)", async () => {
    const spy = new SpyFakeSandboxAdapter();
    const { transport } = countingKernelTransport();
    await expect(
      buildBinDeps(false, {
        ingestTransport: transport,
        substrate: spy,
        browserAdvertise: true,
        // NO browserConnector injected — the REAL bin must refuse to back the advertisement with a fake.
      }),
    ).rejects.toThrow(/browser connector/i);
  });

  it("advertise-browser ON WITH an injected connector builds fine (the operator-injected path)", async () => {
    const spy = new SpyFakeSandboxAdapter();
    const { transport } = countingKernelTransport();
    await expect(
      buildBinDeps(false, {
        ingestTransport: transport,
        substrate: spy,
        browserAdvertise: true,
        browserConnector: new FakeBrowserConnector(),
      }),
    ).resolves.toBeDefined();
  });

  it("a SESSION-BLIND connector (no hasSession) is REFUSED before advertising (fail-closed)", async () => {
    // A connector that only guarantees `perform()` would let the effect's UNKNOWN-SESSION gate fall open
    // (a brain-supplied phantom sessionId could reach perform). The advertised path REQUIRES hasSession.
    const spy = new SpyFakeSandboxAdapter();
    const { transport } = countingKernelTransport();
    const sessionBlind = {
      perform: () => Promise.resolve({ ok: true }),
    };
    await expect(
      buildBinDeps(false, {
        ingestTransport: transport,
        substrate: spy,
        browserAdvertise: true,
        browserConnector: sessionBlind,
      }),
    ).rejects.toThrow(/hasSession/i);
  });
});

// ==================================================================================================
// 3-WAY DISPATCH — exec routes to the EXEC effect; action routes to the ACTION effect; browser routes to
//   the BROWSER effect (fake). NON-VACUITY: a dispatcher that drops the browser branch makes the
//   browser.navigate routing test RED (the fake browser connector would never run; navigate would fall to
//   the action or exec path and error).
// ==================================================================================================
describe("ACT5e — 3-WAY DISPATCH: browser.navigate routes to the BROWSER effect (fake)", () => {
  it("a fully-authorized browser.navigate runs on the FAKE BROWSER connector; substrate + action untouched", async () => {
    const browser = new FakeBrowserConnector();
    const sid = browser.openSession();
    const action = new FakeActionConnector();
    const { result, spy } = await driveOneCall(
      {
        // BOTH families advertised so dispatch must pick the RIGHT one (the third branch, not exec/action).
        browserAdvertise: true,
        browserConnector: browser,
        actionAdvertise: true,
        actionConnector: action,
        egressAllow: ["allowed.example"],
      },
      { name: "browser.navigate", arguments: { sessionId: sid, url: "https://allowed.example/x" } },
    );
    expect(result.isError).toBe(false);
    // The BROWSER effect ran on the fake browser connector; the substrate + the action connector did NOT.
    expect(browser.steps.length).toBe(1);
    expect(spy.execCalls.length).toBe(0);
    expect(action.invokeCalls.length).toBe(0);
  });
});

describe("ACT5e — 3-WAY DISPATCH: exec.echo => EXEC; gmail.send => ACTION (with browser advertised too)", () => {
  it("exec.echo runs on the substrate; the browser + action connectors are NEVER called", async () => {
    const browser = new FakeBrowserConnector();
    const action = new FakeActionConnector();
    const { result, spy } = await driveOneCall(
      {
        browserAdvertise: true,
        browserConnector: browser,
        actionAdvertise: true,
        actionConnector: action,
      },
      { name: "exec.echo", arguments: { text: "hi" } },
    );
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("echo hi");
    // The EXEC effect ran; NEITHER the browser NOR the action connector was called (dispatch correctness).
    expect(spy.execCalls.length).toBe(1);
    expect(browser.steps.length).toBe(0);
    expect(action.invokeCalls.length).toBe(0);
  });

  it("a fully-authorized gmail.send runs on the FAKE ACTION connector; substrate + browser untouched", async () => {
    const browser = new FakeBrowserConnector();
    const action = new FakeActionConnector();
    const { result, spy } = await driveOneCall(
      {
        browserAdvertise: true,
        browserConnector: browser,
        actionAdvertise: true,
        actionConnector: action,
        egressAllow: ["gmail.googleapis.com"],
        approve: () => ({ status: "approved", reason: "pre-authorized (test)" }),
      },
      { name: "gmail.send", arguments: { to: "x@example.test", subject: "s", body: "b" } },
    );
    expect(result.isError).toBe(false);
    // The ACTION effect ran on the fake action connector; the substrate + the browser connector did NOT.
    expect(action.invokeCalls.length).toBe(1);
    expect(spy.execCalls.length).toBe(0);
    expect(browser.steps.length).toBe(0);
  });
});
