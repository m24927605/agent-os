/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *  REFERENCE COMPOSITION ROOT — the ENTERPRISE surface.
 *
 *  This is the canonical "run a surface" entry point for the Enterprise vertical. COPY THIS FILE and
 *  replace the in-memory seams with your real adapters for production. Out of the box it composes the
 *  already-built R8 isolation primitives (TenantRouter / InMemoryTenantStore / ConsoleProjection) into
 *  ONE runnable, multi-tenant, tenant-sealed governed fleet over a PURELY in-memory backbone — NO
 *  kernel process, NO docker, NO vendor, NO network, ZERO external deps. It demonstrates a REAL governed
 *  outcome via the privileged operator path (the console/governance spine):
 *
 *      route(ctx) 〔gateway, fail-closed〕
 *        → enforceMakerChecker(ctx, action, cap) 〔maker≠checker capability gate, deny short-circuits〕
 *          → commitBeforeEffect(append operator AuditEvent → THAT tenant's WORM → effect)
 *            → tenant-scoped effect (suspend-agent) → console(ctx).fleet() shows phase="suspended"
 *
 *  ── ADOPTER SEAMS (what to replace for production) ────────────────────────────────────────────────
 *    • tenants                : pre-provisioned at construction here. PRODUCTION: also `registerTenant` /
 *                               `deprovisionTenant` at runtime; per tenant gets INDEPENDENT WORM/cost/inbox.
 *    • wormSinkFor            : DEFAULT = per-tenant in-memory `InMemoryAppendOnlyLog`. PRODUCTION: inject
 *                               `createPartitionedIngestSink(transport, binding)` so each tenant's events
 *                               land in the kernel's INDEPENDENT per-tenant WORM partition.
 *    • costGateFor            : DEFAULT = per-tenant `InMemoryCostGate`. PRODUCTION: inject a per-tenant
 *                               real spend gate (the factory builds an INDEPENDENT gate per tenant).
 *    • allowToolInvokePerTenant : DEFAULT = allow-all-tenants. PRODUCTION: drive your per-tenant policy.
 *    • toolRegistry / secondaries : optional platform-wide deny-only admission / advisory adapters.
 *    • checker capability     : ISSUANCE is OUT-OF-BAND (who signs / where stored / how delivered). This
 *                               example SELF-CONSTRUCTS a valid cap to drive the ENFORCE side — it does
 *                               NOT pretend issuance is solved and builds no issuer. PRODUCTION supplies
 *                               a real, independently-issued capability to the checker.
 *
 *  HONEST SCOPE: every seam below is a FAKE (in-memory store/log, in-process signing key, self-issued
 *  cap); the example shows the WIRING (route → maker-checker → commit-before-effect → tenant-scoped
 *  effect). Production swaps the fakes for real adapters across the SAME deploy-gated boundary.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { createEnterpriseFleet } from "../../dist/enterprise/index.js";
import { deriveActionIdentity } from "../../dist/tenant/index.js";

/** The concise, credential-blind governed-outcome summary `main()` prints and the test asserts on. */
export interface EnterpriseRunSummary {
  readonly surface: "enterprise";
  /** The governed decision for the operator action: "ok" (committed + effect ran) or "denied". */
  readonly decision: string;
  /** The tenant the action was routed to (a non-secret demo tenant id). */
  readonly tenant: string;
  /** Number of operator AuditEvents committed to THIS tenant's WORM (audit-before-effect). */
  readonly wormEventCount: number;
  /** Whether the per-tenant console projects the target agent as phase="suspended" (effect ran). */
  readonly agentSuspended: boolean;
  /** True when this fleet used ONLY in-memory defaults (no live partition sink / external gate). */
  readonly usedInMemoryDefaults: true;
}

/** A valid AgentContext for a tenant; `actorId` is the CHECKER acting (distinct from the maker below). */
function ctxFor(tenantId: string) {
  return {
    actorId: "agent:checker",
    tenantId,
    projectId: `proj-${tenantId}`,
    taskId: `task-${tenantId}`,
    requestId: `req-${tenantId}`,
  };
}

/**
 * Run the Enterprise reference composition root end-to-end and return a governed-outcome summary.
 * Exported so the acceptance test drives the SAME flow `main()` runs (no duplicate wiring).
 */
export async function runExample(): Promise<EnterpriseRunSummary> {
  // ── THE COMPOSITION ROOT ── two pre-provisioned tenants, each with INDEPENDENT WORM/cost/inbox.
  const fleet = createEnterpriseFleet({ tenants: ["tenant-a", "tenant-b"] });

  const tenant = "tenant-a";
  const ctx = ctxFor(tenant);
  // The concrete privileged action: suspend the agent running in `sandboxId` (resource `agent:<id>`).
  const action = { kind: "suspend-agent", resource: "agent:sbx-1" };

  // A VALID, independently-issued CheckerCapability (issuance is OUT-OF-BAND — self-constructed here for
  // the demo). Bound to (ctx.tenantId, the action's derived identity, a MAKER who is NOT the checker).
  const cap = {
    tenantId: ctx.tenantId,
    actionIdentity: deriveActionIdentity(action),
    makerActorId: "agent:maker", // distinct from ctx.actorId (the checker) — maker≠checker.
    capabilityRef: "cap-ref-opaque", // an opaque reference, never a secret/credential.
  };

  // route → maker-checker → commit-before-effect → tenant-scoped suspend-agent effect.
  const result = await fleet.operatorAction(ctx, action, cap);

  // Read back THIS tenant's WORM (the operator AuditEvent committed before the effect) + the console.
  const wormEventCount = fleet.wormLogFor(ctx)?.entries().length ?? 0;
  let agentSuspended = false;
  const view = fleet.console(ctx);
  if (view.ok) {
    const fleetView = await view.console.fleet();
    agentSuspended = fleetView.agents.some(
      (a) => a.sandboxId === "sbx-1" && a.phase === "suspended",
    );
  }

  return {
    surface: "enterprise",
    decision: result.status,
    tenant,
    wormEventCount,
    agentSuspended,
    usedInMemoryDefaults: true,
  };
}

/** Standalone run: `node examples/surfaces/run-enterprise-fleet.ts` (after `pnpm build`). */
async function main(): Promise<void> {
  const s = await runExample();
  // Credential-blind by construction: only neutral governed fields are printed (no cap secret, no ctx).
  console.log("[enterprise] governed outcome:", JSON.stringify(s, null, 2));
  if (s.decision !== "ok" || s.wormEventCount < 1 || !s.agentSuspended) {
    console.error("[enterprise] FAILED: expected ok + a committed WORM event + a suspended agent");
    process.exit(1);
  }
  console.log(
    "[enterprise] OK — maker-checker ok + audit-before-effect + suspended-agent projection.",
  );
}

// import.meta-guarded run: executes only when this file is the entrypoint, never when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
