/**
 * SLICE-CAP4a — the governed-pipeline now has a fail-CLOSED APPROVAL STAGE between the PDP-allow and
 * cost.reserve. brainstorm found the `requiresApproval` fail-OPEN: every manifest declares it (and the
 * manifest schema FORCES destructive => requiresApproval:true), but `runGovernedToolCall` never read it
 * — a tool that DECLARED it needed approval ran with no approval. CAP4a closes that hole.
 *
 * What this file pins (RED-first; SYNTHETIC `requiresApproval` deps — no real tool declares it yet, the
 * CAP3 gate keeps destructive tools un-registerable until CAP4b wires "approval" into WIRED_PRIMITIVES):
 *  - `decision.requiresApproval === true` + `approve -> "approved"` -> proceeds to cost/commit/effect;
 *  - `decision.requiresApproval === true` + `approve -> "denied"` -> `denied@approval`, NOTHING downstream
 *    (cost.reserve / append / effect / commit all 0) — approval is BEFORE the effect, a reject = no spend;
 *  - FAIL-CLOSED: `requiresApproval === true` with NO `approve` seam in deps -> `denied@approval`,
 *    NOTHING downstream. A tool that declared it needs approval must NEVER run unapproved;
 *  - approve that REJECTS / THROWS -> `denied@approval` with a STATIC reason (mirrors R9a reject->deny):
 *    the rejection's error message / any canary NEVER leaks into the reason;
 *  - `requiresApproval` false / unset -> the stage is SKIPPED, `approve` is NOT called even when present,
 *    and the outcome is BYTE-IDENTICAL to today (effect runs after cost+commit);
 *  - PDP-SOVEREIGN: a PDP `deny` stops at `policy` — the approval stage / `approve` is never reached, so
 *    approval can NEVER relax a PDP deny (it is a SECOND, additive pre-effect authorization).
 *
 * NON-VACUITY (manual mutations, see the it-block comments):
 *  - drop the no-seam branch (treat a missing `approve` as approved when requiresApproval:true) -> the
 *    FAIL-CLOSED case flips RED (the effect runs / status != denied@approval);
 *  - call `approve` even when requiresApproval is false/unset -> the SKIP case flips RED ("approve NOT
 *    called" assertion fails).
 */
import { describe, expect, it } from "vitest";
import type { CommitAppender } from "../commitgate/index.js";
import { type CostGate, InMemoryCostGate } from "../cost/index.js";
import {
  type ApprovalOutcome,
  type AuthorizeDecision,
  type GovernedToolCallDeps,
  runGovernedToolCall,
} from "./pipeline.js";

interface Probe {
  reserveCalls: number;
  commitCalls: number;
  releaseCalls: number;
  effectCalls: number;
  appendCalls: number;
  approveCalls: number;
}

const ctx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

type Call = { tool: string; context: unknown };
const call: Call = { tool: "delete-prod", context: ctx };

/**
 * Deps whose cost gate / appender / effect / approve all increment a shared probe so a test can assert
 * exactly which gates were touched. The cost gate wraps a REAL in-memory gate (the "substrate 0"
 * equivalent: a deny at the approval gate must NOT touch reserve/commit/release, append, or the effect).
 * `authorize` and the optional `approve` are injected per-test.
 */
function makeDeps(
  authorize: GovernedToolCallDeps<Call, { sequence: number }>["authorize"],
  approve?: (toolCall: Call) => ApprovalOutcome | Promise<ApprovalOutcome>,
): {
  deps: GovernedToolCallDeps<Call, { sequence: number }>;
  probe: Probe;
} {
  const probe: Probe = {
    reserveCalls: 0,
    commitCalls: 0,
    releaseCalls: 0,
    effectCalls: 0,
    appendCalls: 0,
    approveCalls: 0,
  };
  const inner = new InMemoryCostGate(1000);
  const cost: CostGate = {
    reserve: (ctx, req) => {
      probe.reserveCalls++;
      return inner.reserve(ctx, req);
    },
    commit: (ctx, id, settle) => {
      probe.commitCalls++;
      return inner.commit(ctx, id, settle);
    },
    release: (ctx, id) => {
      probe.releaseCalls++;
      return inner.release(ctx, id);
    },
  };
  const appender: CommitAppender<unknown, { sequence: number }> = {
    append: async () => {
      probe.appendCalls++;
      return { sequence: 1 };
    },
  };
  const deps: GovernedToolCallDeps<Call, { sequence: number }> = {
    screen: () => ({ ok: true }),
    authorize,
    cost,
    estimateTokens: () => 10,
    appender,
    effect: async () => {
      probe.effectCalls++;
      return { ok: true };
    },
    // Only attach `approve` when the test provides one — the FAIL-CLOSED test passes `undefined` so the
    // pipeline sees NO seam (`deps.approve === undefined`).
    ...(approve
      ? {
          approve: (tc: Call) => {
            probe.approveCalls++;
            return approve(tc);
          },
        }
      : {}),
  };
  return { deps, probe };
}

const allowNeedsApproval = (): AuthorizeDecision => ({
  effect: "allow",
  reason: "pdp: allow (requires approval)",
  requiresApproval: true,
});

describe("CAP4a runGovernedToolCall — fail-closed APPROVAL stage", () => {
  it("requiresApproval:true + approve -> approved => proceeds to cost/commit/effect (effect ran)", async () => {
    const { deps, probe } = makeDeps(allowNeedsApproval, () => ({
      status: "approved",
      reason: "ok",
    }));
    const out = await runGovernedToolCall(deps, call);
    expect(out.status).toBe("executed");
    expect(probe.approveCalls).toBe(1);
    expect(probe.reserveCalls).toBe(1);
    expect(probe.appendCalls).toBe(1);
    expect(probe.effectCalls).toBe(1);
    expect(probe.commitCalls).toBe(1);
  });

  it("requiresApproval:true + approve -> denied => denied@approval, NOTHING downstream ran", async () => {
    const { deps, probe } = makeDeps(allowNeedsApproval, () => ({
      status: "denied",
      reason: "checker rejected",
    }));
    const out = await runGovernedToolCall(deps, call);
    expect(out).toMatchObject({ status: "denied", stage: "approval" });
    expect(probe.approveCalls).toBe(1);
    // approval is BEFORE the effect: a reject means no reserve, no append, no effect, no commit.
    expect(probe.reserveCalls).toBe(0);
    expect(probe.appendCalls).toBe(0);
    expect(probe.effectCalls).toBe(0);
    expect(probe.commitCalls).toBe(0);
  });

  it("FAIL-CLOSED: requiresApproval:true with NO approve seam => denied@approval, effect 0", async () => {
    // NON-VACUITY: drop the no-seam branch (treat a missing `approve` as approved) and this flips RED —
    // the call would fall through to cost/commit/effect (probe non-zero, status == executed).
    const { deps, probe } = makeDeps(allowNeedsApproval /* no approve */);
    const out = await runGovernedToolCall(deps, call);
    expect(out).toMatchObject({ status: "denied", stage: "approval" });
    expect(probe.reserveCalls).toBe(0);
    expect(probe.appendCalls).toBe(0);
    expect(probe.effectCalls).toBe(0);
    expect(probe.commitCalls).toBe(0);
  });

  it("approve REJECTS -> denied@approval with a STATIC reason (no error-message/canary leak), effect 0", async () => {
    const CANARY = "sk-approve-reject-CANARY-must-not-appear";
    const { deps, probe } = makeDeps(allowNeedsApproval, () =>
      Promise.reject(new Error(`approve boom ${CANARY}`)),
    );
    const out = await runGovernedToolCall(deps, call);
    expect(out).toMatchObject({ status: "denied", stage: "approval" });
    if (out.status !== "denied") return;
    expect(out.reason).not.toContain(CANARY);
    expect(out.reason).not.toContain("boom");
    expect(probe.effectCalls).toBe(0);
    expect(probe.reserveCalls).toBe(0);
  });

  it("approve THROWS (sync) -> denied@approval with the SAME static reason (no leak), effect 0", async () => {
    const CANARY = "sk-approve-throw-CANARY";
    const { deps, probe } = makeDeps(allowNeedsApproval, () => {
      throw new Error(`approve sync boom ${CANARY}`);
    });
    const out = await runGovernedToolCall(deps, call);
    expect(out).toMatchObject({ status: "denied", stage: "approval" });
    if (out.status !== "denied") return;
    expect(out.reason).not.toContain(CANARY);
    expect(probe.effectCalls).toBe(0);
  });

  it("requiresApproval:false (or unset) + approve present => stage SKIPPED, approve NOT called, byte-identical", async () => {
    // NON-VACUITY: call `approve` even when requiresApproval is false/unset and this flips RED — the
    // `approve NOT called` assertion (approveCalls === 0) fails.
    const authorizeNoApproval = (): AuthorizeDecision => ({
      effect: "allow",
      reason: "pdp: allow (no approval)",
      // requiresApproval intentionally unset (=== undefined): the 14 existing tools are this shape.
    });
    const { deps, probe } = makeDeps(authorizeNoApproval, () => ({
      status: "approved",
      reason: "x",
    }));
    const out = await runGovernedToolCall(deps, call);
    expect(out.status).toBe("executed");
    expect(probe.approveCalls).toBe(0);
    // byte-identical: effect ran after cost+commit, exactly as before the approval stage existed.
    expect(probe.reserveCalls).toBe(1);
    expect(probe.appendCalls).toBe(1);
    expect(probe.effectCalls).toBe(1);
    expect(probe.commitCalls).toBe(1);
  });

  it("requiresApproval:false EXPLICIT + approve present => stage SKIPPED, approve NOT called", async () => {
    const authorizeFalse = (): AuthorizeDecision => ({
      effect: "allow",
      reason: "pdp: allow (requiresApproval:false)",
      requiresApproval: false,
    });
    const { deps, probe } = makeDeps(authorizeFalse, () => ({ status: "approved", reason: "x" }));
    const out = await runGovernedToolCall(deps, call);
    expect(out.status).toBe("executed");
    expect(probe.approveCalls).toBe(0);
    expect(probe.effectCalls).toBe(1);
  });

  it("PDP-SOVEREIGN: a PDP deny stops at policy — approval stage / approve never reached", async () => {
    const authorizeDeny = (): AuthorizeDecision => ({ effect: "deny", reason: "pdp: deny" });
    // approve would APPROVE if reached — proving approval can NEVER relax a PDP deny.
    const { deps, probe } = makeDeps(authorizeDeny, () => ({ status: "approved", reason: "x" }));
    const out = await runGovernedToolCall(deps, call);
    expect(out).toMatchObject({ status: "denied", stage: "policy", reason: "pdp: deny" });
    expect(probe.approveCalls).toBe(0);
    expect(probe.reserveCalls).toBe(0);
    expect(probe.effectCalls).toBe(0);
  });
});
