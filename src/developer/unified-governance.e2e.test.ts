/**
 * SLICE-DVx — THE CROSS-SURFACE UNIFIED proof (the central slice deliverable).
 *
 * Build ONE `ToolRegistry`, register the per-surface tool name each surface actually invokes, and inject
 * the SAME registry instance into `createPersonalShell` + `createEnterpriseFleet` + `createDeveloperKit`.
 * Then assert the UNIFIED registry deny-by-default in ALL THREE:
 *   - a REGISTERED tool is governed-and-executed on EVERY surface;
 *   - an UNREGISTERED tool is denied@authorize (deny-by-default; pipeline `policy` stage) on EVERY surface.
 *
 * This is "ONE governance core" made real down to "誰能做什麼": a single developer-registered tool
 * catalog + a single registry-backed deny-by-default admission, identical across Personal / Enterprise /
 * Developer. The registry being the SAME instance is the unification — not three parallel policies.
 *
 * Each surface derives its authorize `resource` (== the registry key) differently, and each has its own
 * allow namespace (personal:* / fleet:* / dev:*). So the ONE registry holds the per-surface tool NAME
 * each surface invokes; "registered" means that name is in the shared catalog. The author manifests use
 * resourcePatterns/names that match each surface's allow namespace so the registered tool also passes
 * each surface's EXISTING PDP — isolating the registry deny-by-default as the unified admission gate.
 *
 * NON-VACUITY (the mutation the reviewer runs): if ANY ONE surface is NOT wired to the injected registry
 * (e.g. Personal ignores opts.toolRegistry, or Developer keeps its own internal registry), then either
 * that surface's UNREGISTERED tool executes (the deny assertion flips RED) or its REGISTERED tool is
 * denied (the executed assertion flips RED). All three surfaces must consult the SAME registry to pass.
 *
 * RED-first: the three `toolRegistry` opts do not exist yet, so this suite fails to type/compile.
 */
import { describe, expect, it } from "vitest";
import { createEnterpriseFleet } from "../enterprise/bootstrap.js";
import type { AgentContext } from "../iam/ids.js";
import type { GovernedCall } from "../orchestration/index.js";
import { createPersonalShell } from "../personal/bootstrap.js";
import { StructuredIntent } from "../personal/intent/index.js";
import { ToolRegistry } from "../tools/index.js";
import { createDeveloperKit } from "./bootstrap.js";

// ── The per-surface tool NAMES the ONE shared registry must hold for a "registered" tool ──
// Personal derives `personal:<action>`; the "backup" action -> "personal:backup".
const PERSONAL_TOOL = "personal:backup";
// Enterprise takes the tool string directly; matches the per-tenant fleet:* PDP.
const FLEET_TOOL = "fleet:run";
// Developer takes the manifest name directly; matches the kit's default dev:* PDP.
const DEV_TOOL = "dev:echo";

/** A valid 9-field manifest whose `name` IS the surface's tool string (the registry key). */
function manifestFor(name: string): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    description: "a unified-catalog tool",
    action: "invoke",
    resourcePattern: `${name}:*`,
    sideEffect: "read",
    idempotent: true,
    requiresApproval: false,
    bundleRefOnly: true,
    containment: "in-sandbox",
  };
}

const personalCtx: AgentContext = StructuredIntent.shape.context.parse({
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
});

const devCtx: AgentContext = {
  actorId: "agent:dev",
  tenantId: "tenant-dev",
  projectId: "proj-dev",
  taskId: "task-dev",
  requestId: "req-dev",
} as AgentContext;

function fleetCtx(tenantId: string) {
  return {
    actorId: "agent:claude",
    tenantId,
    projectId: `proj-${tenantId}`,
    taskId: `task-${tenantId}`,
    requestId: `req-${tenantId}`,
  };
}

function fleetCall(tenantId: string, tool: string): GovernedCall {
  return { tool, context: fleetCtx(tenantId), ...{ args: {} } } as GovernedCall;
}

/** Drive Personal to the governed decision for the "backup" action; return its outcome status+stage. */
async function runPersonal(registry: ToolRegistry): Promise<{ status: string; stage?: string }> {
  const shell = createPersonalShell({
    budget: 1000,
    allowToolInvoke: true,
    toolRegistry: registry,
  });
  const received = shell.receive("backup notes archive", personalCtx);
  if (received.status !== "intent") return { status: "no-intent" };
  const submitted = shell.previewAndSubmit(received.intent);
  if (submitted.status !== "pending") return { status: submitted.status };
  const decided = await shell.approve(submitted.id);
  if (decided.status === "executed") return { status: "executed" };
  const outcome = decided.outcome;
  return { status: "denied", stage: outcome?.status === "denied" ? outcome.stage : undefined };
}

/** Drive Enterprise (one tenant) to the governed decision; return its outcome status+stage. */
async function runEnterprise(
  registry: ToolRegistry,
  tool: string,
): Promise<{ status: string; stage?: string }> {
  const fleet = createEnterpriseFleet({ tenants: ["tenant-a"], toolRegistry: registry });
  const submitted = fleet.submitForApproval(fleetCtx("tenant-a"), fleetCall("tenant-a", tool));
  if (submitted.status !== "pending") return { status: submitted.status };
  const decided = await fleet.approve(fleetCtx("tenant-a"), submitted.id);
  if (decided.status === "executed") return { status: "executed" };
  const outcome = decided.outcome;
  return { status: "denied", stage: outcome?.status === "denied" ? outcome.stage : undefined };
}

/** Drive Developer to the governed decision; return its outcome status+stage. */
async function runDeveloper(
  registry: ToolRegistry,
  tool: string,
): Promise<{ status: string; stage?: string }> {
  const kit = createDeveloperKit({ toolRegistry: registry });
  const outcome = await kit.runTool({ tool, context: devCtx, args: {} });
  if (outcome.status === "executed") return { status: "executed" };
  return { status: "denied", stage: outcome.stage };
}

describe("UNIFIED governance — ONE ToolRegistry -> Personal + Enterprise + Developer (SLICE-DVx)", () => {
  it("REGISTERED tool is governed-and-EXECUTED on ALL THREE surfaces (one shared registry)", async () => {
    // ONE registry, register the per-surface tool NAME each surface invokes.
    const registry = new ToolRegistry();
    registry.register(manifestFor(PERSONAL_TOOL));
    registry.register(manifestFor(FLEET_TOOL));
    registry.register(manifestFor(DEV_TOOL));

    // Inject the SAME instance into all three surfaces.
    const personal = await runPersonal(registry);
    const enterprise = await runEnterprise(registry, FLEET_TOOL);
    const developer = await runDeveloper(registry, DEV_TOOL);

    expect(personal.status).toBe("executed");
    expect(enterprise.status).toBe("executed");
    expect(developer.status).toBe("executed");
  });

  it("UNREGISTERED tool is DENIED@authorize (deny-by-default, policy stage) on ALL THREE surfaces", async () => {
    // ONE registry, EMPTY — no surface's tool name is registered.
    const registry = new ToolRegistry();

    const personal = await runPersonal(registry);
    const enterprise = await runEnterprise(registry, FLEET_TOOL);
    const developer = await runDeveloper(registry, DEV_TOOL);

    // deny-by-default fires the SAME way on every surface: denied at the pipeline's authorize/policy gate.
    expect(personal).toMatchObject({ status: "denied", stage: "policy" });
    expect(enterprise).toMatchObject({ status: "denied", stage: "policy" });
    expect(developer).toMatchObject({ status: "denied", stage: "policy" });
  });

  it("PARTIAL catalog: only DEV_TOOL registered -> Developer executes, Personal+Enterprise (unregistered) denied@authorize", async () => {
    // Proves the registry is the SINGLE source of admission: registering ONLY dev:echo admits ONLY the
    // Developer call; Personal (personal:backup) + Enterprise (fleet:run) are unregistered in the SAME
    // registry, so both are denied-by-default. The shared catalog decides every surface uniformly.
    const registry = new ToolRegistry();
    registry.register(manifestFor(DEV_TOOL));

    const personal = await runPersonal(registry);
    const enterprise = await runEnterprise(registry, FLEET_TOOL);
    const developer = await runDeveloper(registry, DEV_TOOL);

    expect(developer.status).toBe("executed");
    expect(personal).toMatchObject({ status: "denied", stage: "policy" });
    expect(enterprise).toMatchObject({ status: "denied", stage: "policy" });
  });
});
