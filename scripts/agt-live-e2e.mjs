#!/usr/bin/env node
// e2e:live-agt operator driver (SLICE-R9c). Invoked by scripts/e2e-live-agt.sh ONLY when the operator
// has opted in (AGENTOS_LIVE_AGT=1 + AGT_UDS_PATH pointing at a LISTENING AGT sidecar socket).
//
// It exercises the REAL AGT path over the REAL gRPC-over-UDS transport against the operator's live
// Python AGT sidecar (examples/agt-reference-sidecar/ is a reference impl): build the AGT advisory
// secondary, run it through the SAME `evaluateSecondaries` + `combineDecisions` the authorize closures
// use, and assert:
//   (1) a benign exec.run projection  -> AGT allow  -> combineDecisions(allowPdp, [agt]) = ALLOW;
//   (2) a destructive exec.run projection (rm -rf) -> AGT deny -> = DENY;
//   (3) PDP-sovereign: benign (AGT allow) + a PDP DENY still = DENY (AGT can never relax a PDP deny).
// Exit 0 iff all three hold; any failure / transport error => non-zero (fail-closed, never fake-green).
//
// Imports the COMPILED dist (the sh runs `pnpm run build` first), so this drives the real shipped code.

import { createAgtDecisionTransport, createAgtEndpointSecondary } from "../dist/runtime/agt/index.js";
import { buildExecRunProjection, combineDecisions, evaluateSecondaries } from "../dist/policy/index.js";

const udsPath = process.env.AGT_UDS_PATH;
if (!udsPath) {
  console.error("agt-live-e2e: AGT_UDS_PATH unset");
  process.exit(2);
}

const transport = createAgtDecisionTransport({ udsPath });
const agt = createAgtEndpointSecondary(transport);

const reqWith = (governanceProjection) => ({
  requestId: "req-live-agt",
  tenantId: "tenant-live-agt",
  projectId: "proj-live-agt",
  taskId: "task-live-agt",
  actorId: "agent:live-agt",
  action: "tool:invoke",
  resource: "exec.run",
  governanceProjection,
});

const ALLOW_PDP = { effect: "allow", reason: "pdp: allow (driver)" };
const DENY_PDP = { effect: "deny", reason: "pdp: deny (driver)" };

const benign = buildExecRunProjection({ argv: ["echo", "hello"] });
const destructive = buildExecRunProjection({ argv: ["rm", "-rf", "/tmp/whatever"] });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

try {
  // (1) benign -> AGT allow -> allow
  const d1 = await evaluateSecondaries([agt], reqWith(benign));
  const c1 = combineDecisions(ALLOW_PDP, d1);
  check("benign exec.run -> AGT allow -> ALLOW", c1.effect === "allow", `effect=${c1.effect}`);

  // (2) destructive -> AGT deny -> deny
  const d2 = await evaluateSecondaries([agt], reqWith(destructive));
  const c2 = combineDecisions(ALLOW_PDP, d2);
  check("destructive exec.run (rm -rf) -> AGT deny -> DENY", c2.effect === "deny", `effect=${c2.effect}`);

  // (3) PDP-sovereign: benign (AGT allow) + PDP deny -> deny
  const d3 = await evaluateSecondaries([agt], reqWith(benign));
  const c3 = combineDecisions(DENY_PDP, d3);
  check("AGT allow can NOT relax a PDP deny -> DENY", c3.effect === "deny", `effect=${c3.effect}`);
} catch (err) {
  console.error(`agt-live-e2e: transport/evaluate error (fail-closed): ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (failures > 0) {
  console.error(`agt-live-e2e: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("agt-live-e2e: all 3 live AGT assertions passed");
process.exit(0);
