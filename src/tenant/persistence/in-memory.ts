/**
 * In-memory 2nd implementation of the per-tenant persistence port (deterministic, no real I/O).
 *
 * One independent `Map` per tenant partition (mirrors the registry shape of
 * src/hosting/in-memory.ts). The tenant is CLOSURE-BOUND into each repo instance at `forTenant`
 * time, so the returned `TenantScopedRepo` has no surface — and no internal field — by which a
 * caller could name another tenant. Removing that closure-bind (e.g. sharing one Map across
 * tenants, or threading a tenant arg through the methods) is exactly what the contract test's
 * cross-tenant assertions catch.
 *
 * Imports only the port + the binding type (intra-module). No vendor, no secret.
 */
import type { TenantBinding } from "../router.js";
import type { TenantScopedRepo, TenantStore } from "./port.js";

// Static fail-closed message — never echoes any value from the binding (no leak of tenant id /
// partition id / storeRef into errors, logs, or traces).
const REASON_UNREGISTERED = "unknown tenant partition (deny-by-default)";

export class InMemoryTenantStore implements TenantStore {
  // partitionId -> that tenant's isolated key/value store. A miss => fail-closed (no auto-create).
  readonly #partitions: Map<string, Map<string, unknown>>;

  constructor(registered: ReadonlySet<string> /* partitionIds */) {
    // Pre-provision one empty, independent Map per registered partition. Defensive copy so
    // post-construction mutation of the caller's Set cannot silently register a new partition.
    this.#partitions = new Map();
    for (const partitionId of registered) {
      this.#partitions.set(partitionId, new Map());
    }
  }

  forTenant(binding: TenantBinding): TenantScopedRepo {
    const partition = this.#partitions.get(binding.partitionId);
    if (partition === undefined) {
      // Fail-closed: never build an empty repo, never hand back another tenant's partition.
      throw new Error(REASON_UNREGISTERED);
    }
    // `partition` is closed over here — the returned repo can only ever touch this one Map.
    return {
      put(key: string, value: unknown): Promise<void> {
        partition.set(key, value);
        return Promise.resolve();
      },
      get(key: string): Promise<unknown | undefined> {
        return Promise.resolve(partition.get(key));
      },
      list(): Promise<readonly string[]> {
        return Promise.resolve([...partition.keys()]);
      },
    };
  }
}
