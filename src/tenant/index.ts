/**
 * Tenant module public surface — the gateway-per-tenant routing boundary.
 *
 * Only the PUBLIC contract is re-exported: the router plus its binding/result types, and the
 * per-tenant persistence port (R8-S2). Later slices (kernel partition R8-S3, console projection
 * R8-S4, maker-checker R8-S5) land as intra-module directories under src/tenant/ behind this barrel.
 */
export { InMemoryTenantStore } from "./persistence/in-memory.js";
export type { TenantScopedRepo, TenantStore } from "./persistence/port.js";
export { TenantRouter } from "./router.js";
export type { RouteResult, TenantBinding } from "./router.js";
