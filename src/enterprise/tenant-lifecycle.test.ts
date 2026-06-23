/**
 * SLICE-ES4 — DYNAMIC TENANT LIFECYCLE end-to-end proof (runtime registerTenant / deprovisionTenant)
 * on the COMPOSED Enterprise fleet.
 *
 * ES1–ES3 pre-register tenants in the ctor from `opts.tenants` (build-time). A real fleet onboards and
 * offboards tenants at RUNTIME. ES4 adds `fleet.registerTenant(tenantId)` and
 * `fleet.deprovisionTenant(tenantId)` over a PURELY in-memory backbone, and must keep the SAME
 * tenant-sealed invariant the ES1 combined-whole e2e proves — for the DYNAMICALLY-onboarded tenant too.
 *
 * This e2e drives the WHOLE and adversarially asserts:
 *   (1) DYNAMIC REGISTER: a fleet starting with ["tenant-a"] → registerTenant("tenant-c") → ok →
 *       route(ctxC) succeeds + tenant-C submit→approve EXECUTED + console(ctxC) reflects it; AND the
 *       combined-whole cross-tenant isolation holds for the NEW tenant (C's WORM/timeline never leak
 *       into A and vice-versa; C's inbox can't approve an A-issued id; route(ctxC) never returns
 *       binding-A). This is the non-vacuity anchor: collapsing C to a SHARED log/inbox/partition, or
 *       NOT rebuilding the router on register, flips one of these RED (see §NON-VACUITY below).
 *   (2) FAIL-CLOSED REGISTER: registerTenant of an already-registered id → denied (no mutation);
 *       registerTenant("") / whitespace → denied; route of an unregistered tenant → deny.
 *   (3) DEPROVISION: registerTenant("tenant-c") → deprovisionTenant("tenant-c") → thereafter
 *       route(ctxC)/submit/approve/operatorAction all fail-closed DENIED; deprovisionTenant("nope") →
 *       denied; the WORM log appended BEFORE deprovision is STILL READABLE (append-only is NOT erased
 *       — deprovision revokes routing/action capability, it does NOT delete history; by design).
 *
 * HONEST SCOPE (restated, not silently overstepped):
 *   - Dynamic LIVE kernel partition registration = P4 (kernel `-partitions` are fixed at startup). ES4
 *     does dynamic IN-MEMORY onboarding (fleet router/store/deps) only.
 *   - Real per-tenant key provision / KMS / rotation = P4. ES4 mints the key in-process (attester ==
 *     operator).
 *   - WORM history is NOT erased on deprovision (append-only, by design).
 *
 * RED-first: `fleet.registerTenant` / `fleet.deprovisionTenant` / `LifecycleResult` do not exist yet,
 * so this suite fails to type-check / import (exit != 0) until ES4 lands.
 */
import { describe, expect, it } from "vitest";
import type { GovernedCall } from "../orchestration/index.js";
import { deriveActionIdentity } from "../tenant/index.js";
import { createEnterpriseFleet } from "./bootstrap.js";

/** A valid AgentContext for `tenantId`. The fleet's router parses this fail-closed. */
function ctxFor(tenantId: string, actorId = "agent:claude") {
  return {
    actorId,
    tenantId,
    projectId: `proj-${tenantId}`,
    taskId: `task-${tenantId}`,
    requestId: `req-${tenantId}`,
  };
}

/** A minimal GovernedCall for `tenantId`. */
function callFor(tenantId: string, args: Record<string, unknown> = {}): GovernedCall {
  return { tool: `fleet:run-${tenantId}`, context: ctxFor(tenantId), ...{ args } } as GovernedCall;
}

/** The concrete ES3 action: suspend the agent running in `sandboxId`. resource = `agent:<sandboxId>`. */
function suspendAction(sandboxId: string) {
  return { kind: "suspend-agent", resource: `agent:${sandboxId}` };
}

/** A VALID, independently-issued CheckerCapability (issuance is out-of-band — the test stands in). */
function validCap(
  ctx: { tenantId: string; actorId: string },
  action: { kind: string; resource: string },
) {
  return {
    tenantId: ctx.tenantId,
    actionIdentity: deriveActionIdentity(action),
    makerActorId: "agent:maker", // distinct from ctx.actorId (the checker)
    capabilityRef: "cap-ref-opaque",
  };
}

describe("EnterpriseFleet dynamic tenant lifecycle (SLICE-ES4)", () => {
  it("(1) DYNAMIC REGISTER: start with [tenant-a] → registerTenant(tenant-c) → ok → C routes, submit→approve EXECUTED, console reflects it; AND C↔A stay tenant-sealed (combined-whole)", async () => {
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a"] });

    // Before register: tenant-C is unknown → route fail-closed deny (proves register is what enables it).
    expect(fleet.route(ctxFor("tenant-c")).ok).toBe(false);

    // Onboard tenant-C at RUNTIME.
    const reg = fleet.registerTenant("tenant-c");
    expect(reg.status).toBe("ok");

    // route(ctxC) now succeeds and resolves to C's OWN binding (never A's).
    const routedC = fleet.route(ctxFor("tenant-c"));
    expect(routedC.ok).toBe(true);
    if (!routedC.ok) return;
    expect(routedC.binding.tenantId).toBe("tenant-c");
    expect(routedC.binding.tenantId).not.toBe("tenant-a");

    // tenant-C runs a governed action end-to-end on its dynamically-provisioned pipeline.
    const subC = fleet.submitForApproval(ctxFor("tenant-c"), callFor("tenant-c"));
    expect(subC.status).toBe("pending");
    if (subC.status !== "pending") return;
    const decidedC = await fleet.approve(ctxFor("tenant-c"), subC.id);
    expect(decidedC.status).toBe("executed");

    // The newly-registered partition is VISIBLE to the SAME ConsoleProjection: C's timeline reflects it.
    const consoleC = fleet.console(ctxFor("tenant-c"));
    expect(consoleC.ok).toBe(true);
    if (!consoleC.ok) return;
    const tlC = await consoleC.console.timeline();
    expect(tlC.tenantId).toBe("tenant-c");
    expect(tlC.events.length).toBeGreaterThanOrEqual(1);

    // ── COMBINED-WHOLE cross-tenant isolation for the DYNAMIC tenant (the ES1 core, now for C↔A) ──
    // A also runs an action so both have history.
    const subA = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a"));
    expect(subA.status).toBe("pending");
    if (subA.status !== "pending") return;
    const decidedA = await fleet.approve(ctxFor("tenant-a"), subA.id);
    expect(decidedA.status).toBe("executed");

    // C's timeline does NOT contain A's event and vice-versa.
    const consoleA = fleet.console(ctxFor("tenant-a"));
    expect(consoleA.ok).toBe(true);
    if (!consoleA.ok) return;
    const tlA = await consoleA.console.timeline();
    const tlC2 = await consoleC.console.timeline();
    // Each tenant sees ONLY its own governed action (exactly one each), never the other's.
    expect(tlA.events.length).toBe(1);
    expect(tlC2.events.length).toBe(1);
    expect(JSON.stringify(tlA)).not.toContain("run-tenant-c");
    expect(JSON.stringify(tlC2)).not.toContain("run-tenant-a");

    // The per-tenant WORM logs are DIFFERENT instances (NOT one shared log).
    expect(fleet.wormLogFor(ctxFor("tenant-c"))).not.toBe(fleet.wormLogFor(ctxFor("tenant-a")));
    expect(fleet.wormLogFor(ctxFor("tenant-c"))).toBeDefined();

    // C's inbox cannot approve an A-issued id (independent inbox), and vice-versa.
    const subA2 = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a"));
    expect(subA2.status).toBe("pending");
    if (subA2.status !== "pending") return;
    const cApprovesAId = await fleet.approve(ctxFor("tenant-c"), subA2.id);
    expect(cApprovesAId.status).toBe("denied");
    // A's pending entry SURVIVED C's cross-tenant attempt (separate inboxes; C never reached it).
    const aApprovesOwn = await fleet.approve(ctxFor("tenant-a"), subA2.id);
    expect(aApprovesOwn.status).toBe("executed");

    const subC2 = fleet.submitForApproval(ctxFor("tenant-c"), callFor("tenant-c"));
    expect(subC2.status).toBe("pending");
    if (subC2.status !== "pending") return;
    const aApprovesCId = await fleet.approve(ctxFor("tenant-a"), subC2.id);
    expect(aApprovesCId.status).toBe("denied");

    // route(ctxC) never returns binding-A (and route(ctxA) never returns binding-C).
    const rC = fleet.route(ctxFor("tenant-c"));
    if (rC.ok) expect(rC.binding.tenantId).toBe("tenant-c");
    const rA = fleet.route(ctxFor("tenant-a"));
    if (rA.ok) {
      expect(rA.binding.tenantId).toBe("tenant-a");
      expect(rA.binding.tenantId).not.toBe("tenant-c");
    }
  });

  it("(1b) STATIC-CTOR-PATH PRESERVED: a fleet built with [tenant-a, tenant-b] behaves byte-identically (the ctor still provisions both, isolated)", async () => {
    // This pins that the provisionTenant refactor did NOT change the ctor path: a multi-tenant fleet
    // built the ES1 way still works and stays isolated (a regression here would also surface in the
    // unchanged ES1 cross-tenant e2e, but we anchor it here too).
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a", "tenant-b"] });
    const subA = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a"));
    expect(subA.status).toBe("pending");
    if (subA.status !== "pending") return;
    const decidedA = await fleet.approve(ctxFor("tenant-a"), subA.id);
    expect(decidedA.status).toBe("executed");
    const consoleB = fleet.console(ctxFor("tenant-b"));
    expect(consoleB.ok).toBe(true);
    if (!consoleB.ok) return;
    expect((await consoleB.console.timeline()).events.length).toBe(0); // B saw nothing of A's action
    expect(fleet.wormLogFor(ctxFor("tenant-a"))).not.toBe(fleet.wormLogFor(ctxFor("tenant-b")));
  });

  it("(2) FAIL-CLOSED REGISTER: duplicate id → denied (no mutation); empty/whitespace id → denied; unregistered route → deny", async () => {
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a"] });

    // (2a) duplicate: registering an already-registered tenant is denied — and does NOT mutate the
    // existing tenant (A's own pipeline still works afterward, its history intact).
    const subA = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a"));
    expect(subA.status).toBe("pending");
    if (subA.status !== "pending") return;
    const decidedA = await fleet.approve(ctxFor("tenant-a"), subA.id);
    expect(decidedA.status).toBe("executed");
    const wormALen = fleet.wormLogFor(ctxFor("tenant-a"))?.entries().length ?? -1;
    expect(wormALen).toBe(1);

    const dup = fleet.registerTenant("tenant-a");
    expect(dup.status).toBe("denied");
    if (dup.status === "denied") expect(typeof dup.reason).toBe("string");
    // No mutation: A's WORM log instance and its single entry are UNCHANGED by the rejected duplicate.
    expect(fleet.wormLogFor(ctxFor("tenant-a"))?.entries().length).toBe(1);

    // (2b) empty / whitespace tenantId → denied (fail-closed validate BEFORE any mutation).
    expect(fleet.registerTenant("").status).toBe("denied");
    expect(fleet.registerTenant("   ").status).toBe("denied");
    // A whitespace id never became routable.
    expect(fleet.route(ctxFor("   ")).ok).toBe(false);

    // (2c) route of a never-registered tenant → deny-by-default.
    expect(fleet.route(ctxFor("tenant-ghost")).ok).toBe(false);
  });

  it("(3) DEPROVISION: register(tenant-c) → deprovision(tenant-c) → route/submit/approve/operatorAction all DENIED; deprovision(nope) → denied; the WORM appended BEFORE deprovision is STILL READABLE (append-only not erased)", async () => {
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a"] });

    // Onboard C, run a governed action so C's WORM has a durable entry, then run an operator action so
    // the WORM holds an operator AuditEvent too — both must SURVIVE deprovision.
    expect(fleet.registerTenant("tenant-c").status).toBe("ok");

    const subC = fleet.submitForApproval(ctxFor("tenant-c"), callFor("tenant-c"));
    expect(subC.status).toBe("pending");
    if (subC.status !== "pending") return;
    expect((await fleet.approve(ctxFor("tenant-c"), subC.id)).status).toBe("executed");

    const ctxC = ctxFor("tenant-c");
    const action = suspendAction("sbx-c");
    const opRes = await fleet.operatorAction(ctxC, action, validCap(ctxC, action));
    expect(opRes.status).toBe("ok");

    // Grab the WORM log INSTANCE and its entry count BEFORE deprovision (we assert it survives).
    const wormC = fleet.wormLogFor(ctxC);
    expect(wormC).toBeDefined();
    const entriesBefore = wormC?.entries().length ?? -1;
    expect(entriesBefore).toBeGreaterThanOrEqual(2); // governed action + operator suspend

    // ── DEPROVISION tenant-C ──
    const deprov = fleet.deprovisionTenant("tenant-c");
    expect(deprov.status).toBe("ok");

    // Thereafter EVERY capability for tenant-C is fail-closed DENIED (router rebuilt WITHOUT C's binding).
    expect(fleet.route(ctxFor("tenant-c")).ok).toBe(false);
    expect(fleet.submitForApproval(ctxFor("tenant-c"), callFor("tenant-c")).status).toBe("denied");
    expect((await fleet.approve(ctxFor("tenant-c"), "any-id")).status).toBe("denied");
    const opAfter = await fleet.operatorAction(ctxFor("tenant-c"), action, validCap(ctxC, action));
    expect(opAfter.status).toBe("denied");
    // console for a deprovisioned tenant is also denied (route-first).
    expect(fleet.console(ctxFor("tenant-c")).ok).toBe(false);

    // WORM NOT ERASED: the append-only log INSTANCE and its prior entries are intact (deprovision
    // revokes ROUTING/ACTION capability, it does not delete HISTORY). We held the instance reference
    // before deprovision; its entries are unchanged.
    expect(wormC?.entries().length).toBe(entriesBefore);
    // The committed operator AuditEvent is STILL READABLE for audit/forensics.
    const events = wormC?.entries() ?? [];
    expect(events.some((e) => e.event.action === "suspend-agent")).toBe(true);

    // (3b) deprovision of a never-registered tenant → denied (fail-closed validate).
    expect(fleet.deprovisionTenant("tenant-nope").status).toBe("denied");

    // tenant-A is UNAFFECTED by C's deprovision (independent binding/deps).
    expect(fleet.route(ctxFor("tenant-a")).ok).toBe(true);
    const subA = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a"));
    expect(subA.status).toBe("pending");
    if (subA.status !== "pending") return;
    expect((await fleet.approve(ctxFor("tenant-a"), subA.id)).status).toBe("executed");
  });

  it("(3c) RE-REGISTER a deprovisioned id → clean DENIED (not a throw); the retired tenant stays unroutable and never silently reuses its old WORM (append-only invariant)", async () => {
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a"], budgetPerTenant: 100 });
    expect(fleet.registerTenant("tenant-c").status).toBe("ok");
    // C does a governed action so its partition/WORM exists, then is offboarded.
    const subC = fleet.submitForApproval(ctxFor("tenant-c"), callFor("tenant-c"));
    expect(subC.status).toBe("pending");
    if (subC.status !== "pending") return;
    expect((await fleet.approve(ctxFor("tenant-c"), subC.id)).status).toBe("executed");
    expect(fleet.deprovisionTenant("tenant-c").status).toBe("ok");

    // Re-registering the SAME id must NOT throw — deprovision kept C's append-only partition/WORM, so
    // store.register would throw; registerTenant translates that to a clean fail-closed denied.
    const reReg = fleet.registerTenant("tenant-c");
    expect(reReg.status).toBe("denied");
    // The retired id stays unroutable (no silent comeback, no inherited state); A is unaffected.
    expect(fleet.route(ctxFor("tenant-c")).ok).toBe(false);
    expect(fleet.route(ctxFor("tenant-a")).ok).toBe(true);
  });
});
