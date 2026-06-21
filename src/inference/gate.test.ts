/**
 * RED-first: CostGate(model→cost) reserve hook + InferenceRoutingGate composition assertions.
 *
 * SLICE-P2R-R6-S4 (see docs/slices/phase-2-remaining/P2R-R6-S4-costgate-reserve-hook-and-compose.md,
 * docs/design/inference-routing-gate.md §2.2 / §4.2 / §4.4 / §5).
 *
 * This is the FINAL slice of the inference routing gate: it adds the `cost-map`
 * (`model → estimatedTokens`, fail-closed on an unknown model) and composes the four chokepoints
 * (S1 model allowlist → S2 egress allowlist → S3 PDP → S4 CostGate `reserve`) into a SINGLE
 * `authorize`. Two structural invariants are the heart of this slice:
 *   - any-deny-wins: a deny at ANY gate denies the whole authorization.
 *   - never-reserve-on-deny (no orphan hold): when any UPSTREAM gate denies, `reserve` is NEVER
 *     called — there is no held cost that will never be committed.
 * Plus: PDP is the sole deny authority, hard-cap (reserve denied) denies, malformed/throw fail
 * closed, credential-blind, and reason-does-not-leak.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type CostGate,
  InMemoryCostGate,
  NullCostGate,
  type ReserveRequest,
  type ReserveResult,
} from "../cost/index.js";
import type { PolicyDecision } from "../policy/index.js";
import { type CostMap, estimateTokens } from "./cost-map.js";
import { type InferenceDecision, type InferenceGateDeps, InferenceRoutingGate } from "./gate.js";
import { type EgressAllowlist, InferenceRequest, type ModelAllowlist } from "./types.js";

const ctx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
} as const;

const rawReq = {
  model: "gpt-x",
  providerType: "p1",
  egressHost: "api.allowed.example",
  estimatedTokens: 100,
  ...ctx,
};

const validReq: InferenceRequest = InferenceRequest.parse(rawReq);

const modelAllowlist: ModelAllowlist = [{ model: "gpt-x", providerType: "p1" }];
const egressAllowlist: EgressAllowlist = ["api.allowed.example"];
const costMap: CostMap = new Map([["gpt-x", 50]]);

const allowPdp: PolicyDecision = {
  effect: "allow",
  reason: "matched allow rule 'r1'",
  matchedRule: "r1",
  auditRequired: true,
};
const denyPdp: PolicyDecision = {
  effect: "deny",
  reason: "no matching allow rule (deny-by-default)",
  auditRequired: true,
};

/** A CostGate spy that records every reserve call and delegates to a real gate. */
class SpyCostGate implements CostGate {
  public reserveCalls: ReserveRequest[] = [];
  constructor(private readonly inner: CostGate) {}
  reserve(c: unknown, req: ReserveRequest): Promise<ReserveResult> {
    this.reserveCalls.push(req);
    return this.inner.reserve(c, req);
  }
  commit(...args: Parameters<CostGate["commit"]>): ReturnType<CostGate["commit"]> {
    return this.inner.commit(...args);
  }
  release(...args: Parameters<CostGate["release"]>): ReturnType<CostGate["release"]> {
    return this.inner.release(...args);
  }
}

function deps(over: Partial<InferenceGateDeps> = {}): InferenceGateDeps {
  return {
    modelAllowlist,
    egressAllowlist,
    evaluate: () => allowPdp,
    costMap,
    costGate: new InMemoryCostGate(1000),
    ...over,
  };
}

describe("estimateTokens — model→cost map (fail-closed on unknown model)", () => {
  it("a known model returns its mapped token estimate", () => {
    const out = estimateTokens(validReq, costMap);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.tokens).toBe(50);
  });

  it("an UNKNOWN model has no estimate -> ok:false (fail-closed, no estimate means deny)", () => {
    const req = InferenceRequest.parse({ ...rawReq, model: "unknown-model" });
    const out = estimateTokens(req, costMap);
    expect(out.ok).toBe(false);
  });

  it("the fail-closed reason is static text and does not echo the model id (reason-does-not-leak)", () => {
    const req = InferenceRequest.parse({ ...rawReq, model: "leak-me-model" });
    const out = estimateTokens(req, costMap);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason.length).toBeGreaterThan(0);
      expect(out.reason).not.toContain("leak-me-model");
    }
  });
});

describe("InferenceRoutingGate.authorize — four-gate composition, any-deny-wins", () => {
  it("ALL FOUR allow + budget sufficient -> allow with a reservationId; reserve called EXACTLY once", async () => {
    const spy = new SpyCostGate(new InMemoryCostGate(1000));
    const out = await new InferenceRoutingGate().authorize(rawReq, deps({ costGate: spy }));
    expect(out.decision).toBe("allow");
    if (out.decision === "allow") expect(out.reservationId.length).toBeGreaterThan(0);
    expect(spy.reserveCalls.length).toBe(1);
    // the reserve estimate comes from the cost-map (model→tokens), not the request's own field.
    expect(spy.reserveCalls[0]?.estimatedTokens).toBe(50);
  });

  it("MODEL deny (S1) -> deny, and reserve is NEVER called (no orphan hold)", async () => {
    const spy = new SpyCostGate(new InMemoryCostGate(1000));
    const out = await new InferenceRoutingGate().authorize(
      rawReq,
      deps({ costGate: spy, modelAllowlist: [] }),
    );
    expect(out.decision).toBe("deny");
    expect(spy.reserveCalls.length).toBe(0);
  });

  it("EGRESS deny (S2) -> deny, and reserve is NEVER called", async () => {
    const spy = new SpyCostGate(new InMemoryCostGate(1000));
    const out = await new InferenceRoutingGate().authorize(
      rawReq,
      deps({ costGate: spy, egressAllowlist: [] }),
    );
    expect(out.decision).toBe("deny");
    expect(spy.reserveCalls.length).toBe(0);
  });

  it("PDP deny (S3) -> deny, and reserve is NEVER called (PDP is sole authority, even with model+egress allow)", async () => {
    const spy = new SpyCostGate(new InMemoryCostGate(1000));
    const out = await new InferenceRoutingGate().authorize(
      rawReq,
      deps({ costGate: spy, evaluate: () => denyPdp }),
    );
    expect(out.decision).toBe("deny");
    expect(spy.reserveCalls.length).toBe(0);
  });

  it("CostGate reserve denied (hard-cap, tiny budget) -> deny (reserve-before-effect)", async () => {
    const spy = new SpyCostGate(new InMemoryCostGate(10)); // budget < cost-map estimate (50)
    const out = await new InferenceRoutingGate().authorize(rawReq, deps({ costGate: spy }));
    expect(out.decision).toBe("deny");
    // reserve WAS attempted (it is the final gate) but denied by the hard-cap.
    expect(spy.reserveCalls.length).toBe(1);
  });

  it("NullCostGate (no budget backend wired) -> deny (deny-by-default at the cost gate)", async () => {
    const out = await new InferenceRoutingGate().authorize(
      rawReq,
      deps({ costGate: new NullCostGate() }),
    );
    expect(out.decision).toBe("deny");
  });

  it("unknown model has no cost estimate -> deny, and reserve is NEVER called", async () => {
    const spy = new SpyCostGate(new InMemoryCostGate(1000));
    const out = await new InferenceRoutingGate().authorize(
      { ...rawReq, model: "gpt-x", providerType: "p1" },
      deps({ costGate: spy, costMap: new Map() }),
    );
    expect(out.decision).toBe("deny");
    expect(spy.reserveCalls.length).toBe(0);
  });
});

describe("InferenceRoutingGate.authorize — fail-closed", () => {
  it("a malformed request (missing fields) -> deny, never allow, reserve NEVER called", async () => {
    const spy = new SpyCostGate(new InMemoryCostGate(1000));
    const out = await new InferenceRoutingGate().authorize(
      { model: "gpt-x" },
      deps({ costGate: spy }),
    );
    expect(out.decision).toBe("deny");
    expect(spy.reserveCalls.length).toBe(0);
  });

  it("a request with an unexpected extra field (.strict) -> deny", async () => {
    const out = await new InferenceRoutingGate().authorize({ ...rawReq, smuggled: "x" }, deps());
    expect(out.decision).toBe("deny");
  });

  it("an injected evaluate that THROWS -> deny, reserve NEVER called (any step throw => deny)", async () => {
    const spy = new SpyCostGate(new InMemoryCostGate(1000));
    const out = await new InferenceRoutingGate().authorize(
      rawReq,
      deps({
        costGate: spy,
        evaluate: () => {
          throw new Error("evaluator blew up");
        },
      }),
    );
    expect(out.decision).toBe("deny");
    expect(spy.reserveCalls.length).toBe(0);
  });

  it("a costGate whose reserve THROWS -> deny (never allow)", async () => {
    const throwingGate: CostGate = {
      reserve: () => {
        throw new Error("reserve blew up");
      },
      commit: () => Promise.reject(new Error("nope")),
      release: () => Promise.reject(new Error("nope")),
    };
    const out = await new InferenceRoutingGate().authorize(
      rawReq,
      deps({ costGate: throwingGate }),
    );
    expect(out.decision).toBe("deny");
  });
});

describe("InferenceRoutingGate.authorize — reason does not leak the request payload", () => {
  it("a deny reason names the offending gate and echoes no secret/request value", async () => {
    const out: InferenceDecision = await new InferenceRoutingGate().authorize(
      { ...rawReq, egressHost: "evil.secret.host" },
      deps(),
    );
    expect(out.decision).toBe("deny");
    if (out.decision === "deny") {
      expect(out.reason.length).toBeGreaterThan(0);
      expect(out.reason).not.toContain("evil.secret.host");
      expect(out.reason).not.toContain("agent:claude");
    }
  });
});

describe("credential-blind: gate.ts + cost-map.ts source carry no credential-bearing field", () => {
  const forbidden = /\b(api[_-]?key|secret|bearer|password|credential)\b/i;
  function srcOf(rel: string): string {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    return readFileSync(p, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }
  it("gate.ts has no credential-bearing field name", () => {
    expect(forbidden.test(srcOf("./gate.ts"))).toBe(false);
  });
  it("cost-map.ts has no credential-bearing field name", () => {
    expect(forbidden.test(srcOf("./cost-map.ts"))).toBe(false);
  });
});
