/**
 * CostGate module public surface — the vendor-neutral port + in-tree default adapters (Null =
 * fail-closed deny-all; InMemory = budget hard-cap). Real vendor adapters (e.g. SpendGuard) land under
 * src/cost/adapters/<vendor>/ and implement `CostGate` from here.
 */
export * from "./port.js";
export * from "./null.js";
export * from "./in-memory.js";
