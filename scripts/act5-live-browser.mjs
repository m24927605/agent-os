#!/usr/bin/env node
// SLICE-ACT5d-live operator driver. Invoked by scripts/e2e-live-browser.sh ONLY when the operator has
// opted in (AGENTOS_EGRESS_ALLOW set). It drives the REAL governed browser pipeline (the SAME
// runGovernedToolCall + the browser-join authorize fold + commit-before-effect + boundary) against a
// REAL headless browser: session.open -> browser.navigate(<first allowlist host>) -> browser.read ->
// session.close. It prints the governance trace + the SANITIZED read content + a SENT/NOT verdict.
//
// ⚠️ ZERO-NEW-DEP / BROWSER-FREE-AT-VERIFY: the real browser library is DYNAMIC-imported HERE (never a
// package.json dependency); if it is absent we fail-closed (exit 2) and run NOTHING. The TS connector
// (createBrowserConnectorOverPage) is browser-free; this .mjs is the operator's live-drive install.
//
// ⚠️ substrate-PRIMARY egress (the REAL network boundary): the browser context route-intercepts EVERY
// request and ABORTS any host not in AGENTOS_EGRESS_ALLOW (route.abort) — the in-repo egress fold says
// "substrate is primary"; THIS is that primary line at the browser, stronger than a PDP projection.
//
// ⚠️ NEVER prints a credential or raw un-sanitized content; the trace is redactSecrets'd. navigate/read
// are READS (benign, no approval/credential) against a public page — runtime-direct, operator-authorized.
// Imports the COMPILED dist (the .sh runs build first).

import { redactSecrets } from "../dist/audit/index.js";
import { InMemoryCostGate } from "../dist/cost/index.js";
import {
  createBudgetApprover,
  runGovernedToolCall,
} from "../dist/orchestration/index.js";
import { combineDecisions, egressDecisionForProjection } from "../dist/policy/index.js";
import { authorizeToolInvoke } from "../dist/tools/index.js";
import { defaultExecSecretDetector } from "../dist/runtime/substrate/index.js";
import {
  bindingWrappedBrowserEffect,
  buildBrowserProjectionForCall,
  createBrowserConnectorOverPage,
  seedBrowserBindings,
  seedBrowserRegistry,
} from "../dist/runtime/brain/adapters/hermes/index.js";

// --- (0) FAIL-CLOSED env gate. AGENTOS_EGRESS_ALLOW must be set (the .sh already gates this; we re-check
// fail-closed so the .mjs is safe if run directly). The allowlist is the host(s) the browser may reach.
const egressAllow = (process.env.AGENTOS_EGRESS_ALLOW ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
if (egressAllow.length === 0) {
  console.error(
    "act5-live-browser: BLOCKED — AGENTOS_EGRESS_ALLOW not set (set it to the host(s) the browser may reach)",
  );
  process.exit(2);
}

// --- (1) FAIL-CLOSED: dynamic-import the real browser library. Absent => print the install hint + exit
// non-zero; run NOTHING (no real browser). This is the ONLY place the library is named.
const pw = await import("playwright").catch(() => null);
if (!pw) {
  console.error(
    "act5-live-browser: BLOCKED — playwright not installed (install it for the live browser drive: `pnpm add -D playwright && pnpm exec playwright install chromium`)",
  );
  process.exit(2);
}

console.log(
  "act5-live-browser: governed live browser drive (runtime-direct; credential-blind to brain/audit)",
);
console.log(`act5-live-browser: egress allowlist = ${egressAllow.join(", ")}`);

// --- (2) Launch the real headless browser + a context with substrate-PRIMARY egress: route-intercept
// EVERY request and ABORT any host not on the allowlist (the real network boundary at the browser).
const browser = await pw.chromium.launch();
const context = await browser.newContext();
await context.route("**/*", (route) => {
  let host = "";
  try {
    host = new URL(route.request().url()).hostname;
  } catch {
    host = "";
  }
  if (host.length > 0 && egressAllow.includes(host)) {
    route.continue();
  } else {
    // substrate-PRIMARY: a non-allowlisted host is ABORTED at the browser (not merely PDP-projected).
    route.abort();
  }
});
const pwPage = await context.newPage();

// --- (3) Adapt the real browser page to the STRUCTURAL BrowserPage the TS connector drives. The adapter
// is the ONLY browser-aware shim; the connector + the governed pipeline stay browser-free.
const adaptedPage = {
  goto: async (url) => {
    await pwPage.goto(url, { waitUntil: "domcontentloaded" });
  },
  // content: prefer the visible text (innerText of <body>) so the read is human-page text, not raw HTML.
  content: async (selector) => {
    if (typeof selector === "string" && selector.length > 0) {
      return await pwPage.innerText(selector);
    }
    return await pwPage.innerText("body");
  },
  click: async (selector) => {
    await pwPage.click(selector);
  },
  fill: async (selector, text) => {
    await pwPage.fill(selector, text);
  },
  close: async () => {
    await context.close();
  },
};

// --- (4) Wire the FULL governed pipeline over the page-backed connector (the browser-join harness shape):
// real runGovernedToolCall + PDP authorizeToolInvoke (deny-by-default) + the per-navigation egress fold
// (deny-all default) + CAP6 fail-closed + external-on-network-egress for the boundary; the effect is
// bindingWrappedBrowserEffect(connector, bindings) (the read data-OUT sanitizer + the credential-blind
// input guard live there). The connector resolves a `type` placeholder at egress against process.env
// (not used in this benign navigate+read demo; wired for parity with the credential-blind path).
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
  requestId: "req-live-browser",
};

const connector = createBrowserConnectorOverPage(adaptedPage, { env: process.env });
const baseEffect = bindingWrappedBrowserEffect(connector, bindings, {
  detectSecret: defaultExecSecretDetector,
});

const appended = [];
const trace = [];
const approve = createBudgetApprover(() => false); // navigate/read are reads => no approval needed.

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
    let egressDecisions;
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
    } else {
      egressDecisions = [];
    }
    const combined = combineDecisions(pdp, egressDecisions);
    const decision = {
      effect: combined.effect,
      reason: redactSecrets(combined.reason),
      requiresApproval: registry.lookup(tc.tool)?.requiresApproval ?? false,
      external: containment === "network-egress" || containment === "host-fs-write",
      ...(projection !== undefined ? { projection } : {}),
    };
    trace.push({ stage: "authorize", detail: `${decision.effect}; egress folded` });
    return decision;
  },
  approve,
  cost: new InMemoryCostGate(1_000_000),
  estimateTokens: () => 10,
  appender: {
    append: (event) => {
      appended.push(event);
      trace.push({ stage: "commit", detail: "WORM append (intent / boundary)" });
      return Promise.resolve({ id: appended.length });
    },
  },
  effect: (tc) => {
    trace.push({ stage: "effect", detail: "page connector (real browser; egress route-abort primary)" });
    return baseEffect(tc);
  },
};

// --- (5) Run the governed sequence: open -> navigate(first allowlist host as https) -> read -> close.
const sid = connector.openSession();
const targetHost = egressAllow[0];
const targetUrl = `https://${targetHost}/`;
console.log(`act5-live-browser: ABOUT TO DRIVE navigate -> read on https://${targetHost}/ (benign read)`);

const navOutcome = await runGovernedToolCall(deps, {
  tool: "browser.navigate",
  context: ctx,
  args: { sessionId: sid, url: targetUrl },
});
trace.push({ stage: "navigate.outcome", detail: navOutcome.status });

const readOutcome = await runGovernedToolCall(deps, {
  tool: "browser.read",
  context: ctx,
  args: { sessionId: sid },
});
trace.push({ stage: "read.outcome", detail: readOutcome.status });

connector.closeSession(sid);
await browser.close();

// --- (6) Print the governance trace — each stage, redacted (never a credential / raw content).
console.log("act5-live-browser: governance trace —");
for (const step of trace) {
  console.log(`  [${step.stage}] ${redactSecrets(step.detail)}`);
}

// --- (7) HONEST verdict. navigate executed => the egress fold + route-interception permitted the host;
// read executed => the SANITIZED page content reached the brain (out.detail = the sanitized shape:
// redacted + bounded + untrusted). We print the SANITIZED detail (already redacted by the effect; we
// redactSecrets again defensively) — NEVER raw page content.
const navSent = navOutcome.status === "executed";
const readSent = readOutcome.status === "executed";
const sanitizedRead =
  readOutcome.status === "executed" ? (readOutcome.detail ?? "") : `denied@${readOutcome.stage}`;

if (navSent && readSent) {
  console.log(
    `act5-live-browser: SENT ok — governed navigate+read executed on ${targetHost} (egress route-abort primary)`,
  );
  console.log(`act5-live-browser: SANITIZED read content = ${redactSecrets(sanitizedRead)}`);
  process.exit(0);
}

// NOT executed (a pipeline-level deny: policy/egress/commit). Report the fixed, redacted reason; exit non-zero.
const navLabel = navSent ? "navigate executed" : `navigate denied@${navOutcome.stage}`;
const readLabel = readSent ? "read executed" : `read denied@${readOutcome.stage}`;
console.error(`act5-live-browser: NOT EXECUTED — ${redactSecrets(`${navLabel}; ${readLabel}`)}`);
process.exit(1);
