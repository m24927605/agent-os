/**
 * SLICE-R9a — the governed-pipeline `authorize` seam is now ASYNC-CAPABLE (`MaybePromise`): the
 * pipeline `await`s `deps.authorize(...)`, so a sync closure/fake still works AND an async secondary
 * (landing in R9b/c) can be wired without touching the pipeline again.
 *
 * What this file pins (RED-first):
 *  - an ASYNC authorize that RESOLVES allow/deny drives the same allow/deny outcome through `await`;
 *  - an authorize that REJECTS (or throws) is FAIL-CLOSED to `denied@policy` with a STATIC reason —
 *    the rejection's error message NEVER leaks into the reason, and cost.reserve / commit-before-effect
 *    / the effect do NOT run (the policy gate short-circuits before any spend or side effect);
 *  - a plain (sync) authorize value is still accepted (MaybePromise = T | Promise<T>).
 *
 * NON-VACUITY (manual mutation, see the it-block comments): reverting the pipeline call site from
 * `await deps.authorize(...)` to `const decision = deps.authorize(...)` flips the async-deny case RED —
 * a pending Promise is truthy and `decision.effect === "deny"` is false, so the call would NOT short-
 * circuit at policy (it would fall through to cost/effect), and the reject case would leave an unhandled
 * rejection instead of a static deny.
 */
import { describe, expect, it } from "vitest";
import type { CommitAppender } from "../commitgate/index.js";
import { type CostGate, InMemoryCostGate } from "../cost/index.js";
import {
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
}

const ctx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

type Call = { tool: string; context: unknown };
const call: Call = { tool: "send-prod", context: ctx };

/**
 * Deps whose cost gate / appender / effect all increment a shared probe so a test can assert the
 * downstream gates were NOT touched when authorize denies (the "substrate 0" equivalent for this seam).
 */
function makeDeps(authorize: GovernedToolCallDeps<Call, { sequence: number }>["authorize"]): {
  deps: GovernedToolCallDeps<Call, { sequence: number }>;
  probe: Probe;
} {
  const probe: Probe = {
    reserveCalls: 0,
    commitCalls: 0,
    releaseCalls: 0,
    effectCalls: 0,
    appendCalls: 0,
  };
  // A real in-memory gate wrapped with spy counters: a deny at the policy gate must NOT touch ANY of
  // these (the "substrate 0" equivalent — no reserve/commit/release, no append, no effect).
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
  };
  return { deps, probe };
}

describe("R9a runGovernedToolCall — ASYNC authorize seam (MaybePromise)", () => {
  it("ASYNC authorize that RESOLVES allow -> executed (effect ran through await)", async () => {
    const authorize = (): Promise<AuthorizeDecision> =>
      Promise.resolve({ effect: "allow", reason: "async pdp: allow" });
    const { deps, probe } = makeDeps(authorize);
    const out = await runGovernedToolCall(deps, call);
    expect(out.status).toBe("executed");
    expect(probe.effectCalls).toBe(1);
  });

  it("ASYNC authorize that RESOLVES deny -> denied@policy, NOTHING downstream ran", async () => {
    // NON-VACUITY: revert the pipeline to `const decision = deps.authorize(...)` (drop the await) and
    // this flips RED — a pending Promise is truthy and not a decision, so it does NOT short-circuit at
    // policy: the call falls through to cost/effect (probe counters become non-zero, status != denied).
    const authorize = (): Promise<AuthorizeDecision> =>
      Promise.resolve({ effect: "deny", reason: "async pdp: deny" });
    const { deps, probe } = makeDeps(authorize);
    const out = await runGovernedToolCall(deps, call);
    expect(out).toMatchObject({ status: "denied", stage: "policy", reason: "async pdp: deny" });
    expect(probe.reserveCalls).toBe(0);
    expect(probe.appendCalls).toBe(0);
    expect(probe.effectCalls).toBe(0);
    expect(probe.commitCalls).toBe(0);
  });

  it("REJECTING authorize -> denied@policy with a STATIC reason (no error-message leak), nothing downstream ran", async () => {
    const SECRET = "sk-leak-CANARY-must-not-appear-in-reason";
    const authorize = (): Promise<AuthorizeDecision> =>
      Promise.reject(new Error(`boom carrying ${SECRET}`));
    const { deps, probe } = makeDeps(authorize);
    const out = await runGovernedToolCall(deps, call);
    expect(out).toMatchObject({ status: "denied", stage: "policy" });
    if (out.status !== "denied") return;
    // STATIC reason: the rejection's error message / secret never leaks into the reason.
    expect(out.reason).not.toContain(SECRET);
    expect(out.reason).not.toContain("boom");
    // Fail-closed: the rejection short-circuits at policy — nothing downstream ran.
    expect(probe.reserveCalls).toBe(0);
    expect(probe.appendCalls).toBe(0);
    expect(probe.effectCalls).toBe(0);
    expect(probe.commitCalls).toBe(0);
  });

  it("THROWING (sync) authorize -> denied@policy with the SAME static reason (no leak)", async () => {
    const SECRET = "sk-sync-throw-CANARY";
    const authorize = (): AuthorizeDecision => {
      throw new Error(`sync boom ${SECRET}`);
    };
    const { deps, probe } = makeDeps(authorize);
    const out = await runGovernedToolCall(deps, call);
    expect(out).toMatchObject({ status: "denied", stage: "policy" });
    if (out.status !== "denied") return;
    expect(out.reason).not.toContain(SECRET);
    expect(probe.effectCalls).toBe(0);
  });

  it("a plain (sync) authorize value is STILL accepted (MaybePromise = T | Promise<T>) — byte-identical reason", async () => {
    const authorize = (): AuthorizeDecision => ({ effect: "allow", reason: "sync pdp: allow" });
    const { deps } = makeDeps(authorize);
    const out = await runGovernedToolCall(deps, call);
    expect(out.status).toBe("executed");
  });
});
