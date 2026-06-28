// act-gmail-deny-demo — the GMAIL DENY-PATH cast: a brain-proposed gmail.send (a DESTRUCTIVE action) is
// DENIED at the approval gate because it was NOT pre-authorized — BEFORE any effect. The Google connector
// is NEVER driven, nothing is committed to the WORM, and NO email is sent. This is the Gmail counterpart
// to scripts/act5-deny-demo.mjs (browser), and the deny-side of scripts/act-live-gmail.mjs (the send).
//
// It reuses the SAME governed wiring as the action-join harness (real runGovernedToolCall + PDP authorize
// + the egress fold + the manifest-driven requiresApproval + commit-before-effect), but:
//   • egress is allowed for gmail's host (so the deny is ISOLATED at APPROVAL, not egress);
//   • the approver DENIES (createBudgetApprover(() => false) — nothing is pre-authorized);
//   • the ActionConnector is a SPY (records whether perform was called) — NO token, NO real send,
//     because gmail.send (destructive) is denied at approval before the connector is ever reached.
// The "success" of THIS demo is the deny: status denied@approval, connector.perform = 0, zero WORM
// appends, no email. Credential-blind: no token is needed or used; the trace is redactSecrets'd.
//
// Run: pnpm run e2e:gmail-deny-demo   (no env / token required — the deny precedes the egress boundary.)

import { redactSecrets } from "../dist/audit/index.js";
import { InMemoryCostGate } from "../dist/cost/index.js";
import { createBudgetApprover, runGovernedToolCall } from "../dist/orchestration/index.js";
import { combineDecisions, egressDecisionForProjection } from "../dist/policy/index.js";
import { authorizeToolInvoke } from "../dist/tools/index.js";
import { defaultExecSecretDetector } from "../dist/runtime/substrate/index.js";
import {
  bindingWrappedActionEffect,
  buildActionProjectionForCall,
  seedActionBindings,
  seedActionRegistry,
} from "../dist/runtime/brain/adapters/hermes/index.js";

// --- (1) A SPY ActionConnector: it must NEVER be driven on the deny path. Records every call so we PROVE it.
let performCalls = 0;
const spy = {
  perform: (_context, _descriptor) => {
    performCalls += 1; // if this EVER increments on the deny path, the seatbelt FAILED.
    return Promise.resolve({ ok: true, detail: "spy (should never run on a deny)" });
  },
};

// --- (2) The SAME governed wiring as the action-join harness. Both primitives wired so gmail.send REGISTERS
// (egress-allowlist + approval); egress ALLOWS gmail's host so the deny is isolated at APPROVAL.
const ACTION_WIRED = new Set(["egress-allowlist", "approval"]);
const registry = seedActionRegistry(ACTION_WIRED);
const bindings = seedActionBindings(ACTION_WIRED);
const egressAllow = ["gmail.googleapis.com"]; // egress PASSES => the deny is purely the approval gate.
const allowRules = [
  { id: "allow-gmail", action: "tool:invoke", resource: "gmail.**", tenantId: "tenant-live" },
];
const ctx = {
  actorId: "agent:hermes-live",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live",
  requestId: "req-gmail-deny-demo",
};
const baseEffect = bindingWrappedActionEffect(spy, bindings, { detectSecret: defaultExecSecretDetector });
const appended = [];
const trace = [];

// The DENYING approver: nothing is pre-authorized => a destructive gmail.send is denied@approval.
const approve = createBudgetApprover(() => false);

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
    const projection = buildActionProjectionForCall(
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
    const requiresApproval = registry.lookup(tc.tool)?.requiresApproval ?? false;
    const decision = {
      effect: combined.effect,
      reason: redactSecrets(combined.reason),
      requiresApproval,
      external: containment === "network-egress" || containment === "host-fs-write",
      ...(projection !== undefined ? { projection } : {}),
    };
    trace.push({
      stage: "authorize",
      detail: `${decision.effect}; egress folded; requiresApproval=${requiresApproval}`,
    });
    return decision;
  },
  approve,
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

// --- (3) Drive a brain-proposed gmail.send WITHOUT pre-authorization.
console.log("act-gmail-deny-demo: governed approval deny-by-default demo (no token needed — deny precedes egress)");
console.log("act-gmail-deny-demo: egress allowlist = gmail.googleapis.com (so the deny is the APPROVAL gate, not egress)");
console.log("act-gmail-deny-demo: ABOUT TO ATTEMPT gmail.send WITHOUT pre-authorization (a destructive action)");

const outcome = await runGovernedToolCall(deps, {
  tool: "gmail.send",
  context: ctx,
  args: { to: "mrfed1913@gmail.com", subject: "agent-os deny demo (should NOT send)", body: "n/a" },
});
trace.push({ stage: "outcome", detail: `${outcome.status}${outcome.stage ? `@${outcome.stage}` : ""}` });

// --- (4) Print the trace (redacted).
console.log("act-gmail-deny-demo: governance trace —");
for (const step of trace) {
  console.log(`  [${step.stage}] ${redactSecrets(step.detail)}`);
}

// --- (5) Verdict. The DENY is the success: denied@approval, connector NEVER driven, ZERO WORM appends, NO email.
const deniedAtApproval = outcome.status === "denied" && outcome.stage === "approval";
const connectorUntouched = performCalls === 0;
const nothingCommitted = appended.length === 0;
if (deniedAtApproval && connectorUntouched && nothingCommitted) {
  console.log(
    "act-gmail-deny-demo: DENIED ok — deny-by-default held: a destructive gmail.send with NO pre-authorization " +
      "was denied@approval; the Google connector was NEVER driven (perform calls=0), NOTHING was committed to the " +
      "WORM, and NO email was sent. The approval gate stopped it before any effect.",
  );
  process.exit(0);
}
console.error(
  `act-gmail-deny-demo: LEAK — deny-by-default FAILED: status=${outcome.status}@${outcome.stage} ` +
    `performCalls=${performCalls} appends=${appended.length} (expected denied@approval / 0 / 0)`,
);
process.exit(1);
