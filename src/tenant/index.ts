/**
 * Tenant module public surface — the gateway-per-tenant routing boundary.
 *
 * Only the PUBLIC contract is re-exported: the router plus its binding/result types, the
 * per-tenant persistence port (R8-S2), and the read-only operator-console projection (R8-S4).
 * Later slices (kernel partition R8-S3, maker-checker R8-S5) land as intra-module directories
 * under src/tenant/ behind this barrel.
 */
export { ConsoleProjection } from "./console/projection.js";
export type { FleetView, TenantConsole, TimelineView } from "./console/projection.js";
export { InMemoryTenantStore } from "./persistence/in-memory.js";
export type { TenantScopedRepo, TenantStore } from "./persistence/port.js";
export { TenantRouter } from "./router.js";
export type { RouteResult, TenantBinding } from "./router.js";
