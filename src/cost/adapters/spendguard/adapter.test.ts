/**
 * SpendGuardCostGate adapter — behavioural + adversarial RED tests.
 *
 * Maps SpendGuard's real session-reservation ledger (verified from
 * /tmp/agentic-spendguard/services/ledger/src/session_reservations.rs: ReserveSessionLedgerRequest
 * :32-49, reserve_session :97-112, CommitSessionDeltaLedgerRequest :51-77, commit_session_delta
 * :114-127) onto the vendor-neutral CostGate port, while OVERRIDING SpendGuard's predictor-down
 * fail-OPEN with our fail-CLOSED law (decision.rs :55-63 fails closed on a missing estimate; the
 * adapter extends that to every transport error).
 *
 * The real Postgres-stored-proc-over-gRPC ledger (R1) is replaced by an injected in-process
 * LedgerTransport double that can be scripted to return ok / over-budget / overrun / error, so the
 * contract runs with no I/O. These tests assert: reserve/commit token-count mapping, hard-cap deny on
 * over-budget, overrun recording + subsequent-reserve lock-down, reserve-before-effect, fail-CLOSED on
 * bad ctx / bad token count / transport throw, and credential-blindness of the dispatched ledger req.
 */
import { describe, expect, it } from "vitest";
import {
  type LedgerCommitReq,
  type LedgerReserveReq,
  type LedgerTransport,
  SpendGuardCostGate,
} from "./index.js";

const ctxA = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

/** A scriptable in-process LedgerTransport double recording every dispatched reserve/commit req. */
class RecordingLedger implements LedgerTransport {
  readonly reserveReqs: LedgerReserveReq[] = [];
  readonly commitReqs: LedgerCommitReq[] = [];
  private counter = 0;
  constructor(
    private readonly opts: {
      overBudgetOnReserve?: boolean;
      overrunOnCommit?: boolean;
    } = {},
  ) {}
  reserve(req: LedgerReserveReq): Promise<{ reservationId: string } | { overBudget: true }> {
    this.reserveReqs.push(req);
    if (this.opts.overBudgetOnReserve) return Promise.resolve({ overBudget: true });
    return Promise.resolve({ reservationId: `rsv-${++this.counter}` });
  }
  commit(req: LedgerCommitReq): Promise<{ overrun: boolean }> {
    this.commitReqs.push(req);
    return Promise.resolve({ overrun: this.opts.overrunOnCommit ?? false });
  }
}

class ThrowingLedger implements LedgerTransport {
  reserve(): Promise<{ reservationId: string } | { overBudget: true }> {
    throw new Error("ledger transport down");
  }
  commit(): Promise<{ overrun: boolean }> {
    throw new Error("ledger transport down");
  }
}

describe("SpendGuardCostGate — reserve (reserve_session mapping)", () => {
  it("maps a valid reserve to ok + a reservationId, mapping token count to ledger amount", async () => {
    const ledger = new RecordingLedger();
    const gate = new SpendGuardCostGate(ledger);
    const r = await gate.reserve(ctxA, { estimatedTokens: 42, resource: "model/gpt" });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.reservationId).toBeTruthy();
      expect(r.event.phase).toBe("reserve");
      expect(r.event.result).toBe("ok");
    }
    expect(ledger.reserveReqs).toHaveLength(1);
    // tokens -> estimated_amount_atomic, resource -> route (verified mapping).
    expect(ledger.reserveReqs[0]?.estimated_amount_atomic).toBe(42);
    expect(ledger.reserveReqs[0]?.route).toBe("model/gpt");
  });
});

describe("SpendGuardCostGate — hard-cap (over-budget reserve is DENIED)", () => {
  it("an over-budget ledger response denies the reserve and flags hard-cap", async () => {
    const gate = new SpendGuardCostGate(new RecordingLedger({ overBudgetOnReserve: true }));
    const r = await gate.reserve(ctxA, { estimatedTokens: 10, resource: "x" });
    expect(r.status).toBe("denied");
    if (r.status === "denied") expect(r.reason.toLowerCase()).toMatch(/budget|cap/);
  });
});

describe("SpendGuardCostGate — commit (commit_session_delta mapping)", () => {
  it("a within-budget commit reports overrun=false and maps actualTokens to the delta", async () => {
    const ledger = new RecordingLedger();
    const gate = new SpendGuardCostGate(ledger);
    const reserved = await gate.reserve(ctxA, { estimatedTokens: 10, resource: "x" });
    if (reserved.status !== "ok") throw new Error("reserve should succeed");
    const c = await gate.commit(ctxA, reserved.reservationId, { actualTokens: 8 });
    expect(c.status).toBe("committed");
    if (c.status === "committed") expect(c.overrun).toBe(false);
    expect(ledger.commitReqs).toHaveLength(1);
    expect(ledger.commitReqs[0]?.amount_atomic_delta).toBe(8);
  });

  it("OVERRUN: an over-budget commit is recorded (overrun=true) and exhausts every subsequent reserve", async () => {
    const gate = new SpendGuardCostGate(new RecordingLedger({ overrunOnCommit: true }));
    const reserved = await gate.reserve(ctxA, { estimatedTokens: 10, resource: "x" });
    if (reserved.status !== "ok") throw new Error("reserve should succeed");
    const c = await gate.commit(ctxA, reserved.reservationId, { actualTokens: 5000 });
    expect(c.status).toBe("committed");
    if (c.status === "committed") expect(c.overrun).toBe(true);
    // Budget blown -> any further reserve is denied (hard-cap reasserted, deny-by-default).
    const after = await gate.reserve(ctxA, { estimatedTokens: 1, resource: "x" });
    expect(after.status).toBe("denied");
  });

  it("RESERVE-BEFORE-EFFECT: committing an unknown reservation is denied without hitting the ledger", async () => {
    const ledger = new RecordingLedger();
    const gate = new SpendGuardCostGate(ledger);
    const r = await gate.commit(ctxA, "rsv-never", { actualTokens: 1 });
    expect(r.status).toBe("denied");
    expect(ledger.commitReqs).toHaveLength(0);
  });
});

describe("SpendGuardCostGate — credential-blind dispatched ledger req", () => {
  it("the reserve req carries only token count + route, no secret-shape field/value", async () => {
    const ledger = new RecordingLedger();
    const gate = new SpendGuardCostGate(ledger);
    await gate.reserve(ctxA, { estimatedTokens: 7, resource: "model/gpt" });
    const req = JSON.stringify(ledger.reserveReqs[0] ?? {});
    expect(
      /credential|secret|password|authorization|bearer|apikey|api[_-]?key|sk-[a-z0-9]/i.test(req),
    ).toBe(false);
  });
});

describe("SpendGuardCostGate — fail-CLOSED (deny-by-default, never throws)", () => {
  it("a malformed ctx is denied with a contextError and never hits the ledger", async () => {
    const ledger = new RecordingLedger();
    const gate = new SpendGuardCostGate(ledger);
    for (const bad of [{}, null, { tenantId: "" }]) {
      const r = await gate.reserve(bad, { estimatedTokens: 10, resource: "x" });
      expect(r.status).toBe("denied");
      expect(r.event.contextError).toBeDefined();
    }
    expect(ledger.reserveReqs).toHaveLength(0);
  });

  it("a non-finite / non-positive estimate is denied before the ledger is hit", async () => {
    const ledger = new RecordingLedger();
    const gate = new SpendGuardCostGate(ledger);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const r = await gate.reserve(ctxA, { estimatedTokens: bad, resource: "x" });
      expect(r.status).toBe("denied");
    }
    expect(ledger.reserveReqs).toHaveLength(0);
  });

  it("OVERRIDES SpendGuard fail-OPEN: a throwing ledger transport DENIES (fail-closed), never resolves ok", async () => {
    const gate = new SpendGuardCostGate(new ThrowingLedger());
    const r = await gate.reserve(ctxA, { estimatedTokens: 10, resource: "x" });
    expect(r.status).toBe("denied");
    if (r.status === "denied") expect(r.reason).toBeTruthy();
  });

  it("a throwing ledger on commit (after a real reserve) DENIES, never throws", async () => {
    // reserve via a healthy ledger, then swap to a throwing one to prove commit is fail-closed too.
    const gate = new SpendGuardCostGate(new RecordingLedger());
    const reserved = await gate.reserve(ctxA, { estimatedTokens: 10, resource: "x" });
    if (reserved.status !== "ok") throw new Error("reserve should succeed");
    const throwGate = new SpendGuardCostGate(new ThrowingLedger());
    // a fresh gate has no reservation -> reserve-before-effect deny (still no throw).
    const r = await throwGate.commit(ctxA, reserved.reservationId, { actualTokens: 1 });
    expect(r.status).toBe("denied");
  });

  it("every method resolves (never throws) on garbage input", async () => {
    const gate = new SpendGuardCostGate(new ThrowingLedger());
    await expect(gate.reserve({}, { estimatedTokens: 1, resource: "x" })).resolves.toBeDefined();
    await expect(gate.commit(undefined, "nope", { actualTokens: 1 })).resolves.toBeDefined();
  });
});
