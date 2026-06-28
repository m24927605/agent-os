// act5-deny-demo — the DENY-PATH cast: a brain-proposed browser.navigate to a NON-allowlisted host is
// DENIED by the governed pipeline (deny-by-default at the egress fold) BEFORE any effect runs — the
// browser connector is NEVER driven and NOTHING is committed to the WORM. This is the on-camera proof
// that the seatbelt holds: a denied action leaves no trace of an effect because the effect never happens.
//
// It reuses the SAME governed wiring as scripts/act5-live-browser.mjs (real runGovernedToolCall + the
// PDP authorize + the per-navigation egress fold + commit-before-effect), but:
//   • the connector is a SPY (records whether perform/openSession were called) — NO playwright, NO real
//     browser, because the deny happens at authorize, before the connector is ever reached;
//   • navigate targets a host that is NOT in AGENTOS_EGRESS_ALLOW.
// The "success" of THIS demo is the DENY: status denied@policy, connector.perform never called, zero
// WORM appends. Credential-blind: the trace is redactSecrets'd; no value is ever printed.
//
// Run: AGENTOS_EGRESS_ALLOW=example.com pnpm run e2e:deny-demo
//   (override the blocked target with AGENTOS_DENY_DEMO_HOST; default a clearly-non-allowlisted host.)

import { redactSecrets } from "../dist/audit/index.js";
import { InMemoryCostGate } from "../dist/cost/index.js";
import { createBudgetApprover, runGovernedToolCall } from "../dist/orchestration/index.js";
import { combineDecisions, egressDecisionForProjection } from "../dist/policy/index.js";
import { authorizeToolInvoke } from "../dist/tools/index.js";
import { defaultExecSecretDetector } from "../dist/runtime/substrate/index.js";
import {
  bindingWrappedBrowserEffect,
  buildBrowserProjectionForCall,
  seedBrowserBindings,
  seedBrowserRegistry,
} from "../dist/runtime/brain/adapters/hermes/index.js";

// --- (0) The allowlist (the host(s) the browser MAY reach) + the BLOCKED target we will try anyway.
const egressAllow = (process.env.AGENTOS_EGRESS_ALLOW ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter((h) => h.length > 0);
if (egressAllow.length === 0) {
  console.error(
    "act5-deny-demo: SKIP (env not set) — set AGENTOS_EGRESS_ALLOW to the allowed host(s) (e.g. example.com) to run the deny demo",
  );
  process.exit(0);
}
const blockedHost = process.env.AGENTOS_DENY_DEMO_HOST ?? "blocked.not-allowlisted.example";
const blockedUrl = `https://${blockedHost}/`;

// --- (1) A SPY connector: it must NEVER be driven on the deny path. Records every call so we can PROVE it.
let performCalls = 0;
const spy = {
  openSession: () => "bsess_denydemo00000000",
  closeSession: () => {},
  hasSession: () => true,
  perform: (_context, _step) => {
    performCalls += 1; // if this EVER increments on the deny path, the seatbelt FAILED.
    return Promise.resolve({ ok: true, detail: "spy (should never run on a deny)" });
  },
};

// --- (2) The SAME governed wiring as the live browser runner (deny-by-default PDP + per-navigation egress fold).
const WIRED = new Set(["egress-allowlist"]);
const registry = seedBrowserRegistry(WIRED);
const bindings = seedBrowserBindings(WIRED);
const allowRules = [
  { id: "allow-browser", action: "tool:invoke", resource: "browser.**", tenantId: "tenant-live" },
];
const ctx = {
  actorId: "agent:hermes-live",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live",
  requestId: "req-deny-demo",
};
const baseEffect = bindingWrappedBrowserEffect(spy, bindings, {
  detectSecret: defaultExecSecretDetector,
});
const appended = [];
const trace = [];
const deps = {
  screen: (tc) => {
    trace.push({ stage: "screen", detail: `ok: ${tc.tool}` });
    return { ok: true };
  },
  authorize: (tc) => {
    const c = tc.context;
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
    const pdp = authorizeToolInvoke(req, registry, allowRules);
    const containment = registry.lookup(tc.tool)?.containment;
    let egressDecisions = [];
    if (projection !== undefined && projection.networkHosts.length > 0) {
      egressDecisions = [egressDecisionForProjection(projection.networkHosts, egressAllow)];
    } else if (containment === "network-egress") {
      egressDecisions = [
        {
          effect: "deny",
          reason: "egress: network-egress tool with no projectable host — denied (fail-closed)",
          auditRequired: true,
        },
      ];
    }
    const combined = combineDecisions(pdp, egressDecisions);
    const decision = {
      effect: combined.effect,
      reason: redactSecrets(combined.reason),
      requiresApproval: registry.lookup(tc.tool)?.requiresApproval ?? false,
      external: containment === "network-egress" || containment === "host-fs-write",
      ...(projection !== undefined ? { projection } : {}),
    };
    trace.push({
      stage: "authorize",
      detail: decision.effect === "allow" ? "allow; egress folded" : `DENIED@policy — ${decision.reason}`,
    });
    return decision;
  },
  approve: createBudgetApprover(() => false),
  cost: new InMemoryCostGate(1_000_000),
  estimateTokens: () => 10,
  appender: {
    append: (event) => {
      appended.push(event);
      trace.push({ stage: "commit", detail: "WORM append (SHOULD NOT HAPPEN on a deny)" });
      return Promise.resolve({ id: appended.length });
    },
  },
  effect: (tc) => {
    trace.push({ stage: "effect", detail: "connector (SHOULD NOT HAPPEN on a deny)" });
    return baseEffect(tc);
  },
};

// --- (3) Drive a brain-proposed navigate to the BLOCKED (non-allowlisted) host.
console.log("act5-deny-demo: governed deny-by-default demo (no real browser needed — deny precedes the effect)");
console.log(`act5-deny-demo: egress allowlist = ${egressAllow.join(", ")}`);
console.log(`act5-deny-demo: ABOUT TO ATTEMPT navigate -> ${blockedUrl}  (host NOT on the allowlist)`);

const sid = spy.openSession();
const outcome = await runGovernedToolCall(deps, {
  tool: "browser.navigate",
  context: ctx,
  args: { sessionId: sid, url: blockedUrl },
});
trace.push({ stage: "navigate.outcome", detail: `${outcome.status}${outcome.stage ? `@${outcome.stage}` : ""}` });

// --- (4) Print the trace (redacted).
console.log("act5-deny-demo: governance trace —");
for (const step of trace) {
  console.log(`  [${step.stage}] ${redactSecrets(step.detail)}`);
}

// --- (5) Verdict. The DENY is the success: denied at policy, connector NEVER driven, ZERO WORM appends.
const denied = outcome.status === "denied";
const connectorUntouched = performCalls === 0;
const nothingCommitted = appended.length === 0;
if (denied && connectorUntouched && nothingCommitted) {
  console.log(
    `act5-deny-demo: DENIED ok — deny-by-default held: navigate to ${blockedHost} was denied@${outcome.stage}; ` +
      "the browser connector was NEVER driven (perform calls=0) and NOTHING was committed to the WORM. " +
      "No effect happened, so there is nothing to undo.",
  );
  process.exit(0);
}
// If we get here, a non-allowlisted host got past the gate — that would be a seatbelt FAILURE.
console.error(
  `act5-deny-demo: LEAK — deny-by-default FAILED: status=${outcome.status} performCalls=${performCalls} ` +
    `appends=${appended.length} (expected denied / 0 / 0)`,
);
process.exit(1);
