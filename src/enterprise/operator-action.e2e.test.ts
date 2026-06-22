/**
 * SLICE-ES3 — operator SENSITIVE-ACTION end-to-end proof (maker-checker gate + commit-before-effect
 * audit + tenant-scoped privileged effect) on the COMPOSED Enterprise fleet.
 *
 * ES1 ships the read side (route → governed pipeline → per-tenant WORM/console). R8-S5 ships
 * `enforceMakerChecker` (the maker≠checker capability-possession primitive) and P2-C ships
 * `commitBeforeEffect` (append-before-effect sequencing) — but as ISOLATED primitives. ES3 wires them
 * into a usable operator action端: `fleet.operatorAction(ctx, action, cap)` =
 *   route(ctx)〔gateway, fail-closed〕
 *     → enforceMakerChecker(ctx, action, cap)〔deny short-circuits — no effect, no audit〕
 *       → commitBeforeEffect(append operator AuditEvent → THAT tenant's WORM, await receipt → effect)
 *         → tenant-scoped effect (suspend-agent: repo `agent:<id>` phase="suspended").
 *
 * This e2e drives the WHOLE and adversarially asserts:
 *   (1) HAPPY: a valid cap → allow → operator AuditEvent lands THAT tenant's WORM (audit-BEFORE-effect)
 *       → effect runs → console(ctxA).fleet() shows the agent phase="suspended".
 *   (2) MAKER-CHECKER DENY (the core): cross-tenant cap / maker==checker / TOCTOU action-mismatch /
 *       malformed cap → denied, AND each leaves the EFFECT UN-RUN (fleet/repo unchanged). This is what
 *       a mutation that skips `enforceMakerChecker` (or ignores its deny) flips RED.
 *   (3) COMMIT-BEFORE-EFFECT: a forced WORM-append rejection → effect does NOT run (fleet unchanged) and
 *       operatorAction denies fail-closed. A mutation that runs the effect before/without the append
 *       flips this RED.
 *   (4) CROSS-TENANT ISOLATION: tenant-A's operatorAction never mutates tenant-B's fleet or WORM.
 *   (5) FAIL-CLOSED: an unregistered tenant ctx → route-first deny (before maker-checker, before audit).
 *
 * HONEST PREMISE: capability ISSUANCE is OUT-OF-BAND (who signs / where stored / how delivered to the
 * checker). ES3 builds the ENFORCE side only; this test SELF-CONSTRUCTS a valid cap — it does not
 * pretend issuance is solved and builds no issuer.
 *
 * RED-first: `fleet.operatorAction` / `OperatorResult` do not exist yet, so this suite fails to
 * type-check / import (exit != 0) until ES3 lands.
 */
import { describe, expect, it } from "vitest";
import { deriveActionIdentity } from "../tenant/index.js";
import { createEnterpriseFleet } from "./bootstrap.js";

/** A valid AgentContext for `tenantId`; `actorId` is the CHECKER acting. The router parses fail-closed. */
function ctxFor(tenantId: string, actorId = "agent:checker") {
  return {
    actorId,
    tenantId,
    projectId: `proj-${tenantId}`,
    taskId: `task-${tenantId}`,
    requestId: `req-${tenantId}`,
  };
}

/** The concrete ES3 action: suspend the agent running in `sandboxId`. resource = `agent:<sandboxId>`. */
function suspendAction(sandboxId: string) {
  return { kind: "suspend-agent", resource: `agent:${sandboxId}` };
}

/**
 * A VALID, independently-issued CheckerCapability (issuance is out-of-band — the test stands in for the
 * issuer). Bound to (ctx.tenantId, deriveActionIdentity(action), a maker who is NOT the checker).
 */
function validCap(
  ctx: { tenantId: string; actorId: string },
  action: { kind: string; resource: string },
  overrides: Partial<{
    tenantId: string;
    actionIdentity: string;
    makerActorId: string;
    capabilityRef: string;
  }> = {},
) {
  return {
    tenantId: ctx.tenantId,
    actionIdentity: deriveActionIdentity(action),
    makerActorId: "agent:maker", // distinct from ctx.actorId (the checker)
    capabilityRef: "cap-ref-opaque",
    ...overrides,
  };
}

describe("EnterpriseFleet.operatorAction — maker-checker gate + commit-before-effect (SLICE-ES3)", () => {
  it("(1) HAPPY: valid cap → allow → operator AuditEvent lands the tenant WORM, then suspend-agent effect; console shows phase=suspended", async () => {
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a", "tenant-b"] });
    const ctx = ctxFor("tenant-a");
    const action = suspendAction("sbx-1");
    const cap = validCap(ctx, action);

    const wormBefore = fleet.wormLogFor(ctx)?.entries().length ?? -1;
    expect(wormBefore).toBe(0);

    const res = await fleet.operatorAction(ctx, action, cap);
    expect(res.status).toBe("ok");

    // Audit-BEFORE-effect: exactly one operator AuditEvent landed THIS tenant's WORM, action=suspend-agent.
    const entries = fleet.wormLogFor(ctx)?.entries() ?? [];
    expect(entries.length).toBe(1);
    expect(entries[0]?.event.action).toBe("suspend-agent");
    expect(entries[0]?.event.resource).toBe("agent:sbx-1");
    expect(entries[0]?.event.tenantId).toBe("tenant-a");
    expect(entries[0]?.event.result).toBe("success");

    // Effect ran: console(ctxA).fleet() projects the suspended agent (AGENT_PREFIX `agent:` shape).
    const consoleA = fleet.console(ctx);
    expect(consoleA.ok).toBe(true);
    if (!consoleA.ok) return;
    const fleetView = await consoleA.console.fleet();
    const suspended = fleetView.agents.find((a) => a.sandboxId === "sbx-1");
    expect(suspended?.phase).toBe("suspended");
  });

  it("(2) MAKER-CHECKER DENY (the core): cross-tenant / maker==checker / TOCTOU / malformed → denied AND the effect never runs (fleet unchanged)", async () => {
    // Each sub-case: a FRESH fleet, attempt operatorAction with a BAD cap, assert denied AND that the
    // tenant's fleet/WORM is UNCHANGED (the effect did not run). This is the non-vacuity anchor: skipping
    // enforceMakerChecker (or ignoring its deny) would let the suspend-agent effect run → these flip RED.

    // (2a) cross-tenant capability: cap.tenantId !== ctx.tenantId → denied.
    {
      const fleet = createEnterpriseFleet({ tenants: ["tenant-a", "tenant-b"] });
      const ctx = ctxFor("tenant-a");
      const action = suspendAction("sbx-1");
      const cap = validCap(ctx, action, { tenantId: "tenant-b" });
      const res = await fleet.operatorAction(ctx, action, cap);
      expect(res.status).toBe("denied");
      expect(fleet.wormLogFor(ctx)?.entries().length).toBe(0);
      const view = fleet.console(ctx);
      if (view.ok) expect((await view.console.fleet()).agents.length).toBe(0);
    }

    // (2b) maker == checker: cap.makerActorId === ctx.actorId → denied (same person both sides).
    {
      const fleet = createEnterpriseFleet({ tenants: ["tenant-a"] });
      const ctx = ctxFor("tenant-a", "agent:self");
      const action = suspendAction("sbx-1");
      const cap = validCap(ctx, action, { makerActorId: "agent:self" });
      const res = await fleet.operatorAction(ctx, action, cap);
      expect(res.status).toBe("denied");
      expect(fleet.wormLogFor(ctx)?.entries().length).toBe(0);
      const view = fleet.console(ctx);
      if (view.ok) expect((await view.console.fleet()).agents.length).toBe(0);
    }

    // (2c) TOCTOU: cap bound to action X, operatorAction invoked with action Y (rederive mismatch) → denied.
    {
      const fleet = createEnterpriseFleet({ tenants: ["tenant-a"] });
      const ctx = ctxFor("tenant-a");
      const actionX = suspendAction("sbx-1");
      const actionY = suspendAction("sbx-2");
      const cap = validCap(ctx, actionX); // capability is for sbx-1...
      const res = await fleet.operatorAction(ctx, actionY, cap); // ...but we call for sbx-2
      expect(res.status).toBe("denied");
      expect(fleet.wormLogFor(ctx)?.entries().length).toBe(0);
      const view = fleet.console(ctx);
      if (view.ok) expect((await view.console.fleet()).agents.length).toBe(0);
    }

    // (2d) malformed cap: a required field empty → denied (fail-closed schema).
    {
      const fleet = createEnterpriseFleet({ tenants: ["tenant-a"] });
      const ctx = ctxFor("tenant-a");
      const action = suspendAction("sbx-1");
      const cap = validCap(ctx, action, { capabilityRef: "" });
      const res = await fleet.operatorAction(ctx, action, cap);
      expect(res.status).toBe("denied");
      expect(fleet.wormLogFor(ctx)?.entries().length).toBe(0);
      const view = fleet.console(ctx);
      if (view.ok) expect((await view.console.fleet()).agents.length).toBe(0);
    }
  });

  it("(3) COMMIT-BEFORE-EFFECT: a forced WORM-append rejection → effect does NOT run (fleet unchanged) and operatorAction denies fail-closed", async () => {
    // Force THIS tenant's WORM append to reject. commitBeforeEffect must REFUSE the effect (append-first),
    // so the suspend never reaches the repo. A mutation running the effect before/without the receipt
    // flips this RED (fleet would show phase=suspended despite the audit failure).
    const fleet = createEnterpriseFleet({
      tenants: ["tenant-a"],
      failWormAppendFor: (tenantId) => tenantId === "tenant-a",
    });
    const ctx = ctxFor("tenant-a");
    const action = suspendAction("sbx-1");
    const cap = validCap(ctx, action);

    const res = await fleet.operatorAction(ctx, action, cap);
    expect(res.status).toBe("denied"); // fail-closed: no durable receipt ⇒ effect refused

    // The effect did NOT run: WORM has no committed operator event AND fleet shows no suspended agent.
    expect(fleet.wormLogFor(ctx)?.entries().length).toBe(0);
    const view = fleet.console(ctx);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect((await view.console.fleet()).agents.length).toBe(0);
  });

  it("(4) CROSS-TENANT ISOLATION: tenant-A's operatorAction never mutates tenant-B's fleet or WORM", async () => {
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a", "tenant-b"] });
    const ctxA = ctxFor("tenant-a");
    const action = suspendAction("sbx-1");
    const capA = validCap(ctxA, action);

    const res = await fleet.operatorAction(ctxA, action, capA);
    expect(res.status).toBe("ok");

    // tenant-B's WORM and fleet are UNTOUCHED — independent instances, closure-bound by route.
    const ctxB = ctxFor("tenant-b");
    expect(fleet.wormLogFor(ctxB)?.entries().length).toBe(0);
    expect(fleet.wormLogFor(ctxA)).not.toBe(fleet.wormLogFor(ctxB));
    const consoleB = fleet.console(ctxB);
    expect(consoleB.ok).toBe(true);
    if (!consoleB.ok) return;
    expect((await consoleB.console.fleet()).agents.length).toBe(0);
  });

  it("(5) FAIL-CLOSED: an unregistered tenant ctx → route-first deny (before maker-checker, before audit)", async () => {
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a"] });
    const ctxGhost = ctxFor("tenant-ghost");
    const action = suspendAction("sbx-1");
    // A structurally VALID cap (so the deny can ONLY come from route, proving route runs FIRST).
    const cap = validCap(ctxGhost, action);

    const res = await fleet.operatorAction(ctxGhost, action, cap);
    expect(res.status).toBe("denied");
    // No WORM exists for an unrouted tenant — route-first means nothing was appended anywhere.
    expect(fleet.wormLogFor(ctxGhost)).toBeUndefined();
  });
});
