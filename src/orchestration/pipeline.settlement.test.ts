/**
 * SLICE-PIPE-SETTLE — the governance core was SWALLOWING the result of `cost.commit`. The effect is
 * commit-before-effect -> effect -> settle; the effect is IRREVERSIBLE, so a post-effect settlement
 * DENY or a recorded budget OVERRUN cannot retroactively un-run the effect. But it must NEVER be
 * silently dropped: the executed outcome now carries a `settlement` so the caller/composition root can
 * audit/alert on a post-effect deny or an in-flight overshoot.
 *
 * These tests pin the surfacing: status STAYS "executed" (the effect ran), and `settlement` reflects
 * the real `cost.commit` result — committed/overrun, denied, or (a gate that THROWS) a static denied
 * reason with the receipt preserved (no rejection, no error-message leak). The UNCHANGED invariants
 * (over-budget reserve -> denied@cost with NO effect; abort -> release + denied@commit) are re-pinned
 * here so this slice cannot regress them.
 */
import { describe, expect, it, vi } from "vitest";
import type { CommitAppender } from "../commitgate/index.js";
import {
  type CommitResult,
  type CostGate,
  InMemoryCostGate,
  type ReleaseResult,
  type ReserveResult,
} from "../cost/index.js";
import { parseAgentContext } from "../iam/ids.js";
import { type GovernedCall, type GovernedToolCallDeps, runGovernedToolCall } from "./pipeline.js";

const ctx = parseAgentContext({
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
});

function call(): GovernedCall {
  return { tool: "send-prod", context: ctx };
}

function okAppender(): CommitAppender<unknown, { sequence: number }> {
  let seq = 0;
  return { append: async () => ({ sequence: ++seq }) };
}

const failAppender: CommitAppender<unknown, { sequence: number }> = {
  append: async () => {
    throw new Error("kernel unavailable");
  },
};

const okReserve: ReserveResult = {
  status: "ok",
  reservationId: "rsv-1",
  event: { phase: "reserve", result: "ok" },
};
const okRelease: ReleaseResult = { status: "released", event: { phase: "release", result: "ok" } };

/**
 * A CostGate whose `reserve`/`release` always succeed and whose `commit` is fully scripted, so each
 * test drives ONE precise commit branch (committed / committed+overrun / denied / throw).
 */
function scriptedCost(commit: CostGate["commit"]): CostGate {
  return {
    reserve: async () => okReserve,
    commit,
    release: async () => okRelease,
  };
}

function depsWith(
  cost: CostGate,
  appender: CommitAppender<unknown, { sequence: number }> = okAppender(),
): GovernedToolCallDeps<GovernedCall, { sequence: number }> {
  return {
    screen: () => ({ ok: true }),
    authorize: () => ({ effect: "allow", reason: "allow-all (test)" }),
    cost,
    estimateTokens: () => 10,
    appender,
    effect: async () => ({ ok: true, detail: "effect ran", tokensUsed: 7 }),
  };
}

describe("runGovernedToolCall — cost.commit settlement is SURFACED, never swallowed", () => {
  it("NORMAL settle: commit committed (no overrun) -> executed + settlement committed/overrun:false", async () => {
    const commit = vi.fn<CostGate["commit"]>(async () => ({
      status: "committed",
      overrun: false,
      event: { phase: "commit", result: "ok" },
    }));
    const out = await runGovernedToolCall(depsWith(scriptedCost(commit)), call());

    expect(out.status).toBe("executed");
    if (out.status !== "executed") throw new Error("unreachable");
    expect(out.settlement).toEqual({ status: "committed", overrun: false });
    // The real actualTokens (effect.tokensUsed) was settled, not the estimate.
    expect(commit).toHaveBeenCalledWith(ctx, "rsv-1", { actualTokens: 7 });
  });

  it("OVERRUN visible: commit committed with overrun:true -> executed + settlement overrun:true", async () => {
    // The provider was already hit; the overshoot is RECORDED, not erased — the budget is now exhausted
    // (every later reserve is denied) but THIS effect's status stays executed.
    const out = await runGovernedToolCall(
      depsWith(
        scriptedCost(async () => ({
          status: "committed",
          overrun: true,
          event: { phase: "commit", result: "ok" },
        })),
      ),
      call(),
    );

    expect(out.status).toBe("executed");
    if (out.status !== "executed") throw new Error("unreachable");
    expect(out.settlement).toEqual({ status: "committed", overrun: true });
  });

  it("DENY surfaced (was SWALLOWED): commit denied -> executed (effect ran) + settlement denied with reason", async () => {
    // NON-VACUITY: revert pipeline.ts to `await deps.cost.commit(...)` (ignore the result) and this
    // assertion goes RED — the denied settlement is dropped and `out.settlement` is undefined.
    const out = await runGovernedToolCall(
      depsWith(
        scriptedCost(async () => ({
          status: "denied",
          reason: "settlement rejected by gate",
          event: { phase: "commit", result: "denied", reason: "settlement rejected by gate" },
        })),
      ),
      call(),
    );

    expect(out.status).toBe("executed"); // the effect is irreversible — denying would be a lie.
    if (out.status !== "executed") throw new Error("unreachable");
    expect(out.settlement).toEqual({ status: "denied", reason: "settlement rejected by gate" });
    // The audit receipt of the effect-that-happened is preserved.
    expect(out.receipt).toEqual({ sequence: 1 });
  });

  it("THROW surfaced (NOT a rejection, receipt preserved, no error-message leak)", async () => {
    // NON-VACUITY: remove the try/catch around cost.commit and this test goes RED — runGovernedToolCall
    // REJECTS (losing the receipt of an effect that already ran).
    // A distinctive (NON-secret-shaped, so the credential scanner stays clean) sentinel stands in for
    // whatever sensitive detail a real gate's error message might carry; the static reason must not echo it.
    const sensitiveDetail = "SENSITIVE-GATE-INTERNALS-XYZ";
    const cost = scriptedCost(async () => {
      throw new Error(`commit blew up: ${sensitiveDetail}`);
    });

    const out = await runGovernedToolCall(depsWith(cost), call());

    expect(out.status).toBe("executed"); // commit-before-effect -> effect ALREADY ran; keep the receipt.
    if (out.status !== "executed") throw new Error("unreachable");
    expect(out.receipt).toEqual({ sequence: 1 }); // the effect's receipt is NOT lost.
    expect(out.settlement.status).toBe("denied");
    if (out.settlement.status !== "denied") throw new Error("unreachable");
    // The reason is STATIC — the thrown error's message (and anything sensitive in it) must not leak.
    expect(out.settlement.reason).not.toContain(sensitiveDetail);
    expect(out.settlement.reason).not.toContain("blew up");
  });

  describe("UNCHANGED invariants (re-pinned so the settle step cannot regress them)", () => {
    it("over-budget reserve -> denied@cost: NO effect, NO settlement (hard-cap is proactive on reserve)", async () => {
      let effectCalls = 0;
      const deps: GovernedToolCallDeps<GovernedCall, { sequence: number }> = {
        ...depsWith(new InMemoryCostGate(5)),
        estimateTokens: () => 50, // over the 5-token budget
        effect: async () => {
          effectCalls++;
          return { ok: true };
        },
      };
      const out = await runGovernedToolCall(deps, call());

      expect(out).toMatchObject({ status: "denied", stage: "cost" });
      expect(effectCalls).toBe(0);
      expect(out).not.toHaveProperty("settlement");
    });

    it("abort (appender rejects) -> release + denied@commit: effect NEVER ran, reservation freed", async () => {
      const releaseSpy = vi.fn<CostGate["release"]>(async () => okRelease);
      const commitSpy = vi.fn<CostGate["commit"]>(async () => ({
        status: "committed" as const,
        overrun: false,
        event: { phase: "commit" as const, result: "ok" as const },
      }));
      const cost: CostGate = {
        reserve: async () => okReserve,
        commit: commitSpy,
        release: releaseSpy,
      };
      let effectCalls = 0;
      const deps: GovernedToolCallDeps<GovernedCall, { sequence: number }> = {
        ...depsWith(cost, failAppender),
        effect: async () => {
          effectCalls++;
          return { ok: true };
        },
      };
      const out = await runGovernedToolCall(deps, call());

      expect(out).toMatchObject({ status: "denied", stage: "commit" });
      expect(effectCalls).toBe(0); // commit-before-effect: no receipt -> no effect.
      expect(releaseSpy).toHaveBeenCalledWith(ctx, "rsv-1"); // reservation freed, not committed.
      expect(commitSpy).not.toHaveBeenCalled(); // settle never reached on the abort path.
    });
  });

  // Keep an unused import honest for the type-only CommitResult reference used in JSDoc/ergonomics.
  it("type sanity: CommitResult union is the source the settlement mirrors", () => {
    const committed: CommitResult = {
      status: "committed",
      overrun: false,
      event: { phase: "commit", result: "ok" },
    };
    expect(committed.status).toBe("committed");
  });
});
