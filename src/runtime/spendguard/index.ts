/**
 * Public surface for the SpendGuard runtime adapter (slice P2R-R11-S6). The ONLY place the runtime
 * RPC vendor (@grpc/grpc-js) + the SpendGuard generated stub are wired for the cost path; the
 * SpendGuardCostGate consumes only the injected vendor-neutral `LedgerTransport` port. The
 * composition-root wiring (real UDS path from config) + live e2e against a real sidecar is R11-S7.
 *
 * The test-only wire codec exports in transport.ts / decision-transport.ts are intentionally NOT
 * re-exported here — they are an in-process-fake-server detail, not part of the public surface.
 *
 * Two `LedgerTransport` builders co-exist (both satisfy the adapter.ts:65-68 seam):
 *   - createSidecarLedgerTransport (S6): the session-reservation RPCs (ReserveSession /
 *     CommitSessionDelta) — valid once the vendor lands the session bridge.
 *   - createDecisionLedgerTransport (S8): the gating flow the DEMO sidecar ACTUALLY serves
 *     (Handshake -> RequestDecision -> ConfirmPublishOutcome; R11-S7 ground truth). Used for the live
 *     e2e proof against the real demo in R11-S9.
 */
export {
  createSidecarLedgerTransport,
  SIDECAR_ADAPTER_SERVICE,
  type SidecarLedgerTransportOpts,
} from "./transport.js";
export {
  createDecisionLedgerTransport,
  DECISION_SIDECAR_ADAPTER_SERVICE,
  type DecisionLedgerTransportOpts,
} from "./decision-transport.js";
// SLICE-IT1b — the config-driven composition root (env -> IT1a injection opts). The vendor wiring
// (imports SpendGuardCostGate + the decision transport) lives HERE in the runtime/<vendor> zone, NOT
// in the vendor-neutral surfaces (no-vendor-in-core). Surfaces consume only the neutral opts returned.
export {
  costGateForFromEnv,
  type Integrations,
  type IntegrationsExtra,
  integrationsFromEnv,
} from "./config-root.js";
