/**
 * SLICE-DVx — INJECTED ToolRegistry on the Enterprise fleet (PLATFORM-WIDE shared catalog).
 *
 * Proves the NEW `EnterpriseFleetOpts.toolRegistry` seam: ONE platform-wide registry, consulted by
 * EVERY tenant's per-tenant authorize as a registry deny-by-default pre-screen IN FRONT of the EXISTING
 * per-tenant `fleet:*` PDP:
 *   - WITH a registry injected, a tenant submitForApproval/approve of an UNREGISTERED tool is
 *     denied@authorize (pipeline `policy` stage) BEFORE the per-tenant PDP/cost/effect.
 *   - WITH the tool registered, the call passes the registry pre-screen AND the per-tenant fleet:* PDP
 *     -> executed (console timeline reflects it).
 *   - TENANT ISOLATION is UNAFFECTED: the registry only ADDS a deny gate in front of the existing
 *     per-tenant PDP; per-tenant WORM/inbox/routing are untouched (one tenant's registered tool does
 *     NOT grant another tenant a non-routing path — each tenant still routes to its OWN binding/PDP).
 *
 * The Enterprise surface takes the `tool` string directly on the GovernedCall and the authorize
 * `resource` is that string (the registry key). The per-tenant allow rule is `fleet:*`, so the
 * registered manifest `name` MUST be a `fleet:<x>` string for the registered path to pass BOTH gates.
 *
 * NON-VACUITY:
 *   (a) injected-but-bypass-registry (per-tenant authorize still uses the fleet:* PDP only) => the
 *       UNREGISTERED deny test executes instead of denies => RED.
 *   (b) default-also-goes-through-registry (drop the conditional) => the EXISTING ES1 cross-tenant +
 *       ES3 operator e2e (no registry) flip RED. (covered by those suites + verify:cross-tenant)
 *
 * RED-first: `EnterpriseFleetOpts.toolRegistry` does not exist yet, so this suite fails to type/compile.
 */
import { describe, expect, it } from "vitest";
import type { GovernedCall } from "../orchestration/index.js";
import { ToolRegistry } from "../tools/index.js";
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

/** A GovernedCall whose `tool` is `tool` (the registry key / authorize resource) for `tenantId`. */
function callFor(tenantId: string, tool: string): GovernedCall {
  return { tool, context: ctxFor(tenantId), ...{ args: {} } } as GovernedCall;
}

/** A valid 9-field manifest whose `name` IS the fleet tool string (the registry key). */
function manifestFor(name: string): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    description: "a registered fleet tool",
    action: "invoke",
    resourcePattern: `${name}:*`,
    sideEffect: "read",
    idempotent: true,
    requiresApproval: false,
    bundleRefOnly: true,
  };
}

describe("createEnterpriseFleet — INJECTED platform-wide ToolRegistry deny-by-default (SLICE-DVx)", () => {
  it("UNREGISTERED: registry injected (empty) -> a tenant's submit/approve of an unregistered tool is denied@authorize", async () => {
    const registry = new ToolRegistry(); // empty -> fleet:run is NOT registered
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a"], toolRegistry: registry });

    const submitted = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a", "fleet:run"));
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") return;

    const decided = await fleet.approve(ctxFor("tenant-a"), submitted.id);
    expect(decided.status).toBe("denied");
    if (decided.status === "denied" && decided.outcome?.status === "denied") {
      // The platform registry deny-by-default runs IN FRONT of the per-tenant fleet:* PDP.
      expect(decided.outcome.stage).toBe("policy");
    }

    // The effect never ran -> the tenant's console timeline is empty (nothing committed to its WORM).
    const consoleA = fleet.console(ctxFor("tenant-a"));
    expect(consoleA.ok).toBe(true);
    if (!consoleA.ok) return;
    expect((await consoleA.console.timeline()).events.length).toBe(0);
  });

  it("REGISTERED: the tool is in the injected platform registry -> a tenant's call executes (console reflects it)", async () => {
    const registry = new ToolRegistry();
    registry.register(manifestFor("fleet:run")); // fleet:run registered in the shared catalog
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a"], toolRegistry: registry });

    const submitted = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a", "fleet:run"));
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") return;

    const decided = await fleet.approve(ctxFor("tenant-a"), submitted.id);
    expect(decided.status).toBe("executed");
    if (decided.status === "executed") {
      expect(decided.outcome.status).toBe("executed");
    }

    const consoleA = fleet.console(ctxFor("tenant-a"));
    expect(consoleA.ok).toBe(true);
    if (!consoleA.ok) return;
    expect((await consoleA.console.timeline()).events.length).toBeGreaterThanOrEqual(1);
  });

  it("TENANT ISOLATION holds under the platform registry: each tenant routes to its OWN binding/WORM; registry adds only a deny gate", async () => {
    const registry = new ToolRegistry();
    registry.register(manifestFor("fleet:run")); // shared catalog, used by BOTH tenants
    const fleet = createEnterpriseFleet({
      tenants: ["tenant-a", "tenant-b"],
      toolRegistry: registry,
    });

    // tenant-A runs the registered tool.
    const subA = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a", "fleet:run"));
    expect(subA.status).toBe("pending");
    if (subA.status !== "pending") return;
    const decidedA = await fleet.approve(ctxFor("tenant-a"), subA.id);
    expect(decidedA.status).toBe("executed");

    // tenant-B saw NOTHING of A's action (independent per-tenant WORM/inbox/repo are unchanged by DVx).
    const consoleA = fleet.console(ctxFor("tenant-a"));
    const consoleB = fleet.console(ctxFor("tenant-b"));
    expect(consoleA.ok && consoleB.ok).toBe(true);
    if (!consoleA.ok || !consoleB.ok) return;
    expect((await consoleA.console.timeline()).events.length).toBeGreaterThanOrEqual(1);
    expect((await consoleB.console.timeline()).events.length).toBe(0);

    // Per-tenant WORM logs are still DIFFERENT instances (DVx did not collapse isolation).
    expect(fleet.wormLogFor(ctxFor("tenant-a"))).not.toBe(fleet.wormLogFor(ctxFor("tenant-b")));

    // B's inbox cannot approve an A-issued id (per-tenant inbox independence unchanged).
    expect((await fleet.approve(ctxFor("tenant-b"), subA.id)).status).toBe("denied");

    // An unregistered tenant still routes fail-closed (registry is a deny gate, not a routing change).
    expect(fleet.route(ctxFor("tenant-ghost")).ok).toBe(false);
  });
});
