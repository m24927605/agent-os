/**
 * SLICE-DVx — INJECTED ToolRegistry on the Personal surface (registry-backed deny-by-default).
 *
 * Proves the NEW `PersonalShellOpts.toolRegistry` seam:
 *   - WITH a registry injected, `createPersonalShell`'s authorize gains a registry deny-by-default
 *     pre-screen IN FRONT of the existing `personal:*` PDP: an UNREGISTERED tool is denied@authorize
 *     (mapped to the pipeline's `policy` stage) BEFORE the PDP/cost/effect, and the effect never runs.
 *   - WITH the tool registered into that same registry, the call passes the registry pre-screen and the
 *     EXISTING `personal:*` PDP, so it executes (commit-before-effect lands one WORM event).
 *   - The registry pre-screen can ONLY deny more — it never grants. allowToolInvoke:false still
 *     denies@policy (the EXISTING PDP) even for a REGISTERED tool.
 *
 * The Personal surface derives `tool: personal:<action>` (buildToolCall, bootstrap.ts:121-127) and the
 * authorize `resource` is that string — which IS the registry key. So the registered manifest `name`
 * MUST equal `personal:<action>` for the registered-tool path to pass the registry `has()` check.
 *
 * NON-VACUITY (the mutations a reviewer runs):
 *   (a) injected-but-bypass-registry (authorize still uses the wildcard PDP only) => the UNREGISTERED
 *       deny test (executes instead of denies) flips RED.
 *   (b) default-also-goes-through-registry (drop the `opts.toolRegistry ?` conditional) => the EXISTING
 *       bootstrap.e2e (no registry, happy path) executes are denied@policy => RED. (covered by that suite)
 *
 * RED-first: `PersonalShellOpts.toolRegistry` does not exist yet, so this suite fails to type/compile.
 */
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../iam/ids.js";
import { ToolRegistry } from "../tools/index.js";
import { createPersonalShell } from "./bootstrap.js";
import { StructuredIntent } from "./intent/index.js";

const ctx: AgentContext = StructuredIntent.shape.context.parse({
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
});

/** A clean, parseable intent text that resolves to action "backup" -> tool "personal:backup". */
const LEGAL_TEXT = "backup notes archive";
/** The tool string the Personal surface derives for the "backup" action (the registry key). */
const PERSONAL_TOOL = "personal:backup";

/** A valid 9-field manifest whose `name` IS the Personal-derived tool string (the registry key). */
function manifestFor(name: string): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    description: "a registered personal tool",
    action: "invoke",
    resourcePattern: `${name}:*`,
    sideEffect: "read",
    idempotent: true,
    requiresApproval: false,
    bundleRefOnly: true,
    containment: "in-sandbox",
  };
}

describe("createPersonalShell — INJECTED ToolRegistry registry-backed deny-by-default (SLICE-DVx)", () => {
  it("UNREGISTERED: toolRegistry injected (empty) + allowToolInvoke:true -> denied@authorize (policy stage), NO effect", async () => {
    const registry = new ToolRegistry(); // empty -> personal:backup is NOT registered
    const shell = createPersonalShell({
      budget: 1000,
      allowToolInvoke: true,
      toolRegistry: registry,
    });

    const received = shell.receive(LEGAL_TEXT, ctx);
    expect(received.status).toBe("intent");
    if (received.status !== "intent") return;

    const submitted = shell.previewAndSubmit(received.intent);
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") return;

    const decided = await shell.approve(submitted.id);
    // The registry deny-by-default runs IN FRONT of the (granting) personal:* PDP -> denied@authorize.
    expect(decided).toMatchObject({ status: "denied" });
    expect(decided.outcome).toMatchObject({ status: "denied", stage: "policy" });

    // The effect never ran -> no sandbox created, nothing committed to the WORM/timeline.
    expect((await shell.probeLastSandbox()).status).toBe("denied");
    expect((await shell.timeline(ctx.taskId)).length).toBe(0);
  });

  it("REGISTERED: the tool is registered in the injected registry + allowToolInvoke:true -> executed + completed timeline", async () => {
    const registry = new ToolRegistry();
    registry.register(manifestFor(PERSONAL_TOOL)); // personal:backup IS now registered
    const shell = createPersonalShell({
      budget: 1000,
      allowToolInvoke: true,
      toolRegistry: registry,
    });

    const received = shell.receive(LEGAL_TEXT, ctx);
    expect(received.status).toBe("intent");
    if (received.status !== "intent") return;

    const submitted = shell.previewAndSubmit(received.intent);
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") return;

    const decided = await shell.approve(submitted.id);
    expect(decided.status).toBe("executed");
    if (decided.status !== "executed") return;
    expect(decided.outcome.status).toBe("executed");

    // The registered tool passed both the registry pre-screen AND the personal:* PDP -> real effect.
    expect((await shell.probeLastSandbox()).status).toBe("ok");
    const events = await shell.timeline(ctx.taskId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.headline.startsWith("已完成"))).toBe(true);
  });

  it("DENY-ONLY: a REGISTERED tool with allowToolInvoke:false is still denied@policy (the registry never GRANTS)", async () => {
    const registry = new ToolRegistry();
    registry.register(manifestFor(PERSONAL_TOOL)); // registered, but the PDP allow set is empty
    const shell = createPersonalShell({
      budget: 1000,
      allowToolInvoke: false,
      toolRegistry: registry,
    });

    const received = shell.receive(LEGAL_TEXT, ctx);
    expect(received.status).toBe("intent");
    if (received.status !== "intent") return;

    const submitted = shell.previewAndSubmit(received.intent);
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") return;

    const decided = await shell.approve(submitted.id);
    // Registry HAS the tool -> delegates to the PDP, which denies (no allow rule). Registry adds deny,
    // never grant: the EXISTING personal:* PDP remains the sole grant authority.
    expect(decided).toMatchObject({ status: "denied" });
    expect(decided.outcome).toMatchObject({ status: "denied", stage: "policy" });
    expect((await shell.probeLastSandbox()).status).toBe("denied");
  });
});
