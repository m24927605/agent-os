/**
 * ExecutionSubstrate module public surface. The vendor-neutral port + its in-tree default adapters
 * (Null = fail-closed deny-all; Fake = in-memory). Real vendor adapters (e.g. OpenShell) land under
 * `src/runtime/<vendor>/` and implement `SandboxAdapter` from here.
 */
export * from "./port.js";
export * from "./null.js";
export * from "./fake.js";
// The exec-backed governed effect (credential-blind in/out, fail-closed, output-capped). It is the ONLY
// substrate file that consumes the audit barrel (`redactSecrets`); port/null/fake stay at the cohesion
// chokepoint (zod + identity primitives only, asserted by sandbox-adapter.test.ts).
export * from "./exec-effect.js";
