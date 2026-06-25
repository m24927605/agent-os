/**
 * SLICE-R9a — `SecondaryPolicyAdapter.evaluate` is now `MaybePromise<PolicyDecision>` and
 * `evaluateSecondaries` is ASYNC (`Promise<PolicyDecision[]>`), so an async advisory (the real AGT
 * engine over a transport, landing in R9b/c) can be folded without changing the fold law.
 *
 * What this file pins (RED-first):
 *  - an ASYNC secondary that RESOLVES allow/deny is awaited correctly (deny -> deny when combined);
 *  - a REJECTING (or throwing) async secondary becomes the SAME synthetic deny as a sync throw today
 *    (deny-by-default / fail-closed) — a broken advisor can only ever deny more;
 *  - ORDER is preserved (Promise.all preserves index order), even when adapters resolve out of order;
 *  - `combineDecisions` stays PURE SYNC — it is called directly with an already-resolved array (no await).
 *
 * NON-VACUITY (manual mutation, see the it-block comment): making `evaluateSecondaries` NOT await
 * (return the raw `adapters.map(...)` array of Promises) flips the async-secondary-deny case RED — the
 * "decision" handed to `combineDecisions` is a pending Promise, whose `.effect` is undefined, so the
 * any-deny-wins fold no longer sees the deny it should (the resolved value never arrives in time).
 */
import { describe, expect, it } from "vitest";
import { type SecondaryPolicyAdapter, combineDecisions, evaluateSecondaries } from "./dedup.js";
import { type PolicyDecision, PolicyRequest } from "./types.js";

const allow: PolicyDecision = { effect: "allow", reason: "pdp: allow", auditRequired: true };

const req = PolicyRequest.parse({
  requestId: "req-1",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "send",
  resource: "email/x",
});

/** A throwing sync adapter — its synthetic-deny reason is the BASELINE the async cases must match. */
const syncThrowing: SecondaryPolicyAdapter = {
  evaluate() {
    throw new Error("sync advisor blew up");
  },
};

/** An async adapter that REJECTS — the R9a addition that must fold to the SAME synthetic deny. */
const asyncRejecting: SecondaryPolicyAdapter = {
  evaluate(): Promise<PolicyDecision> {
    return Promise.reject(new Error("async advisor blew up"));
  },
};

describe("R9a evaluateSecondaries — ASYNC advisory adapters (MaybePromise) fold fail-closed", () => {
  it("an ASYNC secondary that RESOLVES deny -> deny when combined with a PDP allow (any-deny-wins)", async () => {
    // NON-VACUITY: make evaluateSecondaries NOT await (return the raw Promise array) and this flips RED —
    // combineDecisions then folds a pending Promise (effect===undefined) and never sees the resolved deny.
    const asyncDeny: SecondaryPolicyAdapter = {
      evaluate: async () => ({ effect: "deny", reason: "async agt: deny", auditRequired: true }),
    };
    const decisions = await evaluateSecondaries([asyncDeny], req);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.effect).toBe("deny");
    expect(combineDecisions(allow, decisions).effect).toBe("deny");
  });

  it("an ASYNC secondary that RESOLVES allow -> allow when combined with a PDP allow", async () => {
    const asyncAllow: SecondaryPolicyAdapter = {
      evaluate: async () => ({ effect: "allow", reason: "async agt: allow", auditRequired: true }),
    };
    const decisions = await evaluateSecondaries([asyncAllow], req);
    expect(combineDecisions(allow, decisions).effect).toBe("allow");
  });

  it("a REJECTING async secondary -> the SAME synthetic deny as a sync throw (fail-closed)", async () => {
    const [fromSyncThrow] = await evaluateSecondaries([syncThrowing], req);
    const [fromAsyncReject] = await evaluateSecondaries([asyncRejecting], req);
    expect(fromAsyncReject?.effect).toBe("deny");
    // Same SHAPE/reason prefix as today's sync-throw synthetic deny (only the trailing error text differs).
    expect(fromAsyncReject?.reason).toContain("secondary policy adapter errored");
    expect(fromSyncThrow?.reason).toContain("secondary policy adapter errored");
    expect(fromAsyncReject?.auditRequired).toBe(true);
  });

  it("ORDER is preserved even when adapters resolve out of order (Promise.all keeps index order)", async () => {
    const slowAllow: SecondaryPolicyAdapter = {
      evaluate: () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ effect: "allow", reason: "slow: allow", auditRequired: true }),
            10,
          ),
        ),
    };
    const fastDeny: SecondaryPolicyAdapter = {
      evaluate: async () => ({ effect: "deny", reason: "fast: deny", auditRequired: true }),
    };
    const decisions = await evaluateSecondaries([slowAllow, fastDeny], req);
    // Index 0 is the SLOW allow (resolved last), index 1 is the FAST deny — order tracks the input array.
    expect(decisions[0]?.reason).toContain("slow: allow");
    expect(decisions[1]?.reason).toContain("fast: deny");
  });

  it("combineDecisions stays PURE SYNC — called directly with an already-resolved array (no await)", () => {
    const resolved: PolicyDecision[] = [
      { effect: "deny", reason: "agt: deny", auditRequired: true },
    ];
    const out = combineDecisions(allow, resolved);
    // It returns a PolicyDecision synchronously — not a Promise.
    expect(out).not.toBeInstanceOf(Promise);
    expect(out.effect).toBe("deny");
  });

  it("a SYNC adapter still works (MaybePromise = T | Promise<T>) — order with a mix of sync+async", async () => {
    const syncAllow: SecondaryPolicyAdapter = {
      evaluate: () => ({ effect: "allow", reason: "sync: allow", auditRequired: true }),
    };
    const asyncDeny: SecondaryPolicyAdapter = {
      evaluate: async () => ({ effect: "deny", reason: "async: deny", auditRequired: true }),
    };
    const decisions = await evaluateSecondaries([syncAllow, asyncDeny], req);
    expect(decisions[0]?.effect).toBe("allow");
    expect(decisions[1]?.effect).toBe("deny");
  });
});
