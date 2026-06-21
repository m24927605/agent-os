/**
 * Vendor-neutral per-tenant persistence port (boundary 2 of the R8 multi-tenant spine).
 *
 * The isolation invariant is structural, not a row filter: a `TenantScopedRepo` is obtained via
 * `TenantStore.forTenant(binding)` and is CLOSURE-BOUND to that one tenant. Its methods carry NO
 * tenantId parameter, so a caller holding tenant A's repo has no argument with which to name tenant
 * B — cross-tenant read/write is impossible BY CONSTRUCTION (not "don't forget the WHERE clause").
 *
 * No vendor, no secret: `binding` (from src/tenant/router) is the only scope key. A real Postgres
 * adapter (connection pool / DSN / sharding) is a later vendor-adapter slice; this port stays
 * vendor-neutral so >= 2 implementations can be locked by one contract test.
 */
import type { TenantBinding } from "../router.js";

/**
 * The per-tenant repository. Every method is implicitly scoped to the tenant whose binding produced
 * this instance; there is no way to address another tenant from this surface.
 */
export interface TenantScopedRepo {
  put(key: string, value: unknown): Promise<void>;
  get(key: string): Promise<unknown | undefined>;
  list(): Promise<readonly string[]>;
}

/**
 * The persistence port. `forTenant` is the only entry point: an unregistered binding fails closed
 * (throws) rather than returning an empty repo or another tenant's repo.
 */
export interface TenantStore {
  forTenant(binding: TenantBinding): TenantScopedRepo;
}
