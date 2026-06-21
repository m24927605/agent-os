/**
 * Policy module public surface — the deny-by-default PDP, its dedup merge law, and the policy types.
 * Cross-module consumers (e.g. `src/tools/authorize.ts`) import ONLY from here, never deep into the
 * module's internals (enforced by dep-cruiser `not-to-internal`).
 */
export * from "./types.js";
export * from "./evaluate.js";
export * from "./dedup.js";
