/**
 * SLICE-IT1a — INJECTABLE per-tenant costGateFor + shared advisory secondaries on the Enterprise fleet.
 *
 * Proves the NEW vendor-neutral injection seams on `EnterpriseFleetOpts`, PRESERVING per-tenant
 * isolation:
 *   - `costGateFor?: (tenantId: string) => CostGate` -> per tenant:
 *     `costByTenant.set(binding.tenantId, opts.costGateFor?.(binding.tenantId) ?? new InMemoryCostGate(budget))`.
 *     The factory builds an INDEPENDENT gate per tenant. Returning an always-DENY gate for tenant-A but
 *     a normal in-memory gate for tenant-B makes A's calls denied@cost while B's are UNAFFECTED
 *     (PER-TENANT ISOLATION is non-vacuous: A's gate exhaustion never touches B). NON-VACUITY: if the
 *     factory result were ignored (still `new InMemoryCostGate(budget)` for everyone), A would EXECUTE
 *     -> RED.
 *   - `secondaries?: readonly SecondaryPolicyAdapter[]` (shared advisory across tenants) ->
 *     `combineDecisions(decision, opts.secondaries ?? [])`. A shared always-DENY advisory denies EVERY
 *     tenant (any-deny-wins). NON-VACUITY: without it wired, the calls EXECUTE -> RED.
 *   - ABSENT (no costGateFor/secondaries) => BYTE-IDENTICAL to ES1: each tenant gets its OWN
 *     `new InMemoryCostGate(budget)` and `[]` secondaries (the ES1 cross-tenant e2e stays green).
 *
 * The fleet imports ONLY the vendor-neutral `CostGate` + `SecondaryPolicyAdapter` PORT types — never
 * SpendGuard/AGT. The injection only NARROWS; per-tenant PDP + isolation stay sovereign.
 *
 * RED-first: `EnterpriseFleetOpts.costGateFor` / `.secondaries` do not exist yet, so this suite fails
 * to type/compile.
 */
import { describe, expect, it } from "vitest";
import {
  type CommitResult,
  type CostGate,
  InMemoryCostGate,
  type ReleaseResult,
  type ReserveRequest,
  type ReserveResult,
  denyReserve,
} from "../cost/index.js";
import type { GovernedCall } from "../orchestration/index.js";
import type { PolicyDecision, PolicyRequest, SecondaryPolicyAdapter } from "../policy/index.js";
import { createEnterpriseFleet } from "./bootstrap.js";

/** A valid AgentContext for `tenantId`. The fleet's router parses this fail-closed. */
function ctxFor(tenantId: string) {
  return {
    actorId: "agent:claude",
    tenantId,
    projectId: `proj-${tenantId}`,
    taskId: `task-${tenantId}`,
    requestId: `req-${tenantId}`,
  };
}

/** A minimal GovernedCall for `tenantId`. */
function callFor(tenantId: string): GovernedCall {
  return {
    tool: `fleet:run-${tenantId}`,
    context: ctxFor(tenantId),
    ...{ args: {} },
  } as GovernedCall;
}

/** An always-DENY CostGate: every reserve is refused (deny-by-default). */
class AlwaysDenyCostGate implements CostGate {
  reserve(ctx: unknown, req: ReserveRequest): Promise<ReserveResult> {
    return Promise.resolve(denyReserve(ctx, "injected always-deny gate (test)", req.resource));
  }
  commit(_ctx: unknown, _id: string, _settle: { actualTokens: number }): Promise<CommitResult> {
    return Promise.resolve({
      status: "denied",
      reason: "injected always-deny gate (test)",
      event: { phase: "commit", result: "denied" },
    });
  }
  release(_ctx: unknown, _id: string): Promise<ReleaseResult> {
    return Promise.resolve({
      status: "denied",
      reason: "injected always-deny gate (test)",
      event: { phase: "release", result: "denied" },
    });
  }
}

/** A shared always-DENY advisory secondary (advisory deny wins). */
class DenySecondary implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): PolicyDecision {
    return { effect: "deny", reason: "injected deny secondary (test)", auditRequired: true };
  }
}

async function submitApprove(fleet: ReturnType<typeof createEnterpriseFleet>, tenantId: string) {
  const submitted = fleet.submitForApproval(ctxFor(tenantId), callFor(tenantId));
  if (submitted.status !== "pending") throw new Error("expected pending");
  return fleet.approve(ctxFor(tenantId), submitted.id);
}

describe("createEnterpriseFleet — INJECTABLE per-tenant costGateFor + shared secondaries (SLICE-IT1a)", () => {
  it("PER-TENANT ISOLATION: costGateFor returns an always-DENY gate for A but a normal gate for B -> A denied@cost, B UNAFFECTED", async () => {
    const fleet = createEnterpriseFleet({
      tenants: ["tenant-a", "tenant-b"],
      // INDEPENDENT gate per tenant: A's vendor gate (always-deny) is NOT B's.
      costGateFor: (tenantId) =>
        tenantId === "tenant-a" ? new AlwaysDenyCostGate() : new InMemoryCostGate(1000),
    });

    // tenant-A: the injected always-deny gate short-circuits @cost; the effect never runs.
    const decidedA = await submitApprove(fleet, "tenant-a");
    expect(decidedA.status).toBe("denied");
    if (decidedA.status === "denied" && decidedA.outcome?.status === "denied") {
      expect(decidedA.outcome.stage).toBe("cost");
    }
    const consoleA = fleet.console(ctxFor("tenant-a"));
    if (consoleA.ok) expect((await consoleA.console.timeline()).events.length).toBe(0);

    // tenant-B: its OWN normal in-memory gate is UNAFFECTED by A's always-deny gate -> executes.
    const decidedB = await submitApprove(fleet, "tenant-b");
    expect(decidedB.status).toBe("executed");
    if (decidedB.status === "executed") expect(decidedB.outcome.status).toBe("executed");
    const consoleB = fleet.console(ctxFor("tenant-b"));
    if (consoleB.ok)
      expect((await consoleB.console.timeline()).events.length).toBeGreaterThanOrEqual(1);

    // NON-VACUITY: if costGateFor's result were ignored (everyone got `new InMemoryCostGate(budget)`),
    // tenant-A would EXECUTE — flipping the A-denied assertion RED. The split A-deny / B-execute proves
    // the per-tenant factory is wired AND each tenant has an INDEPENDENT gate.
  });

  it("FAIL-CLOSED PROVISIONING: a costGateFor that THROWS for tenant-A does NOT abort the fleet — A gets a deny-all gate, B is provisioned + UNAFFECTED", async () => {
    // A factory fault during provisioning must NOT cascade: the fleet still constructs, the FAULTING
    // tenant (A) is fail-closed (deny-all gate, denied@cost), and the OTHER tenant (B) is provisioned
    // and executes. Per-tenant isolation: A's provisioning fault never touches B.
    const fleet = createEnterpriseFleet({
      tenants: ["tenant-a", "tenant-b"],
      costGateFor: (tenantId) => {
        if (tenantId === "tenant-a") {
          throw new Error("injected gate FACTORY fault for tenant-a (test)");
        }
        return new InMemoryCostGate(1000);
      },
    });

    // tenant-A: the factory threw -> a fail-closed deny-all gate was installed -> denied@cost.
    const decidedA = await submitApprove(fleet, "tenant-a");
    expect(decidedA.status).toBe("denied");
    if (decidedA.status === "denied" && decidedA.outcome?.status === "denied") {
      expect(decidedA.outcome.stage).toBe("cost");
    }

    // tenant-B: provisioned normally despite A's factory fault -> executes (isolation preserved).
    const decidedB = await submitApprove(fleet, "tenant-b");
    expect(decidedB.status).toBe("executed");
    if (decidedB.status === "executed") expect(decidedB.outcome.status).toBe("executed");

    // Per-tenant WORM independence intact (the fault did not collapse the fleet's per-tenant instances).
    expect(fleet.wormLogFor(ctxFor("tenant-a"))).not.toBe(fleet.wormLogFor(ctxFor("tenant-b")));
  });

  it("SHARED always-DENY secondary -> EVERY tenant is denied@policy (advisory any-deny-wins), NO effect", async () => {
    const fleet = createEnterpriseFleet({
      tenants: ["tenant-a", "tenant-b"],
      secondaries: [new DenySecondary()], // shared advisory across all tenants
    });

    for (const tenantId of ["tenant-a", "tenant-b"]) {
      const decided = await submitApprove(fleet, tenantId);
      expect(decided.status).toBe("denied");
      if (decided.status === "denied" && decided.outcome?.status === "denied") {
        // combineDecisions(per-tenant PDP=allow, [secondary=deny]) -> deny (any-deny-wins) @policy.
        expect(decided.outcome.stage).toBe("policy");
      }
      const c = fleet.console(ctxFor(tenantId));
      if (c.ok) expect((await c.console.timeline()).events.length).toBe(0);
    }
  });

  it("ABSENT (no costGateFor/secondaries) -> BYTE-IDENTICAL to ES1: each tenant gets its OWN in-memory gate; happy path executes; tiny per-tenant budget denies@cost", async () => {
    // Default path: per-tenant `new InMemoryCostGate(budget)` + `[]` secondaries (ES1 unchanged).
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a", "tenant-b"] });
    const decidedA = await submitApprove(fleet, "tenant-a");
    expect(decidedA.status).toBe("executed");
    // The per-tenant WORM logs are still INDEPENDENT instances (isolation preserved with no injection).
    expect(fleet.wormLogFor(ctxFor("tenant-a"))).not.toBe(fleet.wormLogFor(ctxFor("tenant-b")));

    // A tiny per-tenant budget still denies@cost with NO injection (the default IS an in-memory budget
    // gate, not a pass-through). NON-VACUITY for the absent path.
    const fleetCost = createEnterpriseFleet({
      tenants: ["tenant-a"],
      budgetPerTenant: 5,
      estimateTokens: 50,
    });
    const decidedCost = await submitApprove(fleetCost, "tenant-a");
    expect(decidedCost.status).toBe("denied");
    if (decidedCost.status === "denied" && decidedCost.outcome?.status === "denied") {
      expect(decidedCost.outcome.stage).toBe("cost");
    }
  });
});
