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
  OperatorAction,
  OperatorEvent,
  OperatorResult,
} from "./bootstrap.js";
