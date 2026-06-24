/**
 * SLICE-IT1a — INJECTABLE costGate + advisory secondaries on the Personal surface (DVx-style).
 *
 * Proves the NEW vendor-neutral injection seams on `PersonalShellOpts`:
 *   - `costGate?: CostGate` -> `const cost = opts.costGate ?? new InMemoryCostGate(budget)`.
 *     Injecting an always-DENY CostGate makes a governed (otherwise-allowed) call denied@cost; the
 *     effect never runs (no sandbox; empty timeline). NON-VACUITY: if the injection were not wired
 *     (still `new InMemoryCostGate(budget)`), this allowed call would EXECUTE -> the test flips RED.
 *   - `secondaries?: readonly SecondaryPolicyAdapter[]` -> `combineDecisions(decision, opts.secondaries
 *     ?? [])`. An always-DENY advisory secondary makes the call denied@policy (any-deny-wins). An
 *     always-ALLOW advisory secondary does NOT relax a PDP deny (PDP is the sole deny authority): with
 *     `allowToolInvoke:false` the call is STILL denied@policy.
 *   - ABSENT (no costGate/secondaries) => BYTE-IDENTICAL to today: the SAME InMemoryCostGate happy path
 *     (the existing bootstrap.e2e stays green; here we re-assert the default uses an in-memory budget
 *     gate by proving a tiny budget still denies@cost with no injection).
 *
 * The injection only NARROWS: an injected costGate's reserve can DENY (never grant more budget), and
 * secondaries are advisory (any-deny-wins; a malformed/absent advisory = deny). The surface imports
 * ONLY the vendor-neutral `CostGate` + `SecondaryPolicyAdapter` PORT types — NEVER SpendGuard/AGT.
 *
 * RED-first: `PersonalShellOpts.costGate` / `.secondaries` do not exist yet, so this suite fails to
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
import { createPersonalShell } from "./bootstrap.js";
import { StructuredIntent } from "./intent/index.js";

const ctx: AgentContext = StructuredIntent.shape.context.parse({
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
});

// A runtime-ASSEMBLED secret canary (never a literal in source — keeps secret-scan clean). Matches
// the audit redactor's `sk-[A-Za-z0-9]{16,}` shape.
const SECRET_CANARY = `sk-${"d".repeat(24)}`;

/** A clean, parseable intent text the deterministic gateway resolves to action+targets. */
const LEGAL_TEXT = "backup notes archive";

/**
 * An always-DENY CostGate: every reserve is refused (deny-by-default), so a governed call that
 * passes screen+PDP is short-circuited @cost. Models a vendor gate (e.g. SpendGuard) whose budget is
 * exhausted — the injection can ONLY narrow, never grant.
 */
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

/** An always-DENY advisory secondary (advisory deny wins via combineDecisions any-deny-wins). */
class DenySecondary implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): PolicyDecision {
    return { effect: "deny", reason: "injected deny secondary (test)", auditRequired: true };
  }
}

/** An always-ALLOW advisory secondary — allow is STILL subject to the PDP + any-deny-wins. */
class AllowSecondary implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): PolicyDecision {
    return { effect: "allow", reason: "injected allow secondary (test)", auditRequired: true };
  }
}

/**
 * A hostile/buggy advisory whose `reason` carries a SECRET — the untrusted-vendor-seam leak vector. It
 * ALLOWS (so the combined decision is allow and the reason is folded into the committed AuditEvent's
 * policyDecision.reason on the WRITE path). The surface MUST scrub the secondary-derived reason before
 * it reaches the WORM/read surfaces (credential non-leak; defense in depth on an external seam).
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

async function approveLegal(shell: ReturnType<typeof createPersonalShell>) {
  const received = shell.receive(LEGAL_TEXT, ctx);
  if (received.status !== "intent") throw new Error("expected intent");
  const submitted = shell.previewAndSubmit(received.intent);
  if (submitted.status !== "pending") throw new Error("expected pending");
  return shell.approve(submitted.id);
}

describe("createPersonalShell — INJECTABLE costGate + advisory secondaries (SLICE-IT1a)", () => {
  it("INJECTED always-DENY costGate -> a governed (otherwise-allowed) call is denied@cost, NO effect", async () => {
    const shell = createPersonalShell({
      budget: 1000,
      allowToolInvoke: true,
      costGate: new AlwaysDenyCostGate(),
    });

    const decided = await approveLegal(shell);
    // The injected gate's reserve denies -> the pipeline short-circuits at the cost stage.
    expect(decided).toMatchObject({ status: "denied" });
    expect(decided.outcome).toMatchObject({ status: "denied", stage: "cost" });

    // NON-VACUITY: a real InMemoryCostGate(1000) with estimate 10 would have EXECUTED this call. The
    // deny proves the injected gate was actually used (the effect never ran -> no sandbox, no timeline).
    expect((await shell.probeLastSandbox()).status).toBe("denied");
    expect((await shell.timeline(ctx.taskId)).length).toBe(0);
  });

  it("INJECTED always-DENY secondary -> denied@policy (advisory any-deny-wins), NO effect", async () => {
    const shell = createPersonalShell({
      budget: 1000,
      allowToolInvoke: true, // the PDP itself GRANTS — only the advisory deny narrows
      secondaries: [new DenySecondary()],
    });

    const decided = await approveLegal(shell);
    // combineDecisions(pdp=allow, [secondary=deny]) -> deny (any-deny-wins); pipeline denies@policy.
    expect(decided).toMatchObject({ status: "denied" });
    expect(decided.outcome).toMatchObject({ status: "denied", stage: "policy" });
    expect((await shell.probeLastSandbox()).status).toBe("denied");
    expect((await shell.timeline(ctx.taskId)).length).toBe(0);
  });

  it("INJECTED always-ALLOW secondary does NOT relax a PDP deny (PDP sovereign): allowToolInvoke:false still denied@policy", async () => {
    const shell = createPersonalShell({
      budget: 1000,
      allowToolInvoke: false, // the PDP DENIES (no allow rule)
      secondaries: [new AllowSecondary()],
    });

    const decided = await approveLegal(shell);
    // combineDecisions(pdp=deny, [secondary=allow]) -> deny: a secondary allow can NEVER override the
    // PDP deny (the PDP is the sole deny authority). The advisory does not grant.
    expect(decided).toMatchObject({ status: "denied" });
    expect(decided.outcome).toMatchObject({ status: "denied", stage: "policy" });
    expect((await shell.probeLastSandbox()).status).toBe("denied");
  });

  it("CREDENTIAL NON-LEAK: a SECRET in an advisory's reason is SCRUBBED from the committed timeline (untrusted seam, defense in depth)", async () => {
    // The advisory ALLOWS with a secret in its reason; PDP also allows -> the call executes and the
    // combined reason is folded into the committed AuditEvent. The canary must NEVER reach the timeline.
    const shell = createPersonalShell({
      budget: 1000,
      allowToolInvoke: true,
      secondaries: [new SecretLeakingSecondary()],
    });

    const decided = await approveLegal(shell);
    expect(decided.status).toBe("executed"); // PDP + advisory both allow

    const events = await shell.timeline(ctx.taskId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    // NON-VACUITY: if the surface folded the raw secondary reason into the AuditEvent unredacted, the
    // canary would surface here. The scrub keeps it out (the audit decision reason is credential-blind).
    expect(JSON.stringify(events)).not.toContain(SECRET_CANARY);
  });

  it("FAIL-CLOSED: an injected CostGate whose reserve THROWS -> a structured deny (never an unhandled reject), NO effect", async () => {
    const shell = createPersonalShell({
      budget: 1000,
      allowToolInvoke: true,
      costGate: new ThrowingReserveCostGate(),
    });

    // The pipeline must convert the gate fault into a denied outcome — NOT let the rejection escape
    // approve() (an unhandled reject would crash the caller / leave the call in an unknown state).
    const decided = await approveLegal(shell);
    expect(decided).toMatchObject({ status: "denied" });
    expect(decided.outcome).toMatchObject({ status: "denied", stage: "cost" });
    expect((await shell.probeLastSandbox()).status).toBe("denied");
    expect((await shell.timeline(ctx.taskId)).length).toBe(0);
  });

  it("ABSENT (no costGate/secondaries) -> BYTE-IDENTICAL default: the SAME in-memory budget gate (tiny budget still denies@cost)", async () => {
    // With NO costGate injected the default is `new InMemoryCostGate(budget)`; a tiny budget vs a large
    // estimate denies@cost — proving the default path is unchanged (an in-memory budget gate, not a
    // pass-through). NON-VACUITY: if `absent` silently used some always-allow gate, this would EXECUTE.
    const shell = createPersonalShell({ budget: 5, allowToolInvoke: true, estimateTokens: 50 });
    const decided = await approveLegal(shell);
    expect(decided).toMatchObject({ status: "denied" });
    expect(decided.outcome).toMatchObject({ status: "denied", stage: "cost" });

    // And the default happy path (ample budget) still EXECUTES (byte-identical to bootstrap.e2e).
    const shellOk = createPersonalShell({ budget: 1000, allowToolInvoke: true });
    const decidedOk = await approveLegal(shellOk);
    expect(decidedOk.status).toBe("executed");
    expect((await shellOk.timeline(ctx.taskId)).length).toBe(1);
  });
});
