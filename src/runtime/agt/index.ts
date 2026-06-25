/**
 * Public surface for the AGT runtime adapter (SLICE-R9b-2a). The ONLY place the runtime RPC vendor
 * (@grpc/grpc-js) + the AGT generated stub are wired for the policy path; a SecondaryPolicyAdapter
 * consumer sees only the injected vendor-neutral port.
 *
 * INERT in R9b-2a: nothing here is registered into a surface / composition root / closure. The
 * wiring + scope gate (which surfaces consult AGT, for which tools) is R9b-2b; the live e2e against a
 * real Python AGT sidecar is R9c (gated, BLOCKED until the operator supplies the engine).
 *
 * The test-only wire codec exports in decision-transport.ts are intentionally NOT re-exported here —
 * they are an in-process-fake-server detail, not part of the public surface.
 */
export {
  AGT_DECISION_SERVICE,
  type AgtDecisionTransport,
  type AgtDecisionTransportOpts,
  createAgtDecisionTransport,
} from "./decision-transport.js";
export {
  type AgtEndpointSecondaryOpts,
  createAgtEndpointSecondary,
} from "./endpoint-secondary.js";
