/**
 * CostGate PORT CONTRACT — the shared suite EVERY CostGate implementation must pass, plus the two
 * safety invariants made command-verifiable: reserve-before-effect (no commit without a prior
 * reservation) and budget hard-cap (an over-budget reserve is denied by construction). >=2 impls
 * (NullCostGate fail-closed + InMemoryCostGate budget) prove the slot is pluggable; SpendGuard is the
 * future real adapter. The port is credential-blind by construction (it never receives a credential).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type CostGate, InMemoryCostGate, NullCostGate } from "../cost/index.js";

const validCtx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

const ADAPTERS: { name: string; make: () => CostGate }[] = [
  { name: "NullCostGate", make: () => new NullCostGate() },
  { name: "InMemoryCostGate", make: () => new InMemoryCostGate(1000) },
];

describe.each(ADAPTERS)("CostGate contract — $name", ({ make }) => {
  it("reserve returns a well-formed result whose status agrees with its event", async () => {
    const r = await make().reserve(validCtx, { estimatedTokens: 10, resource: "model/gpt" });
    expect(r.event.phase).toBe("reserve");
    expect(r.event.result).toBe(r.status === "ok" ? "ok" : "denied");
    if (r.status === "ok") expect(r.reservationId).toBeTruthy();
    else expect(r.reason).toBeTruthy();
  });

  it("is FAIL-CLOSED on a malformed AgentContext: reserve denied, no throw", async () => {
    const r = await make().reserve(
      { tenantId: "" },
      { estimatedTokens: 10, resource: "model/gpt" },
    );
    expect(r.status).toBe("denied");
    expect(r.event.contextError).toBeDefined();
  });

  it("is FAIL-CLOSED on a non-finite / non-positive estimate", async () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const r = await make().reserve(validCtx, { estimatedTokens: bad, resource: "model/gpt" });
      expect(r.status).toBe("denied");
    }
  });

  it("never throws", async () => {
    const a = make();
    await expect(a.reserve({}, { estimatedTokens: 1, resource: "x" })).resolves.toBeDefined();
    await expect(a.commit(undefined, "nope", { actualTokens: 1 })).resolves.toBeDefined();
  });
});

describe("NullCostGate — deny-all (fail-closed when no budget is configured)", () => {
  it("denies every reserve with a deny-by-default reason", async () => {
    const r = await new NullCostGate().reserve(validCtx, { estimatedTokens: 1, resource: "x" });
    expect(r.status).toBe("denied");
    if (r.status === "denied") expect(r.reason).toContain("deny-by-default");
  });
});

describe("InMemoryCostGate — reserve-before-effect + budget hard-cap", () => {
  it("reserves within budget, then commits the reservation", async () => {
    const gate = new InMemoryCostGate(100);
    const r = await gate.reserve(validCtx, { estimatedTokens: 40, resource: "x" });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect((await gate.commit(validCtx, r.reservationId, { actualTokens: 38 })).status).toBe(
      "committed",
    );
  });

  it("HARD-CAP: an over-budget reserve is DENIED (by construction)", async () => {
    const gate = new InMemoryCostGate(100);
    expect((await gate.reserve(validCtx, { estimatedTokens: 60, resource: "x" })).status).toBe(
      "ok",
    );
    // 60 held, 40 left -> a 60 reserve must be denied.
    const r = await gate.reserve(validCtx, { estimatedTokens: 60, resource: "x" });
    expect(r.status).toBe("denied");
    if (r.status === "denied") expect(r.reason.toLowerCase()).toMatch(/budget|cap/);
  });

  it("RESERVE-BEFORE-EFFECT: committing an unknown reservation is denied", async () => {
    const r = await new InMemoryCostGate(100).commit(validCtx, "sbx-never", { actualTokens: 1 });
    expect(r.status).toBe("denied");
  });

  it("OVERRUN: a commit whose actual exceeds budget is recorded (not erased) and exhausts further reserves", async () => {
    // The provider was already hit — the spend is real and cannot be denied after the fact. It is
    // recorded with overrun=true, and the now-over-budget gate must deny every subsequent reserve.
    const gate = new InMemoryCostGate(100);
    const reserved = await gate.reserve(validCtx, { estimatedTokens: 10, resource: "x" });
    expect(reserved.status).toBe("ok");
    if (reserved.status !== "ok") return;
    const committed = await gate.commit(validCtx, reserved.reservationId, { actualTokens: 5000 });
    expect(committed.status).toBe("committed");
    if (committed.status === "committed") expect(committed.overrun).toBe(true);
    // Budget is now blown -> any further reserve is denied (hard-cap reasserted).
    expect((await gate.reserve(validCtx, { estimatedTokens: 1, resource: "x" })).status).toBe(
      "denied",
    );
  });

  it("a within-budget commit reports overrun=false", async () => {
    const gate = new InMemoryCostGate(100);
    const r = await gate.reserve(validCtx, { estimatedTokens: 40, resource: "x" });
    if (r.status !== "ok") throw new Error("reserve should succeed");
    const c = await gate.commit(validCtx, r.reservationId, { actualTokens: 38 });
    expect(c.status).toBe("committed");
    if (c.status === "committed") expect(c.overrun).toBe(false);
  });
});

describe("CostGate port is credential-blind by construction", () => {
  it("port.ts surface (excluding comments) names no credential/secret/authorization field", () => {
    const raw = readFileSync(new URL("../cost/port.ts", import.meta.url), "utf8");
    // Strip block + line comments — the doc prose legitimately explains credential-blindness; what
    // must be clean is the CODE (type/field names), not the explanation.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(/credential|secret|password|authorization|bearer|apikey|api[_-]?key/i.test(code)).toBe(
      false,
    );
  });
});
