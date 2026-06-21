/**
 * SpendGuard cost adapter — vendor barrel. Re-exports ONLY the adapter class and its injected ledger
 * transport seam. Deliberately NOT re-exported from the cost package barrel (src/cost/index.ts): a
 * vendor adapter is wired by the composition root, never surfaced as part of the neutral port API.
 */
export {
  type LedgerCommitReq,
  type LedgerReserveReq,
  type LedgerTransport,
  SpendGuardCostGate,
} from "./adapter.js";
