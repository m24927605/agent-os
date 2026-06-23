/**
 * Enterprise module public surface (the depth-1 barrel cross-module consumers import through).
 *
 * SLICE-ES1: the Enterprise-vertical composition root — `createEnterpriseFleet(opts)` assembles the R8
 * isolation primitives (router / per-tenant store / console projection) + the governed pipeline +
 * per-tenant {CostGate, WORM log, ApprovalInbox} into a runnable, tenant-sealed multi-tenant fleet.
 * Downstream surfaces (CLI, future ES2 live partition) consume the factory + its option/result types
 * from here, never the module internals (dependency-cruiser `not-to-internal`).
 */
export { createEnterpriseFleet } from "./bootstrap.js";
export type {
  ConsoleResult,
  EnterpriseFleet,
  EnterpriseFleetOpts,
  LifecycleResult,
  OperatorAction,
  OperatorEvent,
  OperatorResult,
} from "./bootstrap.js";
// SLICE-ES2b: the per-tenant LIVE WORM sink factory. Enterprise consumers (the live-kernel e2e + a
// future CLI composition root) build a `wormSinkFor` from this — binding an injected AppendTransport +
// TenantBinding into a sink that appends to that tenant's INDEPENDENT kernel partition chain. Re-exported
// through THIS barrel (from the runtime/ingest barrel) so Enterprise stays the single import surface.
export { createPartitionedIngestSink } from "../runtime/ingest/index.js";
