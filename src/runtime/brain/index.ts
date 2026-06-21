/**
 * Brain module public surface — the vendor-neutral port + credential-blind guard + in-tree default
 * adapters (Scripted/Echo fakes). Real vendor brains (e.g. Hermes) land under src/runtime/brain/<vendor>/.
 */
export * from "./port.js";
export * from "./credential-guard.js";
export * from "./fakes.js";
