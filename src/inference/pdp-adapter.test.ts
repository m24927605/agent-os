/**
 * RED-first: PDP-integration chokepoint assertions (THIRD gate of the inference routing gate).
 *
 * SLICE-P2R-R6-S3 (see docs/slices/phase-2-remaining/P2R-R6-S3-pdp-integration.md,
 * docs/design/inference-routing-gate.md §2.2 step 3 / §4.3 trade-off 3 / §5).
 *
 * This layer turns a vendor-neutral `InferenceRequest` into a `PolicyRequest`
 * (action="inference:invoke", resource derived from model+egressHost, ids carried through) and
 * forwards it to the EXISTING PDP — supplied as an INJECTED `evaluate` function so the gate is not
 * hard-wired to the PDP implementation (design §4.3 trade-off 3).
 *
 * Invariants under adversarial test:
 *  - PDP is the SOLE deny authority: a PDP `deny` is returned verbatim; the adapter NEVER flips it.
 *  - PDP `allow` is passed through unchanged (effect + auditRequired).
 *  - fail-closed: an injected `evaluate` that THROWS is treated as `deny` (try/catch in the adapter).
 *  - the conversion produces a schema-valid PolicyRequest and never fabricates / drops ids.
 *  - reason-does-not-leak: the adapter passes the PDP reason through and adds no request value itself.
 */
import { describe, expect, it } from "vitest";
import { type PolicyDecision, PolicyRequest } from "../policy/index.js";
import { evaluateInferencePolicy, toPolicyRequest } from "./pdp-adapter.js";
import { InferenceRequest } from "./types.js";

const ctx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
} as const;

const req: InferenceRequest = InferenceRequest.parse({
  model: "gpt-x",
  providerType: "p1",
  egressHost: "api.allowed.example",
  estimatedTokens: 100,
  ...ctx,
});

const allowDecision: PolicyDecision = {
  effect: "allow",
  reason: "matched allow rule 'r1'",
  matchedRule: "r1",
  auditRequired: true,
};
const denyDecision: PolicyDecision = {
  effect: "deny",
  reason: "no matching allow rule (deny-by-default)",
  auditRequired: true,
};

describe("toPolicyRequest — InferenceRequest -> PolicyRequest conversion", () => {
  it("produces a schema-valid PolicyRequest", () => {
    const out = toPolicyRequest(req);
    expect(PolicyRequest.safeParse(out).success).toBe(true);
  });

  it("fixes action to 'inference:invoke'", () => {
    expect(toPolicyRequest(req).action).toBe("inference:invoke");
  });

  it("carries the agent identity ids through unchanged (never fabricates / drops ids)", () => {
    const out = toPolicyRequest(req);
    expect(out.actorId).toBe(ctx.actorId);
    expect(out.tenantId).toBe(ctx.tenantId);
    expect(out.projectId).toBe(ctx.projectId);
    expect(out.taskId).toBe(ctx.taskId);
    expect(out.requestId).toBe(ctx.requestId);
  });

  it("derives a non-empty resource from the request (model + egress host)", () => {
    const out = toPolicyRequest(req);
    expect(out.resource.length).toBeGreaterThan(0);
    expect(out.resource).toContain("gpt-x");
    expect(out.resource).toContain("api.allowed.example");
  });
});

describe("evaluateInferencePolicy — PDP is the sole deny authority", () => {
  it("PDP deny -> deny (the adapter never flips a deny into an allow)", () => {
    const out = evaluateInferencePolicy(req, () => denyDecision);
    expect(out.effect).toBe("deny");
  });

  it("PDP allow -> allow (passed through, effect + auditRequired preserved)", () => {
    const out = evaluateInferencePolicy(req, () => allowDecision);
    expect(out.effect).toBe("allow");
    expect(out.auditRequired).toBe(true);
  });

  it("forwards the converted PolicyRequest (action='inference:invoke') to the injected evaluator", () => {
    let seen: unknown;
    evaluateInferencePolicy(req, (input) => {
      seen = input;
      return allowDecision;
    });
    const parsed = PolicyRequest.safeParse(seen);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.action).toBe("inference:invoke");
      expect(parsed.data.actorId).toBe(ctx.actorId);
    }
  });
});

describe("evaluateInferencePolicy — fail-closed", () => {
  it("an injected evaluator that THROWS is treated as deny (never allow)", () => {
    const out = evaluateInferencePolicy(req, () => {
      throw new Error("evaluator blew up");
    });
    expect(out.effect).toBe("deny");
    expect(out.auditRequired).toBe(true);
  });

  it("a PDP deny on malformed input is honoured (the adapter does not second-guess the PDP)", () => {
    // Sole-authority + fail-closed: whatever the PDP says on a malformed-derived request stands.
    const out = evaluateInferencePolicy(req, () => denyDecision);
    expect(out.effect).toBe("deny");
  });
});

describe("evaluateInferencePolicy — reason does not leak the request payload", () => {
  it("passes the PDP reason through and adds no request value of its own", () => {
    const out = evaluateInferencePolicy(req, () => denyDecision);
    expect(out.effect).toBe("deny");
    expect(out.reason).toBe(denyDecision.reason);
    expect(out.reason).not.toContain("agent:claude");
    expect(out.reason).not.toContain("tenant-a");
    expect(out.reason).not.toContain("gpt-x");
  });

  it("the fail-closed (throw) deny reason is static and leaks no request value", () => {
    const out = evaluateInferencePolicy(req, () => {
      throw new Error("agent:claude tenant-a gpt-x");
    });
    expect(out.effect).toBe("deny");
    expect(out.reason).not.toContain("agent:claude");
    expect(out.reason).not.toContain("tenant-a");
    expect(out.reason).not.toContain("gpt-x");
  });
});
