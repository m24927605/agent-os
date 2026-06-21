/**
 * Agent OS core — public surface.
 *
 * This package is the product/orchestration layer that sits ABOVE a pluggable execution substrate
 * (integration strategy B). It owns the domain contracts (policy, audit, identity).
 * The vendor-neutral ExecutionSubstrate port lands in `src/runtime/substrate` (the single
 * chokepoint); vendor adapters (e.g. OpenShell, wired in P2) live under `src/runtime/<vendor>/`.
 */
export * from "./iam/ids.js";
export * from "./policy/types.js";
export * from "./policy/evaluate.js";
export * from "./policy/dedup.js";
export * from "./audit/event.js";
export * from "./audit/redact.js";
export * from "./audit/serialize.js";
export * from "./audit/canonical.js";
export * from "./audit/kernel/log.js";
export * from "./audit/kernel/verify.js";
export * from "./commitgate/index.js";
export * from "./cost/index.js";
export * from "./hosting/index.js";
export * from "./runtime/brain/index.js";
export * from "./runtime/substrate/index.js";
