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
// SLICE-DV3: the typed forensic foldedState schema + the formalized WORM->ReplayEvent projection.
// `DeveloperKit.forensicState` is surfaced via the `DeveloperKit` type above; these are the standalone
// pure helpers + the public `ForensicState` contract an auditor/consumer addresses directly.
export {
  type ForensicState,
  foldForensicState,
  projectWormToReplayEvents,
} from "./forensic.js";
