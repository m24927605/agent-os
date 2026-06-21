import { describe, expect, it } from "vitest";
import { type TenantBinding, TenantRouter } from "./router.js";

/**
 * Minimal valid AgentContext for a given tenant. Other ids are non-empty so parseAgentContext
 * (fail-closed) accepts the context; only tenantId varies between tenants.
 */
function ctxFor(tenantId: string): unknown {
  return {
    actorId: "actor-1",
    tenantId,
    projectId: "project-1",
    taskId: "task-1",
    requestId: "request-1",
  };
}

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

function newRouter(): TenantRouter {
  return new TenantRouter(
    new Map<string, TenantBinding>([
      ["tenant-a", bindingA],
      ["tenant-b", bindingB],
    ]),
  );
}

describe("TenantRouter — gateway-per-tenant routing (connection/namespace boundary)", () => {
  it("headline: a tenant's ctx resolves ONLY its own binding, never another tenant's", () => {
    const router = newRouter();

    const a = router.resolve(ctxFor("tenant-a"));
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.binding.tenantId).toBe("tenant-a");
      expect(a.binding.partitionId).toBe("partition-a");
      expect(a.binding.storeRef).toBe("store-a");
    }

    const b = router.resolve(ctxFor("tenant-b"));
    expect(b.ok).toBe(true);
    if (b.ok) {
      // tenant-b NEVER resolves to tenant-a's binding.
      expect(b.binding.tenantId).toBe("tenant-b");
      expect(b.binding.tenantId).not.toBe("tenant-a");
      expect(b.binding.storeRef).not.toBe("store-a");
    }
  });

  it("deny-by-default: a valid ctx for an UNREGISTERED tenant denies (no fall-through to a default)", () => {
    const router = newRouter();
    const r = router.resolve(ctxFor("tenant-unregistered"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("unknown tenant");
    }
  });

  it("fail-closed: malformed ctx (missing fields) denies", () => {
    const router = newRouter();
    const r = router.resolve({ tenantId: "tenant-a" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("invalid agent context");
    }
  });

  it("fail-closed: empty tenantId denies (not treated as a tenant)", () => {
    const router = newRouter();
    const r = router.resolve(ctxFor(""));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("invalid agent context");
    }
  });

  it("fail-closed: non-object ctx denies", () => {
    const router = newRouter();
    for (const bad of [null, undefined, "tenant-a", 42, []]) {
      const r = router.resolve(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain("invalid agent context");
      }
    }
  });

  it("structural isolation: router exposes no enumerate/get-by-arbitrary-string API", () => {
    const router = newRouter();
    // The only public way to obtain a binding is resolve(ctx). No registry escape hatch.
    const ownKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(router)).filter(
      (k) => k !== "constructor",
    );
    expect(ownKeys).toEqual(["resolve"]);
    // No enumeration / arbitrary lookup surface.
    expect((router as unknown as Record<string, unknown>).list).toBeUndefined();
    expect((router as unknown as Record<string, unknown>).all).toBeUndefined();
    expect((router as unknown as Record<string, unknown>).get).toBeUndefined();
    expect((router as unknown as Record<string, unknown>).bindings).toBeUndefined();
  });

  it("reason does not leak: a secret-looking tenantId never appears in any deny reason", () => {
    const router = newRouter();
    // A distinctive, sensitive-looking tenantId (deliberately NOT a real credential pattern, so it
    // does not trip the secret-scan gate). The invariant under test is that whatever value arrives
    // in ctx.tenantId is never echoed into a deny reason.
    const secret = "tenant-CONFIDENTIAL-do-not-leak-12345";
    const r = router.resolve(ctxFor(secret));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toContain(secret);
    }
  });

  it("registry mutation after construction does not affect routing (defensive copy)", () => {
    const live = new Map<string, TenantBinding>([["tenant-a", bindingA]]);
    const router = new TenantRouter(live);
    // Inject another tenant after construction — must NOT become resolvable.
    live.set("tenant-b", bindingB);
    const r = router.resolve(ctxFor("tenant-b"));
    expect(r.ok).toBe(false);
  });
});
