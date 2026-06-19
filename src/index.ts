/**
 * Agent OS core — public surface.
 *
 * This package is the product/orchestration layer that sits ABOVE NVIDIA OpenShell
 * (integration strategy B). It owns the domain contracts (policy, audit, identity).
 * The OpenShell runtime adapter interface lands in `src/runtime/openshell` (the single
 * chokepoint); the live connect-node gRPC client is wired in P2.
 */
export * from "./iam/ids.js";
export * from "./policy/types.js";
export * from "./policy/evaluate.js";
export * from "./audit/event.js";
export * from "./audit/redact.js";
export * from "./audit/serialize.js";
export * from "./audit/canonical.js";
export * from "./audit/kernel/log.js";
export * from "./audit/kernel/verify.js";
export * from "./runtime/openshell/adapter.js";
