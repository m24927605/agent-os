/**
 * SLICE-IT1a — INJECTABLE costGate + advisory secondaries on the Developer kit (DVx-style).
 *
 * Proves the NEW vendor-neutral injection seams on `DeveloperKitOpts`:
 *   - `costGate?: CostGate` -> `const cost = opts.costGate ?? new InMemoryCostGate(budget)`.
 *     Injecting an always-DENY CostGate makes a REGISTERED+granted tool call denied@cost; the effect
 *     never runs (no sandbox; WORM empty). NON-VACUITY: without the injection (still `new
 *     InMemoryCostGate(budget)`) this call EXECUTES -> the test flips RED.
 *   - `secondaries?: readonly SecondaryPolicyAdapter[]` -> `combineDecisions(decision, opts.secondaries
 *     ?? [])`. An always-DENY advisory makes a REGISTERED+granted call denied@policy (any-deny-wins).
 *     An always-ALLOW advisory does NOT relax a PDP/registry deny: an UNREGISTERED tool is STILL
 *     denied@policy (the registry-backed PDP is the sole grant authority).
 *   - ABSENT (no costGate/secondaries) => BYTE-IDENTICAL to today: the SAME InMemoryCostGate happy path
 *     (the existing bootstrap.e2e stays green; here we re-assert a tiny budget still denies@cost with
 *     no injection, and the ample-budget default still executes).
 *
 * The kit imports ONLY the vendor-neutral `CostGate` + `SecondaryPolicyAdapter` PORT types — never
 * SpendGuard/AGT. The injection only NARROWS; the registry-backed PDP stays sovereign.
 *
 * RED-first: `DeveloperKitOpts.costGate` / `.secondaries` do not exist yet, so this suite fails to
 * type/compile.
 */
import { describe, expect, it } from "vitest";
import {
  type CommitResult,
  type CostGate,
  type ReleaseResult,
  type ReserveRequest,
  type ReserveResult,
  denyReserve,
} from "../cost/index.js";
import type { AgentContext } from "../iam/ids.js";
import type { PolicyDecision, PolicyRequest, SecondaryPolicyAdapter } from "../policy/index.js";
import { createDeveloperKit } from "./bootstrap.js";

const ctx: AgentContext = {
  actorId: "agent:dev",
  tenantId: "tenant-dev",
  projectId: "proj-dev",
  taskId: "task-dev",
  requestId: "req-dev",
} as AgentContext;

/** A valid 9-field manifest in the kit's default `dev:` namespace (so the default allow rule matches). */
function validManifest(name = "dev:echo"): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    description: "echo tool for the developer kit",
    action: "invoke",
    resourcePattern: "dev:echo:*",
    sideEffect: "read",
    idempotent: true,
    requiresApproval: false,
    bundleRefOnly: true,
  };
}

function toolCall(tool: string, args: Record<string, unknown> = {}) {
  return { tool, context: ctx, args };
}

// A runtime-ASSEMBLED secret canary (never a literal in source — keeps secret-scan clean).
const SECRET_CANARY = `sk-${"d".repeat(24)}`;

/**
 * A hostile/buggy advisory whose `reason` carries a SECRET. It ALLOWS (so the combined reason is
 * folded into the committed AuditEvent on the WRITE path). The kit MUST scrub the secondary-derived
 * reason before it reaches the WORM — note replayFold folds the RAW WORM (no read-time redaction here),
 * so the only defense is write-side scrubbing.
 */
class SecretLeakingSecondary implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): PolicyDecision {
    return {
      effect: "allow",
      reason: `advisory leaked a credential: ${SECRET_CANARY}`,
      auditRequired: true,
    };
  }
}

/** A CostGate whose reserve REJECTS (throws) — an external gate fault. The pipeline must fail-closed. */
class ThrowingReserveCostGate implements CostGate {
  reserve(_ctx: unknown, _req: ReserveRequest): Promise<ReserveResult> {
    return Promise.reject(new Error("injected gate reserve fault (test)"));
  }
  commit(_ctx: unknown, _id: string, _settle: { actualTokens: number }): Promise<CommitResult> {
    return Promise.reject(new Error("injected gate commit fault (test)"));
  }
  release(_ctx: unknown, _id: string): Promise<ReleaseResult> {
    return Promise.reject(new Error("injected gate release fault (test)"));
  }
}

/** An always-DENY CostGate: every reserve is refused (deny-by-default). The injection only narrows. */
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

class DenySecondary implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): PolicyDecision {
    return { effect: "deny", reason: "injected deny secondary (test)", auditRequired: true };
  }
}

class AllowSecondary implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): PolicyDecision {
    return { effect: "allow", reason: "injected allow secondary (test)", auditRequired: true };
  }
}

describe("createDeveloperKit — INJECTABLE costGate + advisory secondaries (SLICE-IT1a)", () => {
  it("INJECTED always-DENY costGate -> a REGISTERED+granted tool call is denied@cost, NO effect, WORM empty", async () => {
    const kit = createDeveloperKit({ costGate: new AlwaysDenyCostGate() });
    kit.authorTool(validManifest("dev:echo")); // registered + the default dev:* allow grants it

    const outcome = await kit.runTool(toolCall("dev:echo", { note: "hello" }));
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") return;
    // The injected gate's reserve denies -> the pipeline short-circuits at the cost stage.
    expect(outcome.stage).toBe("cost");

    // NON-VACUITY: a real InMemoryCostGate(1000) with estimate 10 would EXECUTE this. The deny proves
    // the injected gate was used; the effect never ran -> no sandbox, the WORM stayed empty.
    expect(kit.replayFold().steps.length).toBe(0);
  });

  it("INJECTED always-DENY secondary -> a REGISTERED+granted call is denied@policy (advisory any-deny-wins), NO effect", async () => {
    const kit = createDeveloperKit({ secondaries: [new DenySecondary()] });
    kit.authorTool(validManifest("dev:echo"));

    const outcome = await kit.runTool(toolCall("dev:echo", { note: "hello" }));
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") return;
    // combineDecisions(pdp=allow, [secondary=deny]) -> deny (any-deny-wins) at the authorize/policy stage.
    expect(outcome.stage).toBe("policy");
    expect(kit.replayFold().steps.length).toBe(0);
  });

  it("INJECTED always-ALLOW secondary does NOT relax a registry/PDP deny: an UNREGISTERED tool is still denied@policy", async () => {
    const kit = createDeveloperKit({ secondaries: [new AllowSecondary()] });
    // No authorTool -> "dev:never-registered" is NOT in the registry (registry deny-by-default).

    const outcome = await kit.runTool(toolCall("dev:never-registered", { note: "x" }));
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") return;
    // combineDecisions(pdp/registry=deny, [secondary=allow]) -> deny: the advisory allow NEVER grants
    // what the registry-backed PDP denied (PDP sovereign). The effect never ran.
    expect(outcome.stage).toBe("policy");
    expect(kit.replayFold().steps.length).toBe(0);
  });

  it("CREDENTIAL NON-LEAK: a SECRET in an advisory's reason is SCRUBBED from the committed WORM/replay (untrusted seam)", async () => {
    const kit = createDeveloperKit({ secondaries: [new SecretLeakingSecondary()] });
    kit.authorTool(validManifest("dev:echo")); // registry + PDP both allow -> the call executes

    const outcome = await kit.runTool(toolCall("dev:echo", { note: "hello" }));
    expect(outcome.status).toBe("executed"); // PDP/registry + advisory both allow

    // replayFold folds the RAW WORM (no read-time redaction) -> the only defense is write-side scrub.
    // NON-VACUITY: if the raw secondary reason were committed, the canary would surface in the replay.
    const tl = kit.replayFold();
    expect(tl.steps.length).toBe(1);
    expect(JSON.stringify(tl)).not.toContain(SECRET_CANARY);
  });

  it("FAIL-CLOSED: an injected CostGate whose reserve THROWS -> a structured deny (never an unhandled reject), NO effect", async () => {
    const kit = createDeveloperKit({ costGate: new ThrowingReserveCostGate() });
    kit.authorTool(validManifest("dev:echo"));

    // The pipeline must convert the gate fault into a denied outcome — NOT let the rejection escape.
    const outcome = await kit.runTool(toolCall("dev:echo", { note: "x" }));
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") expect(outcome.stage).toBe("cost");
    expect(kit.replayFold().steps.length).toBe(0);
  });

  it("ABSENT (no costGate/secondaries) -> BYTE-IDENTICAL default: tiny budget still denies@cost; ample budget still executes", async () => {
    // Tiny budget vs large estimate, NO injection -> the default `new InMemoryCostGate(budget)` denies.
    const kitDeny = createDeveloperKit({ budget: 5, estimateTokens: 50 });
    kitDeny.authorTool(validManifest("dev:echo"));
    const denied = await kitDeny.runTool(toolCall("dev:echo", { note: "x" }));
    expect(denied.status).toBe("denied");
    if (denied.status === "denied") expect(denied.stage).toBe("cost");

    // Ample-budget default still EXECUTES (byte-identical to bootstrap.e2e happy path).
    const kitOk = createDeveloperKit();
    kitOk.authorTool(validManifest("dev:echo"));
    const ok = await kitOk.runTool(toolCall("dev:echo", { note: "x" }));
    expect(ok.status).toBe("executed");
    expect(kitOk.replayFold().steps.length).toBe(1);
  });
});
