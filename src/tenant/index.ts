/**
 * Tenant module public surface — the gateway-per-tenant routing boundary.
 *
 * Only the PUBLIC contract is re-exported: the router plus its binding/result types. Later slices
 * (per-tenant persistence repo R8-S2, kernel partition R8-S3, console projection R8-S4,
 * maker-checker R8-S5) land as intra-module directories under src/tenant/ behind this same barrel.
 */
export { TenantRouter } from "./router.js";
export type { RouteResult, TenantBinding } from "./router.js";
