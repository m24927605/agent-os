/**
 * SLICE-ES1 — COMBINED-WHOLE cross-tenant proof for the Enterprise fleet composition root.
 *
 * R8 already ships per-PRIMITIVE conformance (router / persistence / console / maker-checker), wired
 * release-blocking into `pnpm run verify:cross-tenant`. But conformance proves each primitive in
 * ISOLATION; it does NOT prove that the COMPOSED whole — `createEnterpriseFleet` wiring the router +
 * per-tenant {CostGate, WORM log, PDP rule, ApprovalInbox, repo} + the governed pipeline — keeps a
 * tenant sealed. A composition-root bug (one SHARED InMemoryAppendOnlyLog, one shared inbox, a
 * tenantId threaded as a parameter, a route that returns the wrong binding) would leave every
 * per-primitive gate green while tenant-A's approve→WORM→timeline leaks into tenant-B.
 *
 * This e2e is that missing proof. It drives the fleet end-to-end per tenant and adversarially asserts
 * the tenant-sealed invariant ON THE WHOLE:
 *   (1) happy per-tenant: submit→approve→executed (FakeSandbox created) + console timeline reflects it.
 *   (2) THE KEY combined-whole isolation: A's governed action never appears in B's timeline; A's WORM
 *       log instance !== B's; B's inbox cannot approve an A-issued id (and vice-versa); route(ctxB)
 *       never returns binding-A.
 *   (3) governance short-circuits PER TENANT: secret canary → denied@screen; no allow rule →
 *       denied@policy; tiny budget → denied@cost.
 *   (4) fail-closed: an unregistered tenant's ctx → route/submit denied; approve is one-time.
 *   + exit redaction: the secret canary never appears in any console timeline/fleet output.
 *
 * RED-first: `./bootstrap.js` does not exist yet, so the import fails and the suite errors (exit!=0).
 */
import { describe, expect, it } from "vitest";
import type { GovernedCall } from "../orchestration/index.js";
import { createEnterpriseFleet } from "./bootstrap.js";

// A runtime-ASSEMBLED secret canary (never a literal in source — keeps secret-scan clean). Matches
// the audit redactor's `sk-[A-Za-z0-9]{16,}` shape, so `detectSecret` flags it at the screen gate.
const SECRET_CANARY = `sk-${"d".repeat(24)}`;

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

/** A minimal GovernedCall for `tenantId`. `args` rides the screen guard for secret egress. */
function callFor(tenantId: string, args: Record<string, unknown> = {}): GovernedCall {
  return { tool: `fleet:run-${tenantId}`, context: ctxFor(tenantId), ...{ args } } as GovernedCall;
}

describe("createEnterpriseFleet — combined-whole cross-tenant isolation (SLICE-ES1)", () => {
  it("(1) HAPPY per-tenant: tenant-A submit→approve→executed (FakeSandbox) + console timeline reflects it", async () => {
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a", "tenant-b"] });

    const submitted = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a"));
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") return;

    const decided = await fleet.approve(ctxFor("tenant-a"), submitted.id);
    expect(decided.status).toBe("executed");
    if (decided.status === "executed") {
      expect(decided.outcome.status).toBe("executed");
    }

    // The governed action landed a console-projectable timeline entry in tenant-A's own repo.
    const consoleA = fleet.console(ctxFor("tenant-a"));
    expect(consoleA.ok).toBe(true);
    if (!consoleA.ok) return;
    const timelineA = await consoleA.console.timeline();
    expect(timelineA.tenantId).toBe("tenant-a");
    expect(timelineA.events.length).toBeGreaterThanOrEqual(1);
  });

  it("(2) THE KEY: tenant-A's approve→WORM→timeline NEVER leaks into tenant-B (independent log/inbox/repo; route never crosses)", async () => {
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a", "tenant-b"] });

    // tenant-A performs a governed action.
    const subA = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a"));
    expect(subA.status).toBe("pending");
    if (subA.status !== "pending") return;
    const decidedA = await fleet.approve(ctxFor("tenant-a"), subA.id);
    expect(decidedA.status).toBe("executed");

    // tenant-B's console timeline does NOT contain tenant-A's event.
    const consoleA = fleet.console(ctxFor("tenant-a"));
    const consoleB = fleet.console(ctxFor("tenant-b"));
    expect(consoleA.ok && consoleB.ok).toBe(true);
    if (!consoleA.ok || !consoleB.ok) return;
    const tlA = await consoleA.console.timeline();
    const tlB = await consoleB.console.timeline();
    expect(tlA.events.length).toBeGreaterThanOrEqual(1);
    expect(tlB.events.length).toBe(0); // B saw nothing of A's action
    expect(tlB.tenantId).toBe("tenant-b");

    // The per-tenant WORM logs are DIFFERENT instances (NOT one shared log).
    expect(fleet.wormLogFor(ctxFor("tenant-a"))).not.toBe(fleet.wormLogFor(ctxFor("tenant-b")));
    expect(fleet.wormLogFor(ctxFor("tenant-a"))).toBeDefined();

    // tenant-B's inbox cannot approve an A-issued id (B's inbox does not know A's id).
    const bApprovesAId = await fleet.approve(ctxFor("tenant-b"), subA.id);
    expect(bApprovesAId.status).toBe("denied");

    // ...and the reverse: tenant-A's inbox cannot approve a B-issued id.
    const subB = fleet.submitForApproval(ctxFor("tenant-b"), callFor("tenant-b"));
    expect(subB.status).toBe("pending");
    if (subB.status !== "pending") return;
    const aApprovesBId = await fleet.approve(ctxFor("tenant-a"), subB.id);
    expect(aApprovesBId.status).toBe("denied");

    // INBOX INDEPENDENCE pinned DIRECTLY (not via the replay backstop above): A submits a FRESH id and
    // does NOT consume it. B cannot approve A's STILL-PENDING id, AND A's pending entry is UNTOUCHED by
    // B's attempt — A can still approve it. With ONE shared inbox, B's approve would consume/run A's
    // pending entry, so A's subsequent approve would fail "no pending" (not "executed"). Separate
    // per-tenant inboxes => B never reaches A's entry.
    const subAPending = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a"));
    expect(subAPending.status).toBe("pending");
    if (subAPending.status !== "pending") return;
    const bApprovesAPending = await fleet.approve(ctxFor("tenant-b"), subAPending.id);
    expect(bApprovesAPending.status).toBe("denied");
    const aApprovesOwnPending = await fleet.approve(ctxFor("tenant-a"), subAPending.id);
    expect(aApprovesOwnPending.status).toBe("executed"); // A's entry survived B's cross-tenant attempt

    // route(ctxB) never returns binding-A.
    const routedB = fleet.route(ctxFor("tenant-b"));
    expect(routedB.ok).toBe(true);
    if (routedB.ok) {
      expect(routedB.binding.tenantId).toBe("tenant-b");
      expect(routedB.binding.tenantId).not.toBe("tenant-a");
    }
    const routedA = fleet.route(ctxFor("tenant-a"));
    if (routedA.ok) expect(routedA.binding.tenantId).toBe("tenant-a");
  });

  it("(3) governance short-circuits PER TENANT: secret→denied@screen, no allow rule→denied@policy, tiny budget→denied@cost", async () => {
    // (3a) secret canary in the call → denied@screen (and never reaches the WORM/timeline).
    const fleetScreen = createEnterpriseFleet({ tenants: ["tenant-a"] });
    const subSecret = fleetScreen.submitForApproval(
      ctxFor("tenant-a"),
      callFor("tenant-a", { note: SECRET_CANARY }),
    );
    expect(subSecret.status).toBe("pending");
    if (subSecret.status !== "pending") return;
    const decidedSecret = await fleetScreen.approve(ctxFor("tenant-a"), subSecret.id);
    expect(decidedSecret.status).toBe("denied");
    if (decidedSecret.status === "denied") {
      expect(decidedSecret.outcome?.status).toBe("denied");
      if (decidedSecret.outcome?.status === "denied") {
        expect(decidedSecret.outcome.stage).toBe("screen");
      }
    }
    // Exit redaction: the canary never appears in this tenant's console timeline/fleet.
    const consoleScreen = fleetScreen.console(ctxFor("tenant-a"));
    if (consoleScreen.ok) {
      const tl = await consoleScreen.console.timeline();
      const fl = await consoleScreen.console.fleet();
      expect(JSON.stringify(tl)).not.toContain(SECRET_CANARY);
      expect(JSON.stringify(fl)).not.toContain(SECRET_CANARY);
      expect(tl.events.length).toBe(0); // denied@screen wrote nothing
    }

    // (3b) no allow rule (allowToolInvokePerTenant => false) → denied@policy.
    const fleetPolicy = createEnterpriseFleet({
      tenants: ["tenant-a"],
      allowToolInvokePerTenant: () => false,
    });
    const subPolicy = fleetPolicy.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a"));
    expect(subPolicy.status).toBe("pending");
    if (subPolicy.status !== "pending") return;
    const decidedPolicy = await fleetPolicy.approve(ctxFor("tenant-a"), subPolicy.id);
    expect(decidedPolicy.status).toBe("denied");
    if (decidedPolicy.status === "denied" && decidedPolicy.outcome?.status === "denied") {
      expect(decidedPolicy.outcome.stage).toBe("policy");
    }

    // (3c) tiny budget → denied@cost.
    const fleetCost = createEnterpriseFleet({
      tenants: ["tenant-a"],
      budgetPerTenant: 5,
      estimateTokens: 50,
    });
    const subCost = fleetCost.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a"));
    expect(subCost.status).toBe("pending");
    if (subCost.status !== "pending") return;
    const decidedCost = await fleetCost.approve(ctxFor("tenant-a"), subCost.id);
    expect(decidedCost.status).toBe("denied");
    if (decidedCost.status === "denied" && decidedCost.outcome?.status === "denied") {
      expect(decidedCost.outcome.stage).toBe("cost");
    }
  });

  it("(4) FAIL-CLOSED: unregistered tenant → route/submit denied; approve is one-time (replay denied)", async () => {
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a"] });

    // Unregistered tenant: route is deny-by-default.
    const routedGhost = fleet.route(ctxFor("tenant-ghost"));
    expect(routedGhost.ok).toBe(false);

    // Unregistered tenant: submitForApproval routes FIRST → denied (no inbox entry created).
    const subGhost = fleet.submitForApproval(ctxFor("tenant-ghost"), callFor("tenant-ghost"));
    expect(subGhost.status).toBe("denied");

    // Malformed context (empty tenantId) → route denied (fail-closed parse).
    const routedMalformed = fleet.route({ ...ctxFor("tenant-a"), tenantId: "" });
    expect(routedMalformed.ok).toBe(false);

    // approve is one-time: a second approve of the same id is denied (anti-replay).
    const sub = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a"));
    expect(sub.status).toBe("pending");
    if (sub.status !== "pending") return;
    const first = await fleet.approve(ctxFor("tenant-a"), sub.id);
    expect(first.status).toBe("executed");
    const second = await fleet.approve(ctxFor("tenant-a"), sub.id);
    expect(second.status).toBe("denied");
  });
});
