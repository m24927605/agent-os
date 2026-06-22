// R11-S9 live e2e probe — drives the REAL SpendGuardCostGate (adapter) + createDecisionLedgerTransport
// against a RUNNING SpendGuard demo sidecar over its UDS. Run by scripts/e2e-live-spendguard.sh inside a
// sidecar-adjacent container (uid 65532, UDS volume mounted). Imports the COMPILED dist (pure-JS grpc-js).
//
// Proves, against the real Rust sidecar + Postgres ledger:
//   - reserve(within budget)  -> status "ok" + a real ledger reservation id  (RequestDecision CONTINUE)
//   - commit                  -> status "committed"                          (ConfirmPublishOutcome)
//   - reserve(over budget)    -> status "denied"  (FAIL-CLOSED: the over-budget path denies)
// Exit 0 iff all hold. Seeded demo: tenant 0000..0001, budget 4444.., token unit 6666.. (balance 500).
import { SpendGuardCostGate } from "../dist/cost/adapters/spendguard/adapter.js";
import { createDecisionLedgerTransport } from "../dist/runtime/spendguard/decision-transport.js";

const UDS = process.env.AGENTOS_LIVE_SPENDGUARD_UDS ?? "/var/run/spendguard/adapter.sock";
const TENANT_ASSERTION = "00000000-0000-4000-8000-000000000001";
const BUDGET_CLAIM = {
  budgetId: "44444444-4444-4444-8444-444444444444",
  unitId: "66666666-6666-4666-8666-666666666666",
  windowInstanceId: "55555555-5555-4555-8555-555555555555",
};
const ctx = {
  actorId: "agent:e2e",
  tenantId: "tenant-e2e",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-live-1",
};

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const gate = new SpendGuardCostGate(
  createDecisionLedgerTransport({
    udsPath: UDS,
    tenantIdAssertion: TENANT_ASSERTION,
    budgetClaim: BUDGET_CLAIM,
  }),
);

const small = await gate.reserve(ctx, { estimatedTokens: 10, resource: "demo-route" });
check(
  "reserve(within budget) -> ok + reservationId",
  small.status === "ok" && !!small.reservationId,
  JSON.stringify(small),
);

if (small.status === "ok") {
  const committed = await gate.commit(ctx, small.reservationId, { actualTokens: 8 });
  check("commit -> committed", committed.status === "committed", JSON.stringify(committed));
}

const over = await gate.reserve(ctx, { estimatedTokens: 600, resource: "demo-route" });
check(
  "reserve(over budget, 600 > 500) -> denied (fail-closed)",
  over.status === "denied",
  JSON.stringify(over),
);

console.log(failures === 0 ? "LIVE_E2E_PASS" : `LIVE_E2E_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
