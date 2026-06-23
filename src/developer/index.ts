/**
 * Developer module public surface (SLICE-DV1) — the depth-1 barrel cross-module consumers + the repo
 * root import through. It exposes ONLY the composition root `createDeveloperKit` and its public types.
 *
 * Cross-module imports MUST go through this barrel, not a module-internal file (dependency-cruiser
 * `not-to-internal`). `bootstrap.ts` itself consumes the OTHER modules only via THEIR barrels.
 */
export {
  createDeveloperKit,
  type DeveloperKit,
  type DeveloperKitOpts,
  type DeveloperToolCall,
  type RunToolOutcome,
  type ToolBinding,
  type VerifyResult,
} from "./bootstrap.js";
