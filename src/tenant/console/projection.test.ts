import { describe, expect, it } from "vitest";
import { InMemoryTenantStore } from "../persistence/in-memory.js";
import type { TenantBinding } from "../router.js";
import { ConsoleProjection } from "./projection.js";
import type { FleetView, TenantConsole, TimelineView } from "./projection.js";

/**
 * R8-S4 — operator console read-only fleet/timeline projection contract.
 *
 * Every assertion is about the read-only + tenant-isolation invariant: a console obtained for
 * tenant A can only ever see A's fleet/timeline, the projection surface carries NO mutate method
 * and NO tenantId parameter (cross-tenant is impossible BY CONSTRUCTION), and the projection only
 * lifts the allowed fields (no secret-looking value leaks into a view).
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

function makeStore(): InMemoryTenantStore {
  return new InMemoryTenantStore(new Set(["partition-a", "partition-b"]));
}

// Seed a tenant's repo with one fleet agent and one timeline event the way producers write them.
// The console projection reads these back and lifts only the allow-listed fields.
async function seed(
  store: InMemoryTenantStore,
  binding: TenantBinding,
  opts: {
    sandboxId: string;
    agentName: string;
    phase: string;
    seq: number;
    summary: string;
    secret?: string;
  },
): Promise<void> {
  const repo = store.forTenant(binding);
  await repo.put(`agent:${opts.sandboxId}`, {
    sandboxId: opts.sandboxId,
    agentName: opts.agentName,
    phase: opts.phase,
    // A field the projection must NOT lift into the FleetView.
    apiKey: opts.secret ?? "sk-do-not-leak",
  });
  await repo.put(`event:${opts.seq}`, {
    seq: opts.seq,
    summary: opts.summary,
    // A field the projection must NOT lift into the TimelineView.
    rawPayload: opts.secret ?? "sk-do-not-leak",
  });
}

describe("ConsoleProjection.forTenant", () => {
  it("headline isolation: A's console sees only A's fleet + timeline, never B's", async () => {
    const store = makeStore();
    await seed(store, bindingA, {
      sandboxId: "sbx-a",
      agentName: "agent-a",
      phase: "running",
      seq: 1,
      summary: "a-happened",
    });
    await seed(store, bindingB, {
      sandboxId: "sbx-b",
      agentName: "agent-b",
      phase: "stopped",
      seq: 1,
      summary: "b-happened",
    });

    const consoleA = new ConsoleProjection(store).forTenant(bindingA);
    const fleetA: FleetView = await consoleA.fleet();
    const timelineA: TimelineView = await consoleA.timeline();

    expect(fleetA.tenantId).toBe("tenant-a");
    expect(fleetA.agents.map((a) => a.sandboxId)).toEqual(["sbx-a"]);
    expect(fleetA.agents.map((a) => a.sandboxId)).not.toContain("sbx-b");

    expect(timelineA.tenantId).toBe("tenant-a");
    expect(timelineA.events.map((e) => e.summary)).toEqual(["a-happened"]);
    expect(timelineA.events.map((e) => e.summary)).not.toContain("b-happened");
  });

  it("timeline is ordered by seq ascending (stable replay order)", async () => {
    const store = makeStore();
    const repo = store.forTenant(bindingA);
    await repo.put("event:3", { seq: 3, summary: "third" });
    await repo.put("event:1", { seq: 1, summary: "first" });
    await repo.put("event:2", { seq: 2, summary: "second" });

    const timeline = await new ConsoleProjection(store).forTenant(bindingA).timeline();
    expect(timeline.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("read-only: TenantConsole exposes no mutate method (type-level + runtime)", async () => {
    const store = makeStore();
    const tenantConsole: TenantConsole = new ConsoleProjection(store).forTenant(bindingA);
    // Only the two read methods exist; nothing that could change the company.
    expect(Object.keys(tenantConsole).sort()).toEqual(["fleet", "timeline"]);
    for (const forbidden of ["put", "set", "delete", "suspend", "write", "update"]) {
      expect((tenantConsole as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });

  it("read-only: a projection call does not mutate the underlying repo", async () => {
    const store = makeStore();
    await seed(store, bindingA, {
      sandboxId: "sbx-a",
      agentName: "agent-a",
      phase: "running",
      seq: 1,
      summary: "a-happened",
    });
    const before = await store.forTenant(bindingA).list();
    const tenantConsole = new ConsoleProjection(store).forTenant(bindingA);
    await tenantConsole.fleet();
    await tenantConsole.timeline();
    const after = await store.forTenant(bindingA).list();
    expect(after).toEqual(before);
  });

  it("tenant closure-bind: fleet()/timeline() take no tenantId argument (no cross-tenant arg)", () => {
    const store = makeStore();
    const tenantConsole = new ConsoleProjection(store).forTenant(bindingA);
    expect(tenantConsole.fleet.length).toBe(0);
    expect(tenantConsole.timeline.length).toBe(0);
  });

  it("fail-closed: forTenant with an unregistered binding propagates the store's throw", () => {
    const store = makeStore();
    expect(() => new ConsoleProjection(store).forTenant(bindingUnregistered)).toThrow();
  });

  it("no-leak: a planted secret-looking value never appears in any view", async () => {
    const store = makeStore();
    const planted = "sk-live-PLANTED-SECRET-DEADBEEF";
    await seed(store, bindingA, {
      sandboxId: "sbx-a",
      agentName: "agent-a",
      phase: "running",
      seq: 1,
      summary: "a-happened",
      secret: planted,
    });
    const tenantConsole = new ConsoleProjection(store).forTenant(bindingA);
    const fleet = await tenantConsole.fleet();
    const timeline = await tenantConsole.timeline();
    expect(JSON.stringify(fleet)).not.toContain(planted);
    expect(JSON.stringify(timeline)).not.toContain(planted);
  });

  it("skips malformed/non-conforming entries fail-closed (no partial/garbage projection)", async () => {
    const store = makeStore();
    const repo = store.forTenant(bindingA);
    await repo.put("agent:good", { sandboxId: "sbx", agentName: "n", phase: "running" });
    await repo.put("agent:bad", { sandboxId: 123, agentName: null }); // malformed -> dropped
    await repo.put("event:good", { seq: 1, summary: "ok" });
    await repo.put("event:bad", { seq: "nope", summary: 42 }); // malformed -> dropped

    const tenantConsole = new ConsoleProjection(store).forTenant(bindingA);
    expect((await tenantConsole.fleet()).agents.map((a) => a.sandboxId)).toEqual(["sbx"]);
    expect((await tenantConsole.timeline()).events.map((e) => e.seq)).toEqual([1]);
  });
});
