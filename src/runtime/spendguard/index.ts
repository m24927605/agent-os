/**
 * Public surface for the SpendGuard runtime adapter (slice P2R-R11-S6). The ONLY place the runtime
 * RPC vendor (@grpc/grpc-js) + the SpendGuard generated stub are wired for the cost path; the
 * SpendGuardCostGate consumes only the injected vendor-neutral `LedgerTransport` port. The
 * composition-root wiring (real UDS path from config) + live e2e against a real sidecar is R11-S7.
 *
 * The test-only wire codec exports in transport.ts are intentionally NOT re-exported here — they are
 * an in-process-fake-server detail, not part of the public surface.
 */
export {
  createSidecarLedgerTransport,
  SIDECAR_ADAPTER_SERVICE,
  type SidecarLedgerTransportOpts,
} from "./transport.js";
