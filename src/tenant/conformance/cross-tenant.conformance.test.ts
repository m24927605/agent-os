/**
 * Release-blocking cross-tenant conformance (TS plane) — R8-S6.
 *
 * This suite re-proves the three TS-side R8 isolation boundaries on EVERY commit (it is wired into
 * `pnpm run verify` via the `verify:cross-tenant` sub-gate). It introduces NO new isolation
 * mechanism: it only asserts, fixture/property-style, that the ALREADY-SHIPPED public surfaces of
 * R8-S1 (TenantRouter), R8-S2 (TenantStore/TenantScopedRepo) and R8-S5 (enforceMakerChecker) make a
 * cross-tenant leak structurally impossible. ANY single boundary leaking => a failing test => a
 * non-zero `verify` exit => the pre-commit guard blocks the merge.
 *
 * It consumes ONLY the module's public barrel (../index.js) — no deep import — so the gate is
 * coupled to the contract, not to internals (dependency-cruiser `not-to-internal` stays green).
 *
 * The "RED" for a gate slice is demonstrated out-of-band per the spec: injecting a leak mutation
 * into any of the real S1/S2/S5 modules (e.g. router returning another tenant's binding, repo
 * sharing one store across tenants, maker-checker honouring a cross-tenant capability) flips the
 * corresponding assertion below to fail and drives `verify:cross-tenant` to exit != 0.
 */
import { describe, expect, it } from "vitest";
import {
  type CheckerCapability,
  InMemoryTenantStore,
  type TenantBinding,
  TenantRouter,
  deriveActionIdentity,
  enforceMakerChecker,
} from "../index.js";

// Two tenants A and B. The cross-tenant attempt matrix enumerates "tenant X actor reaching for
// tenant Y's resource" for every X != Y; every such cell MUST deny / be invisible.
const TENANTS = ["tenant-a", "tenant-b"] as const;
type Tenant = (typeof TENANTS)[number];

function otherTenant(self: Tenant): Tenant {
  return self === "tenant-a" ? "tenant-b" : "tenant-a";
}

/** Minimal valid AgentContext (every id non-empty so parseAgentContext, fail-closed, accepts it). */
function ctxFor(tenantId: string, actorId = "actor-1"): unknown {
  return { actorId, tenantId, projectId: "project-1", taskId: "task-1", requestId: "request-1" };
}

function bindingFor(tenant: Tenant): TenantBinding {
  return { tenantId: tenant, partitionId: `partition-${tenant}`, storeRef: `store-${tenant}` };
}

const ALL_BINDINGS = new Map<string, TenantBinding>(TENANTS.map((t) => [t, bindingFor(t)]));
const ALL_PARTITIONS = new Set<string>(TENANTS.map((t) => bindingFor(t).partitionId));

describe("cross-tenant conformance (release-blocking gate)", () => {
  // Boundary (1) — R8-S1 routing: an untrusted ctx can only ever resolve to ITS OWN binding.
  describe("boundary 1 — routing (R8-S1): a ctx never resolves to another tenant's binding", () => {
    const router = new TenantRouter(ALL_BINDINGS);

    for (const self of TENANTS) {
      it(`${self}: resolve() returns only ${self}'s binding (never ${otherTenant(self)}'s)`, () => {
        const res = router.resolve(ctxFor(self));
        expect(res.ok).toBe(true);
        if (!res.ok) return; // narrow; the assertion above already failed the test
        expect(res.binding.tenantId).toBe(self);
        // The leak invariant: the resolved binding must NOT belong to any other tenant.
        expect(res.binding.partitionId).toBe(bindingFor(self).partitionId);
        expect(res.binding.partitionId).not.toBe(bindingFor(otherTenant(self)).partitionId);
        expect(res.binding.storeRef).not.toBe(bindingFor(otherTenant(self)).storeRef);
      });
    }

    it("exposes no enumeration / fetch-by-arbitrary-string surface (structural)", () => {
      // The only public method is resolve(); there is no `bindings`, no `get`, no `list`.
      expect((router as unknown as { bindings?: unknown }).bindings).toBeUndefined();
      expect((router as unknown as { list?: unknown }).list).toBeUndefined();
      expect(typeof (router as unknown as { resolve: unknown }).resolve).toBe("function");
    });

    it("malformed / unknown tenant fails closed (no fall-through to a default tenant)", () => {
      expect(router.resolve({ tenantId: "" }).ok).toBe(false); // malformed ctx
      expect(router.resolve(ctxFor("tenant-ghost")).ok).toBe(false); // unregistered
    });
  });

  // Boundary (2) — R8-S2 persistence: a repo is closure-bound to one tenant; data written under A
  // is never visible from B's repo, in BOTH directions, for the whole attempt matrix.
  describe("boundary 2 — persistence (R8-S2): a tenant's repo never sees another tenant's data", () => {
    for (const self of TENANTS) {
      const other = otherTenant(self);
      it(`data written via ${self}'s repo is invisible to ${other}'s repo`, async () => {
        const store = new InMemoryTenantStore(ALL_PARTITIONS);
        const repoSelf = store.forTenant(bindingFor(self));
        const repoOther = store.forTenant(bindingFor(other));

        await repoSelf.put("k", `secret-of-${self}`);

        // Cross-tenant read leak: other's repo must NOT return self's value, nor list self's key.
        expect(await repoOther.get("k")).toBeUndefined();
        expect(await repoOther.list()).not.toContain("k");
        // Self still sees its own write (isolation is not "deny everything").
        expect(await repoSelf.get("k")).toBe(`secret-of-${self}`);
      });
    }

    it("an unregistered tenant fails closed (forTenant throws; no empty/foreign repo)", () => {
      const store = new InMemoryTenantStore(ALL_PARTITIONS);
      expect(() =>
        store.forTenant({ tenantId: "ghost", partitionId: "partition-ghost", storeRef: "x" }),
      ).toThrow();
    });
  });

  // Boundary (3) — R8-S5 maker-checker: a capability bound to tenant A grants nothing for tenant B.
  describe("boundary 3 — maker-checker (R8-S5): a cross-tenant capability never approves", () => {
    const action = { kind: "suspend-agent", resource: "agent-7" } as const;
    const actionIdentity = deriveActionIdentity(action);

    function capFor(tenant: Tenant, makerActorId: string): CheckerCapability {
      return { tenantId: tenant, actionIdentity, makerActorId, capabilityRef: `cap-${tenant}` };
    }

    for (const self of TENANTS) {
      const other = otherTenant(self);
      it(`${other}'s capability does not approve a ${self} checker (cross-tenant deny)`, () => {
        // Checker is in tenant `self`; the capability is bound to the OTHER tenant.
        const checkerCtx = ctxFor(self, "checker-actor");
        const decision = enforceMakerChecker(checkerCtx, action, capFor(other, "maker-actor"));
        expect(decision.effect).toBe("deny");
        expect(decision.auditRequired).toBe(true);
      });

      it(`${self}'s own capability approves only when maker != checker and action matches`, () => {
        const checkerCtx = ctxFor(self, "checker-actor");
        // maker == checker => deny (same person cannot be both).
        expect(enforceMakerChecker(checkerCtx, action, capFor(self, "checker-actor")).effect).toBe(
          "deny",
        );
        // distinct maker, same tenant, matching action identity => allow.
        expect(enforceMakerChecker(checkerCtx, action, capFor(self, "maker-actor")).effect).toBe(
          "allow",
        );
        // action mismatch (TOCTOU): same cap, a DIFFERENT action => deny.
        const otherAction = { kind: "suspend-agent", resource: "agent-OTHER" } as const;
        expect(
          enforceMakerChecker(checkerCtx, otherAction, capFor(self, "maker-actor")).effect,
        ).toBe("deny");
      });
    }
  });
});
