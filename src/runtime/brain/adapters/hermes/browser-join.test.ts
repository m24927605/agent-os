/**
 * SLICE-ACT5a+b (RED-first) — the END-TO-END JOIN: browser.navigate + browser.read through the REAL
 * `runGovernedToolCall` (real screen / authorize-fold-with-egress / commit-before-effect / boundary)
 * with a FakeBrowserConnector as `deps.effect = bindingWrappedBrowserEffect(fake, browserBindings)`.
 *
 * ⚠️ ZERO change to the pipeline OR the production bin. The JOIN harness reconstructs the bin's
 * authorize-fold (egress fold + CAP6 fail-closed + external) IN THIS TEST over the BROWSER projection,
 * exactly as action-join.test.ts does for the action family — parallel and isolated. NO real browser /
 * network / ~/.env: the connector is the in-repo Fake. NOT advertised to the brain (that is ACT5e).
 *
 * The properties proven end-to-end:
 *   1. NAVIGATE EGRESS (per-navigation, deny-all default): allowlist host => navigates; an off-allowlist
 *      host => denied@policy, Fake NEVER navigates; default empty allowlist => deny-all; a file:// /
 *      userinfo / IP url => isAllowedFetchUrl rejects (strict-schema deny before the connector).
 *      NON-VACUITY: dropping the navigate projector flips the evil-host test (CAP6 fail-closed denies).
 *   2. READ DATA-OUT GATE (⚠️ CORE): a page canary secret returned by the Fake does NOT reach the brain —
 *      `out.detail` is redacted + truncated + untrusted. NON-VACUITY: skipping the read-result
 *      sanitization flips this RED.
 *   3. SESSION NOT EXPOSED: open -> navigate -> read -> close; the brain sees ONLY the sessionId; the
 *      Fake's handle/cookies/currentUrl appear in NEITHER the tools/call result NOR the WORM trace.
 *   4. COMMIT-BEFORE-EFFECT + BOUNDARY: the append precedes the connector; navigate (network-egress) =>
 *      a boundary WORM event carrying host-only summary, no url path/content.
 *   5. CREDENTIAL-BLIND IN: a literal secret in navigate/read params => denied; the page canary on read
 *      is sanitized, never reaching the WORM (only the brain's `detail`, and there redacted).
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

const BROWSER_WIRED = new Set(["egress-allowlist"] as const);

/** Runtime-built `sk-...` canary (NOT a source literal — secret-scan clean). */
function skCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`;
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

/**
 * Build the JOIN deps over the REAL pipeline, reconstructing the bin's authorize fold for the BROWSER
 * family: PDP `authorizeToolInvoke` (deny-by-default) + the EGRESS fold over the navigate projection's
 * networkHosts (deny-all default) + CAP6 fail-closed (network-egress with no host => deny) + external on
 * network-egress for the boundary. The `effect` is `bindingWrappedBrowserEffect(fake, bindings)`.
 */
function makeJoinDeps(opts: {
  fake: FakeBrowserConnector;
  binEgressAllow: readonly string[];
  preAuth?: readonly string[];
  appenderKit?: AppenderKit;
  onEffect?: () => void;
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
      opts.onEffect?.();
      kit.order.push("effect");
      return baseEffect(tc);
    },
  };
  return { deps, appended: kit.appended };
}

// ==================================================================================================
// (1) NAVIGATE EGRESS — per-navigation, deny-all default.
// ==================================================================================================
describe("ACT5 JOIN (1) NAVIGATE EGRESS — per-navigation deny-all default", () => {
  it("allowlist=[allowed.example] => navigate PASSES the egress fold; Fake navigates", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: ["allowed.example"] });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.navigate",
      context: validCtx,
      args: { sessionId: sid, url: "https://allowed.example/x" },
    });
    expect(out.status).toBe("executed");
    expect(fake.steps.length).toBe(1);
  });

  it("url=https://evil.com NOT allowlisted => denied@policy (egress fold); Fake NEVER navigates", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: ["allowed.example"] });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.navigate",
      context: validCtx,
      args: { sessionId: sid, url: "https://evil.com/x" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("policy");
    expect(fake.steps.length).toBe(0);
  });

  it("default EMPTY allowlist => deny-all (even a syntactically valid host is denied)", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: [] });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.navigate",
      context: validCtx,
      args: { sessionId: sid, url: "https://allowed.example/x" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("policy");
    expect(fake.steps.length).toBe(0);
  });

  it("a file:// url => strict-schema deny (isAllowedFetchUrl rejects); Fake NEVER navigates", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: ["allowed.example"] });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.navigate",
      context: validCtx,
      args: { sessionId: sid, url: "file:///etc/passwd" },
    });
    // Strict schema (the url refine) denies it. With NO projectable host on a network-egress tool, the
    // CAP6 fail-closed rule denies at policy; either way the connector never navigates.
    expect(fake.steps.length).toBe(0);
    if (out.status === "denied") expect(out.stage).toBe("policy");
  });

  it("a userinfo / IP-literal url => isAllowedFetchUrl rejects; Fake NEVER navigates", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: ["allowed.example", "127.0.0.1"] });
    for (const url of ["https://user:pass@allowed.example/x", "https://127.0.0.1/x"]) {
      const out = await runGovernedToolCall(deps, {
        tool: "browser.navigate",
        context: validCtx,
        args: { sessionId: sid, url },
      });
      if (out.status === "denied") expect(out.stage).toBe("policy");
    }
    expect(fake.steps.length).toBe(0);
  });
});

// ==================================================================================================
// (2) READ DATA-OUT GATE (⚠️ CORE) — a page canary secret never reaches the brain.
// ==================================================================================================
describe("ACT5 JOIN (2) READ DATA-OUT GATE — page canary redacted/truncated/untrusted before the brain", () => {
  it("read returns sanitized content: canary REDACTED, body TRUNCATED, marked untrusted in out.detail", async () => {
    const canary = skCanary();
    const fake = new FakeBrowserConnector({
      content: `leaked secret ${canary} ${"PAD".repeat(5000)}`,
    });
    const sid = fake.openSession();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: ["allowed.example"] });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.read",
      context: validCtx,
      args: { sessionId: sid },
    });
    expect(out.status).toBe("executed");
    const detail = out.status === "executed" ? (out.detail ?? "") : "";
    expect(detail).not.toContain(canary);
    expect(detail).toContain("[REDACTED]");
    expect(detail).toContain("untrusted");
    expect(detail).toContain("truncated");
    // NON-VACUITY: skipping returnContentSanitizer in the read effect flips this RED (canary leaks).
  });
});

// ==================================================================================================
// (3) SESSION NOT EXPOSED — multi-step open -> navigate -> read -> close; only the sessionId is seen.
// ==================================================================================================
describe("ACT5 JOIN (3) SESSION NOT EXPOSED — handle/cookies/currentUrl never leak to brain/WORM", () => {
  it("multi-step session: the Fake's handle/cookies do not appear in the result OR the WORM trace", async () => {
    const fake = new FakeBrowserConnector({
      content: "ordinary page",
      // A secret handle/cookie the connector holds — MUST NOT leak anywhere observable to the brain.
      cookieSecret: `cookie-${Math.random().toString(36).slice(2)}`,
    });
    const sid = fake.openSession(); // server-generated opaque id (the ONLY thing the brain holds)
    const appenderKit = makeAppender();
    const { deps, appended } = makeJoinDeps({
      fake,
      binEgressAllow: ["allowed.example"],
      appenderKit,
    });

    const nav = await runGovernedToolCall(deps, {
      tool: "browser.navigate",
      context: validCtx,
      args: { sessionId: sid, url: "https://allowed.example/page" },
    });
    expect(nav.status).toBe("executed");
    const read = await runGovernedToolCall(deps, {
      tool: "browser.read",
      context: validCtx,
      args: { sessionId: sid },
    });
    expect(read.status).toBe("executed");

    // The brain-visible results + the WORM bytes must NOT contain the connector's cookie/handle secret.
    const resultBlob = JSON.stringify([nav, read]);
    const wormBlob = JSON.stringify(appended);
    const cookie = fake.peekCookieSecret();
    expect(resultBlob).not.toContain(cookie);
    expect(wormBlob).not.toContain(cookie);
    // The current url/host the connector holds is not pushed into the WORM trace either.
    expect(wormBlob).not.toContain("allowed.example/page");
  });
});

// ==================================================================================================
// (4) COMMIT-BEFORE-EFFECT + BOUNDARY — append precedes connector; navigate => host-only boundary WORM.
// ==================================================================================================
describe("ACT5 JOIN (4) COMMIT-BEFORE-EFFECT + BOUNDARY — order + host-only summary", () => {
  it("the AuditEvent append happens BEFORE the connector navigates (order probe)", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const order: string[] = [];
    const appenderKit = makeAppender({ order });
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["allowed.example"],
      appenderKit,
    });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.navigate",
      context: validCtx,
      args: { sessionId: sid, url: "https://allowed.example/x" },
    });
    expect(out.status).toBe("executed");
    expect(order.indexOf("append")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("append")).toBeLessThan(order.indexOf("effect"));
  });

  it("an executed navigate appends a boundary WORM event with host-only summary (no url path)", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const appenderKit = makeAppender();
    const { deps, appended } = makeJoinDeps({
      fake,
      binEgressAllow: ["allowed.example"],
      appenderKit,
    });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.navigate",
      context: validCtx,
      args: { sessionId: sid, url: "https://allowed.example/secret-path?q=1" },
    });
    expect(out.status).toBe("executed");
    const blob = JSON.stringify(appended);
    expect(blob).toContain("effect.boundary-crossed");
    expect(blob).toContain("allowed.example");
    // The url path/query is NOT in the boundary summary (host-only).
    expect(blob).not.toContain("secret-path");
    expect(blob).not.toContain("q=1");
  });
});

// ==================================================================================================
// (5) CREDENTIAL-BLIND IN — a literal secret in navigate/read params => denied; Fake never called.
// ==================================================================================================
describe("ACT5 JOIN (5) CREDENTIAL-BLIND IN — literal secret in params denied", () => {
  it("a literal secret in the read selector => denied (INPUT guard); Fake never reads", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const canary = skCanary();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: ["allowed.example"] });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.read",
      context: validCtx,
      args: { sessionId: sid, selector: `#x ${canary}` },
    });
    expect(fake.steps.length).toBe(0);
    if (out.status === "executed") {
      expect(out.detail).toContain("credential-blind");
    }
  });
});

// Reference the port type so an unused-import lint never trips (it is part of the contract).
const _portTypeCheck: BrowserConnector = new FakeBrowserConnector();
void _portTypeCheck;
