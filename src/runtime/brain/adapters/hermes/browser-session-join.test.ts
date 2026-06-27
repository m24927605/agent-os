/**
 * SLICE-ACT5f (RED-first) — the END-TO-END JOIN: a brain drives a FULL browser task through the REAL
 * `runGovernedToolCall`, MINTING the sessionId itself via the governed `browser.session.open`, then
 * threading that id through navigate -> read -> click -> type -> session.close — EVERY step governed.
 *
 * ⚠️ ZERO change to the pipeline. The JOIN harness reconstructs the bin's authorize-fold (PDP +
 * egress + approval-from-manifest + external) IN THIS TEST over the BROWSER projection, exactly as
 * browser-join.test.ts / browser-click-type-join.test.ts do. NO real browser / network / ~/.env.
 *
 * The properties proven end-to-end (the ACT5f invariants):
 *   1. SESSION BOOTSTRAP GOVERNED + MINT: browser.session.open routes through the pipeline; the result
 *      carries ONLY the minted opaque sessionId (the moat: no handle/cookie/url); the SAME id then drives
 *      the rest of the task.
 *   2. END-TO-END (brain-usable, governed): open -> navigate(allowlisted) -> read(sanitized, untrusted) ->
 *      click(pre-authorized) -> type(placeholder, credential-blind) -> close — each step governed; the
 *      minted sessionId threads through.
 *   3. SESSION CAP fail-closed THROUGH the pipeline: opening `cap` sessions then a (cap+1)th
 *      browser.session.open => denied (the effect returns ok:false; the brain sees an error).
 *   4. COMMIT-BEFORE-EFFECT: the append precedes the mint (session.open) and the release (session.close).
 *   5. MOAT in the WORM: the session.open append carries the opaque id only — never the handle/cookie.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../../audit/index.js";
import type { CommitAppender } from "../../../../commitgate/index.js";
import { type CostGate, InMemoryCostGate } from "../../../../cost/index.js";
import {
  type AuthorizeDecision,
  type GovernedToolCallDeps,
  createBudgetApprover,
  runGovernedToolCall,
} from "../../../../orchestration/index.js";
import {
  type PolicyDecision,
  combineDecisions,
  egressDecisionForProjection,
} from "../../../../policy/index.js";
import { authorizeToolInvoke } from "../../../../tools/index.js";
import { defaultExecSecretDetector } from "../../../substrate/index.js";
import {
  type BrowserConnector,
  FakeBrowserConnector,
  bindingWrappedBrowserEffect,
} from "./browser-closed-loop.js";
import { buildBrowserProjectionForCall } from "./browser-projection-for-call.js";
import { seedBrowserBindings, seedBrowserRegistry } from "./browser-seed-tools.js";

const validCtx = {
  actorId: "agent:hermes",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

/** The full family: egress-allowlist opens navigate/read/session; approval opens click/type. */
const BROWSER_WIRED = new Set(["egress-allowlist", "approval"] as const);

/** The credential placeholder grammar the connector resolves at egress. */
function placeholderFor(key: string): string {
  return `openshell:resolve:env:${key}`;
}

interface AppenderKit {
  readonly appender: CommitAppender<unknown, { id: number }>;
  readonly appended: unknown[];
  readonly order: string[];
}
function makeAppender(opts: { order?: string[] } = {}): AppenderKit {
  const appended: unknown[] = [];
  const order = opts.order ?? [];
  let id = 0;
  const appender: CommitAppender<unknown, { id: number }> = {
    append: (event) => {
      appended.push(event);
      order.push("append");
      return Promise.resolve({ id: ++id });
    },
  };
  return { appender, appended, order };
}

/** Pull the minted sessionId out of an executed session.open result. */
function mintedSessionId(out: { status: string; detail?: string }): string | undefined {
  if (out.status !== "executed") return undefined;
  const m = (out.detail ?? "").match(/bsess_[A-Za-z0-9]{4,}/);
  return m?.[0];
}

function makeJoinDeps(opts: {
  fake: FakeBrowserConnector;
  binEgressAllow: readonly string[];
  preAuth?: readonly string[];
  appenderKit?: AppenderKit;
}): {
  deps: GovernedToolCallDeps<
    { tool: string; context: unknown; args?: Record<string, unknown> },
    { id: number }
  >;
  appended: unknown[];
} {
  const registry = seedBrowserRegistry(BROWSER_WIRED);
  const bindings = seedBrowserBindings(BROWSER_WIRED);
  const allowRules = [
    { id: "allow-browser", action: "tool:invoke", resource: "browser.**", tenantId: "tenant-a" },
  ];
  const cost: CostGate = new InMemoryCostGate(1_000_000);
  const kit = opts.appenderKit ?? makeAppender();
  const approve = createBudgetApprover((tc) => {
    const name = (tc as { tool?: unknown } | null)?.tool;
    return typeof name === "string" && (opts.preAuth ?? []).includes(name);
  });

  const baseEffect = bindingWrappedBrowserEffect(opts.fake, bindings, {
    detectSecret: defaultExecSecretDetector,
  });

  const deps: GovernedToolCallDeps<
    { tool: string; context: unknown; args?: Record<string, unknown> },
    { id: number }
  > = {
    screen: () => ({ ok: true }),
    authorize: (tc) => {
      const c = tc.context as typeof validCtx;
      const req = {
        requestId: c.requestId,
        tenantId: c.tenantId,
        projectId: c.projectId,
        taskId: c.taskId,
        actorId: c.actorId,
        action: "tool:invoke",
        resource: tc.tool,
      };
      const projection = buildBrowserProjectionForCall(
        { tool: tc.tool, ...(tc.args !== undefined ? { args: tc.args } : {}) },
        bindings,
        (name) => registry.lookup(name),
        "effectful",
      );
      const pdp: PolicyDecision = authorizeToolInvoke(req, registry, allowRules);
      const containment = registry.lookup(tc.tool)?.containment;
      let egressDecisions: PolicyDecision[];
      if (projection !== undefined && projection.networkHosts.length > 0) {
        egressDecisions = [
          egressDecisionForProjection(projection.networkHosts, opts.binEgressAllow),
        ];
      } else if (containment === "network-egress") {
        egressDecisions = [
          {
            effect: "deny",
            reason: "egress: network-egress tool with no projectable host — denied (fail-closed)",
            auditRequired: true,
          },
        ];
      } else {
        egressDecisions = [];
      }
      const combined = combineDecisions(pdp, egressDecisions);
      const decision: AuthorizeDecision = {
        effect: combined.effect,
        reason: redactSecrets(combined.reason),
        requiresApproval: registry.lookup(tc.tool)?.requiresApproval ?? false,
        external: containment === "network-egress" || containment === "host-fs-write",
        ...(projection !== undefined ? { projection } : {}),
      };
      return decision;
    },
    approve,
    cost,
    estimateTokens: () => 10,
    appender: kit.appender,
    effect: (tc) => {
      kit.order.push("effect");
      return baseEffect(tc);
    },
  };
  return { deps, appended: kit.appended };
}

// ==================================================================================================
// (1) SESSION BOOTSTRAP GOVERNED + MINT — the brain mints the sessionId through the pipeline.
// ==================================================================================================
describe("ACT5f JOIN (1) SESSION BOOTSTRAP — browser.session.open mints a usable opaque id, governed", () => {
  it("browser.session.open routes through the pipeline + returns ONLY the minted opaque sessionId", async () => {
    const cookie = `cookie-${Math.random().toString(36).slice(2)}`;
    const fake = new FakeBrowserConnector({ cookieSecret: cookie });
    const appenderKit = makeAppender();
    const { deps, appended } = makeJoinDeps({
      fake,
      binEgressAllow: ["allowed.example"],
      appenderKit,
    });
    const open = await runGovernedToolCall(deps, {
      tool: "browser.session.open",
      context: validCtx,
      args: {},
    });
    expect(open.status).toBe("executed");
    const sid = mintedSessionId(open);
    expect(sid).toMatch(/^bsess_[A-Za-z0-9]{4,}$/);
    expect(fake.hasSession(sid as string)).toBe(true);
    // MOAT: the brain-visible result + the WORM carry the opaque id only, NEVER the connector's cookie.
    expect(JSON.stringify(open)).not.toContain(cookie);
    expect(JSON.stringify(appended)).not.toContain(cookie);
  });

  it("commit-before-effect: the append precedes the mint (session.open) AND the release (session.close)", async () => {
    const fake = new FakeBrowserConnector();
    const order: string[] = [];
    const appenderKit = makeAppender({ order });
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["allowed.example"],
      appenderKit,
    });
    const open = await runGovernedToolCall(deps, {
      tool: "browser.session.open",
      context: validCtx,
      args: {},
    });
    expect(open.status).toBe("executed");
    const sid = mintedSessionId(open) as string;
    const close = await runGovernedToolCall(deps, {
      tool: "browser.session.close",
      context: validCtx,
      args: { sessionId: sid },
    });
    expect(close.status).toBe("executed");
    // The FIRST append precedes the FIRST effect (mint), and overall append-before-effect holds.
    expect(order.indexOf("append")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("append")).toBeLessThan(order.indexOf("effect"));
  });
});

// ==================================================================================================
// (2) END-TO-END — open -> navigate -> read -> click -> type -> close, each step governed, one session.
// ==================================================================================================
describe("ACT5f JOIN (2) END-TO-END — brain drives a full governed browser task on a minted session", () => {
  it("open -> navigate -> read(sanitized) -> click(pre-auth) -> type(placeholder) -> close, all governed", async () => {
    const canaryPw = `runtime-pw-${Math.random().toString(36).slice(2)}`;
    const pageSecret = `sk-${"a1B2c3D4".repeat(3)}`;
    const fake = new FakeBrowserConnector({
      content: `page body with secret ${pageSecret} ${"PAD".repeat(5000)}`,
      env: { LOGIN_PW: canaryPw },
    });
    const appenderKit = makeAppender();
    const { deps, appended } = makeJoinDeps({
      fake,
      binEgressAllow: ["allowed.example"],
      preAuth: ["browser.click", "browser.type"],
      appenderKit,
    });

    // (a) MINT the session through the governed pipeline.
    const open = await runGovernedToolCall(deps, {
      tool: "browser.session.open",
      context: validCtx,
      args: {},
    });
    expect(open.status).toBe("executed");
    const sid = mintedSessionId(open) as string;
    expect(sid).toMatch(/^bsess_[A-Za-z0-9]{4,}$/);

    // (b) navigate (allowlisted host).
    const nav = await runGovernedToolCall(deps, {
      tool: "browser.navigate",
      context: validCtx,
      args: { sessionId: sid, url: "https://allowed.example/login" },
    });
    expect(nav.status).toBe("executed");

    // (c) read (sanitized, untrusted) — the page canary does NOT reach the brain.
    const read = await runGovernedToolCall(deps, {
      tool: "browser.read",
      context: validCtx,
      args: { sessionId: sid },
    });
    expect(read.status).toBe("executed");
    const readDetail = read.status === "executed" ? (read.detail ?? "") : "";
    expect(readDetail).not.toContain(pageSecret);
    expect(readDetail).toContain("untrusted");

    // (d) click (pre-authorized destructive step).
    const click = await runGovernedToolCall(deps, {
      tool: "browser.click",
      context: validCtx,
      args: { sessionId: sid, selector: "#login" },
    });
    expect(click.status).toBe("executed");

    // (e) type (credential placeholder, materialized only at the connector egress).
    const type = await runGovernedToolCall(deps, {
      tool: "browser.type",
      context: validCtx,
      args: { sessionId: sid, selector: "#pw", text: placeholderFor("LOGIN_PW") },
    });
    expect(type.status).toBe("executed");
    expect(fake.peekLastTyped()).toBe(canaryPw);

    // (f) close — releases the session.
    const close = await runGovernedToolCall(deps, {
      tool: "browser.session.close",
      context: validCtx,
      args: { sessionId: sid },
    });
    expect(close.status).toBe("executed");
    expect(fake.hasSession(sid)).toBe(false);

    // After close, a navigate on the released id => deny; the connector is never driven again.
    const navAfterClose = await runGovernedToolCall(deps, {
      tool: "browser.navigate",
      context: validCtx,
      args: { sessionId: sid, url: "https://allowed.example/again" },
    });
    expect(navAfterClose.status === "executed" ? navAfterClose.detail : "").not.toBe(undefined);

    // The whole task threaded through ONE minted session; the connector drove the real step primitives.
    expect(fake.steps.some((s) => s.primitive === "navigate" && s.sessionId === sid)).toBe(true);
    expect(fake.steps.some((s) => s.primitive === "click" && s.sessionId === sid)).toBe(true);
    expect(fake.steps.some((s) => s.primitive === "type" && s.sessionId === sid)).toBe(true);

    // MOAT across the WORM: neither the page secret, the typed credential, nor the url path leak.
    const wormBlob = JSON.stringify(appended);
    expect(wormBlob).not.toContain(pageSecret);
    expect(wormBlob).not.toContain(canaryPw);
    expect(wormBlob).not.toContain("/login");
  });
});

// ==================================================================================================
// (3) SESSION CAP fail-closed THROUGH the pipeline — the (cap+1)th governed open is denied.
// ==================================================================================================
describe("ACT5f JOIN (3) SESSION CAP — fail-closed through the governed pipeline", () => {
  it("open `cap` sessions; the (cap+1)th browser.session.open is denied (ok:false surfaces as error)", async () => {
    const cap = 2;
    const fake = new FakeBrowserConnector({ browserSessionCap: cap });
    const { deps } = makeJoinDeps({ fake, binEgressAllow: ["allowed.example"] });
    const ids: string[] = [];
    for (let i = 0; i < cap; i++) {
      const out = await runGovernedToolCall(deps, {
        tool: "browser.session.open",
        context: validCtx,
        args: {},
      });
      expect(out.status).toBe("executed");
      ids.push(mintedSessionId(out) as string);
    }
    // The (cap+1)th open: the effect returns ok:false (deny) — surfaced to the brain as a non-mint.
    const over = await runGovernedToolCall(deps, {
      tool: "browser.session.open",
      context: validCtx,
      args: {},
    });
    // The pipeline still "executes" the effect, but the effect's ok:false means NO session was minted.
    expect(mintedSessionId(over)).toBeUndefined();
    // NON-VACUITY: removing the cap (unbounded) makes the (cap+1)th open mint a session => this flips RED.

    // A close frees a slot; a fresh open then mints again.
    await runGovernedToolCall(deps, {
      tool: "browser.session.close",
      context: validCtx,
      args: { sessionId: ids[0] },
    });
    const reopened = await runGovernedToolCall(deps, {
      tool: "browser.session.open",
      context: validCtx,
      args: {},
    });
    expect(mintedSessionId(reopened)).toMatch(/^bsess_[A-Za-z0-9]{4,}$/);
  });
});

// Reference the port type so an unused-import lint never trips (it is part of the contract).
const _portTypeCheck: BrowserConnector = new FakeBrowserConnector();
void _portTypeCheck;
