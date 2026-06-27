/**
 * SLICE-ACT5c (RED-first) — the END-TO-END JOIN for browser.click + browser.type through the REAL
 * `runGovernedToolCall` (real screen / authorize-fold / APPROVAL stage / commit-before-effect / boundary)
 * with a FakeBrowserConnector as `deps.effect = bindingWrappedBrowserEffect(fake, browserBindings)`.
 *
 * ⚠️ ZERO change to the pipeline OR the production bin. The JOIN harness reconstructs the bin's
 * authorize-fold + the approval wiring IN THIS TEST, exactly as browser-join.test.ts / action-join.test.ts
 * do for the read/action families — parallel and isolated. NO real browser / network / ~/.env.
 *
 * The properties proven end-to-end (the ACT5c invariants):
 *   1. DESTRUCTIVE => APPROVAL (per-step, ⚠️ CORE): click/type are sideEffect:"destructive" =>
 *      requiresApproval:true (superRefine-forced). With NO pre-auth (deny-all approver) => denied@approval,
 *      the Fake's `perform` is NEVER called. Pre-authorized => proceeds to the connector.
 *      NON-VACUITY: forcing requiresApproval off in the authorize decision (bypassing the gate) makes the
 *      no-pre-auth click EXECUTE — the deny test FLIPS RED.
 *   2. TYPE CREDENTIAL-BLIND (⚠️ CORE): a `text` PLACEHOLDER (`openshell:resolve:env:KEY`) + a RUNTIME
 *      canary in env + pre-auth => the connector resolves it at egress; the canary appears ONLY at the
 *      connector (peekLastTyped) and in NEITHER the brain result NOR the WORM trace (only the placeholder).
 *      A LITERAL secret-shaped `text` => the INPUT guard DENIES (the connector is NEVER called).
 *   3. SELECTOR/TEXT STRICT: a smuggled extra key => deny; the connector is never called.
 *   4. SESSION NOT EXPOSED + COMMIT-BEFORE-EFFECT + BOUNDARY.
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

/** click/type are destructive => need the APPROVAL primitive wired (egress-allowlist opens the family). */
const BROWSER_WIRED = new Set(["egress-allowlist", "approval"] as const);

/** The credential placeholder grammar the connector resolves at egress. */
function placeholderFor(key: string): string {
  return `openshell:resolve:env:${key}`;
}

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
 * Build the JOIN deps over the REAL pipeline for the destructive BROWSER primitives: PDP
 * `authorizeToolInvoke` (deny-by-default) + the egress fold (click/type are in-sandbox => no host) +
 * the APPROVAL flag read FROM THE MANIFEST (so the destructive primitives fire the approval stage) +
 * `createBudgetApprover(preAuth)`. The `effect` is `bindingWrappedBrowserEffect(fake, bindings)`.
 *
 * `forceApprovalOff` is the NON-VACUITY knob: it overrides the authorize decision's requiresApproval to
 * `false` (bypassing the approval gate) — the no-pre-auth click then EXECUTES, flipping the deny test RED.
 */
function makeJoinDeps(opts: {
  fake: FakeBrowserConnector;
  preAuth?: readonly string[];
  appenderKit?: AppenderKit;
  forceApprovalOff?: boolean;
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
        egressDecisions = [egressDecisionForProjection(projection.networkHosts, [])];
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
      const manifestApproval = registry.lookup(tc.tool)?.requiresApproval ?? false;
      const decision: AuthorizeDecision = {
        effect: combined.effect,
        reason: redactSecrets(combined.reason),
        requiresApproval: opts.forceApprovalOff ? false : manifestApproval,
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
// (1) DESTRUCTIVE => APPROVAL (per-step, ⚠️ CORE) — no pre-auth => denied@approval; Fake NEVER called.
// ==================================================================================================
describe("ACT5c JOIN (1) DESTRUCTIVE => APPROVAL — per-step approval gate; Fake never called without pre-auth", () => {
  it("browser.click with NO pre-auth (deny-all approver) => denied@approval; Fake NEVER clicks", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const { deps } = makeJoinDeps({ fake, preAuth: [] });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.click",
      context: validCtx,
      args: { sessionId: sid, selector: "#submit" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("approval");
    expect(fake.steps.length).toBe(0);
  });

  it("browser.type with NO pre-auth => denied@approval; Fake NEVER types", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const { deps } = makeJoinDeps({ fake, preAuth: [] });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.type",
      context: validCtx,
      args: { sessionId: sid, selector: "#name", text: "Alice" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("approval");
    expect(fake.steps.length).toBe(0);
  });

  it("PRE-AUTHORIZED browser.click => proceeds to the effect; Fake clicks once", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const { deps } = makeJoinDeps({ fake, preAuth: ["browser.click"] });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.click",
      context: validCtx,
      args: { sessionId: sid, selector: "#submit" },
    });
    expect(out.status).toBe("executed");
    expect(fake.steps.length).toBe(1);
    expect(fake.steps[0]?.primitive).toBe("click");
  });

  it("PRE-AUTHORIZED browser.type => proceeds to the effect; Fake types once", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const { deps } = makeJoinDeps({ fake, preAuth: ["browser.type"] });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.type",
      context: validCtx,
      args: { sessionId: sid, selector: "#name", text: "Alice" },
    });
    expect(out.status).toBe("executed");
    expect(fake.steps.length).toBe(1);
    expect(fake.steps[0]?.primitive).toBe("type");
  });

  it("⚠️ NON-VACUITY: forcing requiresApproval OFF makes the NO-pre-auth click EXECUTE (the gate test would flip RED)", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const { deps } = makeJoinDeps({ fake, preAuth: [], forceApprovalOff: true });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.click",
      context: validCtx,
      args: { sessionId: sid, selector: "#submit" },
    });
    // With the approval gate bypassed, the destructive click EXECUTES even with no pre-auth — this proves
    // the approval gate is the ONLY thing stopping it in the deny test above (non-vacuous).
    expect(out.status).toBe("executed");
    expect(fake.steps.length).toBe(1);
  });
});

// ==================================================================================================
// (2) TYPE CREDENTIAL-BLIND (⚠️ CORE) — placeholder egress-resolved; literal secret denied; resolved
//     value never in brain/WORM/projection/trace.
// ==================================================================================================
describe("ACT5c JOIN (2) TYPE CREDENTIAL-BLIND — placeholder egress-resolved; resolved value never leaks", () => {
  it("type text=PLACEHOLDER + env canary + pre-auth => connector resolves at egress; canary in NEITHER result NOR WORM (only the placeholder)", async () => {
    const canary = `runtime-pw-${Math.random().toString(36).slice(2)}`;
    const fake = new FakeBrowserConnector({ env: { LOGIN_PW: canary } });
    const sid = fake.openSession();
    const appenderKit = makeAppender();
    const { deps, appended } = makeJoinDeps({
      fake,
      preAuth: ["browser.type"],
      appenderKit,
    });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.type",
      context: validCtx,
      args: { sessionId: sid, selector: "#pw", text: placeholderFor("LOGIN_PW") },
    });
    expect(out.status).toBe("executed");
    // The connector typed the RESOLVED value at egress (the actor's value).
    expect(fake.peekLastTyped()).toBe(canary);
    // ⚠️ The resolved canary appears in NEITHER the brain-visible result NOR the WORM trace.
    const resultBlob = JSON.stringify(out);
    const wormBlob = JSON.stringify(appended);
    expect(resultBlob).not.toContain(canary);
    expect(wormBlob).not.toContain(canary);
    // Only the placeholder ever crossed the brain/WORM (and the projection carries NO params at all).
    expect(wormBlob).not.toContain(placeholderFor("LOGIN_PW")); // boundary summary carries no params
    // NON-VACUITY: leaking the resolved value onto the result, OR resolving it before the input guard,
    // FLIPS the `resultBlob`/`wormBlob` assertions RED.
  });

  it("type text=LITERAL secret => denied (INPUT guard); Fake NEVER types", async () => {
    const fake = new FakeBrowserConnector({ env: { LOGIN_PW: "irrelevant" } });
    const sid = fake.openSession();
    const { deps } = makeJoinDeps({ fake, preAuth: ["browser.type"] });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.type",
      context: validCtx,
      args: { sessionId: sid, selector: "#pw", text: skCanary() },
    });
    expect(fake.steps.length).toBe(0);
    expect(fake.peekLastTyped()).toBeUndefined();
    if (out.status === "executed") {
      expect(out.detail).toContain("credential-blind");
    }
  });
});

// ==================================================================================================
// (3) SELECTOR/TEXT STRICT — a smuggled extra key => deny; the connector is never called.
// ==================================================================================================
describe("ACT5c JOIN (3) STRICT — a smuggled extra key on click/type => deny; Fake never called", () => {
  it("click with an extra key => denied; Fake never clicks", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const { deps } = makeJoinDeps({ fake, preAuth: ["browser.click"] });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.click",
      context: validCtx,
      args: { sessionId: sid, selector: "#x", extra: "smuggled" },
    });
    // The strict-schema deny is inside the effect (post-commit): the Fake is NEVER called, and the
    // executed-path detail reports the deny (the connector received no step).
    expect(fake.steps.length).toBe(0);
    if (out.status === "executed") expect(out.detail).toContain("deny");
  });
});

// ==================================================================================================
// (4) SESSION NOT EXPOSED + COMMIT-BEFORE-EFFECT — the handle/cookie never leak; append precedes effect.
// ==================================================================================================
describe("ACT5c JOIN (4) SESSION NOT EXPOSED + COMMIT-BEFORE-EFFECT", () => {
  it("a pre-authorized click: the Fake's cookie does not appear in the result OR the WORM; append precedes effect", async () => {
    const cookie = `cookie-${Math.random().toString(36).slice(2)}`;
    const fake = new FakeBrowserConnector({ cookieSecret: cookie });
    const sid = fake.openSession();
    const order: string[] = [];
    const appenderKit = makeAppender({ order });
    const { deps, appended } = makeJoinDeps({
      fake,
      preAuth: ["browser.click"],
      appenderKit,
    });
    const out = await runGovernedToolCall(deps, {
      tool: "browser.click",
      context: validCtx,
      args: { sessionId: sid, selector: "#submit" },
    });
    expect(out.status).toBe("executed");
    expect(JSON.stringify([out])).not.toContain(cookie);
    expect(JSON.stringify(appended)).not.toContain(cookie);
    // commit-before-effect: the first append precedes the first effect.
    expect(order.indexOf("append")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("append")).toBeLessThan(order.indexOf("effect"));
  });
});

// Reference the port type so an unused-import lint never trips (it is part of the contract).
const _portTypeCheck: BrowserConnector = new FakeBrowserConnector();
void _portTypeCheck;
