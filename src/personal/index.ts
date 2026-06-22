/**
 * Personal surface — top-level module barrel (depth-1 public surface).
 *
 * Slice P2R-PV-S1 adds the composition root `createPersonalShell` that wires the already-built
 * Personal-surface sub-modules (intent / plan / approval / timeline) + the governed pipeline into one
 * runnable end-to-end spine. Cross-module consumers import the Personal surface through THIS barrel.
 *
 * It re-exports each sub-module's public surface so the composition root (and any sibling) can consume
 * the whole Personal surface through one barrel without deep-importing a sub-module internal
 * (dependency-cruiser `not-to-internal`).
 */
export * from "./intent/index.js";
export * from "./plan/index.js";
export * from "./approval/index.js";
export * from "./timeline/index.js";
export * from "./voice/index.js";
export { buildToolCall, createPersonalShell } from "./bootstrap.js";
export type { PersonalShell, PersonalShellOpts, PersonalToolCall } from "./bootstrap.js";
