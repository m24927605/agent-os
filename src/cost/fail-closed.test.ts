/**
 * SLICE-IT1a — failClosedCostGate decorator: a rejecting/throwing CostGate method becomes a structured
 * DENY (deny-by-default), and a well-behaved gate is passed through TRANSPARENTLY (byte-identical).
 *
 * RED-first: `failClosedCostGate` does not exist yet, so this suite fails to type/compile.
 */
import { describe, expect, it } from "vitest";
import { failClosedCostGate } from "./fail-closed.js";
import { InMemoryCostGate } from "./in-memory.js";
import type {
  CommitResult,
  CommitSettle,
  CostGate,
  ReleaseResult,
  ReserveRequest,
  ReserveResult,
} from "./port.js";

const ctx = {
  actorId: "agent:x",
  tenantId: "t",
  projectId: "p",
  taskId: "tk",
  requestId: "r",
};

// A runtime-assembled secret canary (never a literal in source).
const SECRET_CANARY = `sk-${"d".repeat(24)}`;

/** A gate whose every method REJECTS — and whose error message carries a secret (to prove non-leak). */
class ThrowingCostGate implements CostGate {
  reserve(_ctx: unknown, _req: ReserveRequest): Promise<ReserveResult> {
    return Promise.reject(new Error(`reserve fault carrying ${SECRET_CANARY}`));
  }
  commit(_ctx: unknown, _id: string, _settle: CommitSettle): Promise<CommitResult> {
    return Promise.reject(new Error(`commit fault carrying ${SECRET_CANARY}`));
  }
  release(_ctx: unknown, _id: string): Promise<ReleaseResult> {
    return Promise.reject(new Error(`release fault carrying ${SECRET_CANARY}`));
  }
}

describe("failClosedCostGate", () => {
  it("a THROWING reserve becomes a structured deny — and the static reason does NOT leak the error/secret", async () => {
    const gate = failClosedCostGate(new ThrowingCostGate());
    const res = await gate.reserve(ctx, { estimatedTokens: 10, resource: "tool:x" });
    expect(res.status).toBe("denied");
    if (res.status !== "denied") return;
    // Static deny-by-default reason; NEVER the interpolated error message (credential-blind).
    expect(res.reason).not.toContain(SECRET_CANARY);
    expect(res.reason).not.toContain("fault carrying");
  });

  it("a THROWING commit and release also become structured denies (no escaping rejection)", async () => {
    const gate = failClosedCostGate(new ThrowingCostGate());
    const committed = await gate.commit(ctx, "rsv-1", { actualTokens: 10 });
    expect(committed.status).toBe("denied");
    const released = await gate.release(ctx, "rsv-1");
    expect(released.status).toBe("denied");
    expect(JSON.stringify({ committed, released })).not.toContain(SECRET_CANARY);
  });

  it("TRANSPARENT over a well-behaved gate: a successful reserve/commit passes through unchanged", async () => {
    const gate = failClosedCostGate(new InMemoryCostGate(1000));
    const reserved = await gate.reserve(ctx, { estimatedTokens: 10, resource: "tool:x" });
    expect(reserved.status).toBe("ok");
    if (reserved.status !== "ok") return;
    const committed = await gate.commit(ctx, reserved.reservationId, { actualTokens: 10 });
    expect(committed.status).toBe("committed");
  });

  it("TRANSPARENT over the in-memory hard-cap: an over-budget reserve still denies@budget (not a fault deny)", async () => {
    const gate = failClosedCostGate(new InMemoryCostGate(5));
    const res = await gate.reserve(ctx, { estimatedTokens: 50, resource: "tool:x" });
    expect(res.status).toBe("denied");
    if (res.status !== "denied") return;
    // The wrapper did NOT swallow/alter the gate's own structured deny — it passed through verbatim.
    expect(res.reason).toContain("budget exhausted");
  });
});
