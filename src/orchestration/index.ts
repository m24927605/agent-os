/**
 * Orchestration module public surface — the governed intent->effect composition over the
 * vendor-neutral ports. Low-coupling by dependency injection; names no vendor.
 */
export * from "./pipeline.js";
export * from "./task/fsm.js";
export * from "./task/session.js";
