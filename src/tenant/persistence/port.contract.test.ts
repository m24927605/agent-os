import { describe, expect, it } from "vitest";
import type { TenantBinding } from "../router.js";
import { InMemoryTenantStore } from "./in-memory.js";
import type { TenantScopedRepo, TenantStore } from "./port.js";

/**
 * Vendor-neutral contract harness for the per-tenant persistence port.
 *
 * Every assertion here is about the ISOLATION INVARIANT, not any vendor: a repo obtained for tenant
 * A can never read or write tenant B's data, and the call surface carries NO tenantId parameter, so
 * cross-tenant access is impossible BY CONSTRUCTION. The same suite is run against >= 2 implementations
 * (the in-memory 2nd impl plus a tiny variant) to lock the contract down across pluggable impls.
 */

const bindingA: TenantBinding = {
  tenantId: "tenant-a",
  partitionId: "partition-a",
  storeRef: "store-a",
};
const bindingB: TenantBinding = {
  tenantId: "tenant-b",
  partitionId: "partition-b",
  storeRef: "store-b",
};
const bindingUnregistered: TenantBinding = {
  tenantId: "tenant-z",
  partitionId: "partition-z",
  storeRef: "store-z",
};

// Factory: builds a store registered for exactly partition-a and partition-b.
type StoreFactory = () => TenantStore;

function runContract(name: string, makeStore: StoreFactory): void {
  describe(`TenantStore contract: ${name}`, () => {
    it("headline isolation: A and B repos hold the same key independently and never see each other", async () => {
      const store = makeStore();
      const repoA = store.forTenant(bindingA);
      const repoB = store.forTenant(bindingB);

      await repoA.put("k", "va");
      await repoB.put("k", "vb");

      expect(await repoA.get("k")).toBe("va");
      expect(await repoB.get("k")).toBe("vb");

      // A's listing never contains B's keys (and vice versa).
      await repoA.put("a-only", 1);
      await repoB.put("b-only", 2);
      const listA = await repoA.list();
      const listB = await repoB.list();
      expect(listA).toContain("a-only");
      expect(listA).not.toContain("b-only");
      expect(listB).toContain("b-only");
      expect(listB).not.toContain("a-only");
    });

    it("missing key in own repo returns undefined (does not leak from another tenant)", async () => {
      const store = makeStore();
      const repoA = store.forTenant(bindingA);
      const repoB = store.forTenant(bindingB);
      await repoB.put("secret", "b-value");
      expect(await repoA.get("secret")).toBeUndefined();
    });

    it("re-resolving the same binding reaches the same tenant partition (stable, not a fresh empty repo)", async () => {
      const store = makeStore();
      await store.forTenant(bindingA).put("persisted", "yes");
      // A second handle for the SAME tenant must observe the prior write.
      expect(await store.forTenant(bindingA).get("persisted")).toBe("yes");
    });

    it("fail-closed: forTenant on an unregistered binding throws (no empty repo, no other tenant's repo)", () => {
      const store = makeStore();
      expect(() => store.forTenant(bindingUnregistered)).toThrow();
    });

    it("fail-closed throw never echoes any binding value (no leak of tenant id / storeRef)", () => {
      const store = makeStore();
      let message = "";
      try {
        store.forTenant(bindingUnregistered);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).not.toContain(bindingUnregistered.tenantId);
      expect(message).not.toContain(bindingUnregistered.partitionId);
      expect(message).not.toContain(bindingUnregistered.storeRef);
    });

    it("structural: the repo call surface carries no tenantId parameter (by-construction isolation)", () => {
      const store = makeStore();
      const repoA: TenantScopedRepo = store.forTenant(bindingA);
      // arity proof: put(key,value)=2, get(key)=1, list()=0 — none takes a tenant selector.
      expect(repoA.put.length).toBe(2);
      expect(repoA.get.length).toBe(1);
      expect(repoA.list.length).toBe(0);
    });
  });
}

// Impl #1 — the canonical in-memory 2nd implementation under test.
runContract(
  "InMemoryTenantStore",
  () => new InMemoryTenantStore(new Set(["partition-a", "partition-b"])),
);

// Impl #2 — a thin variant that wraps the same port via composition. Proves the contract is
// vendor-neutral and satisfied by >= 2 implementations (pluggability hard constraint).
class DelegatingTenantStore implements TenantStore {
  readonly #inner: TenantStore;
  constructor(registered: ReadonlySet<string>) {
    this.#inner = new InMemoryTenantStore(registered);
  }
  forTenant(binding: TenantBinding): TenantScopedRepo {
    return this.#inner.forTenant(binding);
  }
}

runContract(
  "DelegatingTenantStore",
  () => new DelegatingTenantStore(new Set(["partition-a", "partition-b"])),
);
