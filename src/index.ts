/**
 * Agent OS core — public surface.
 *
 * This package is the product/orchestration layer that sits ABOVE NVIDIA OpenShell
 * (integration strategy B). It owns the domain contracts (policy, audit, identity);
 * the OpenShell runtime adapter is wired in a later task under `src/runtime/openshell`.
 */
export * from "./iam/ids.js";
export * from "./policy/types.js";
export * from "./policy/evaluate.js";
export * from "./audit/event.js";
export * from "./audit/redact.js";
export * from "./audit/serialize.js";
