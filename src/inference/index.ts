/**
 * Inference module public surface — the vendor-neutral inference routing gate (built up one
 * deny-by-default chokepoint per slice). S1 lands the InferenceRequest contract + the first gate
 * (per-model allowlist). S2/S3/S4 add the egress, PDP, and CostGate chokepoints behind this barrel.
 */
export * from "./types.js";
export * from "./model-allowlist.js";
export * from "./egress-allowlist.js";
export * from "./pdp-adapter.js";
