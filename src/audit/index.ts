/**
 * Audit module public surface (the depth-1 barrel cross-module consumers import through).
 *
 * Cross-module imports MUST go through this barrel, not a module-internal file (dependency-cruiser
 * `not-to-internal`). The runtime RPC transport adapter (src/runtime/ingest, slice P2R-R2-S6) consumes
 * the vendor-neutral ingest port + fail-closed parser from here; it never reaches into `./ingest/*`
 * internals. The top-level `src/index.ts` aggregates the individual audit files directly (it predates
 * this barrel and is the repo's own public surface), so this barrel intentionally re-exports only the
 * surfaces a sibling MODULE needs — today the ingest seam.
 */
export type {
  AppendRequestShape,
  AppendResponseShape,
  AppendTransport,
} from "./ingest/index.js";
export { parseAppendResponse } from "./ingest/index.js";
