/**
 * SLICE-R9b-2b — the AGT endpoint secondary's SCOPE-SKIP (RED-first).
 *
 * R9b-2b adds the runtime effect of the scope gate to `createAgtEndpointSecondary(...)`: when the
 * PolicyRequest carries NO `governanceProjection` (out-of-scope / read-only tool / no projector), the
 * secondary ABSTAINS — it returns `{ effect: "allow" }` WITHOUT calling the transport. Only when a
 * projection is PRESENT does it consult the transport (the in-scope effectful path).
 *
 * WHY SAFE: AGT is advisory. Abstain = "no advisory opinion", NOT a grant — the PDP still governs
 * (combineDecisions keeps the PDP sovereign). And it is the latency cut: a read-only tool never pays the
 * UDS round-trip.
 *
 * NON-VACUITY: make the secondary call the transport even with NO projection (drop the scope-skip) and
 * the call-count-0 assertion below flips RED.
 */
import { describe, expect, it } from "vitest";
import { buildExecRunProjection } from "../../policy/index.js";
import { type PolicyDecision, PolicyRequest } from "../../policy/types.js";
import type { AgtEvaluateRequest, AgtEvaluateResponse } from "./_generated/agt_decision.js";
import { type AgtDecisionTransport, createAgtEndpointSecondary } from "./index.js";

const reqNoProjection = PolicyRequest.parse({
  requestId: "req-1",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "tool:invoke",
  resource: "exec.echo",
});

const reqWithProjection = PolicyRequest.parse({
  requestId: "req-2",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "tool:invoke",
  resource: "exec.run",
  governanceProjection: buildExecRunProjection({ argv: ["ls", "-la"] }),
});

/** A spying fake transport that records (counts) every evaluate call. */
function spyTransport(resp: Partial<AgtEvaluateResponse>): {
  transport: AgtDecisionTransport;
  calls: AgtEvaluateRequest[];
} {
  const calls: AgtEvaluateRequest[] = [];
  return {
    calls,
    transport: {
      async evaluate(r) {
        calls.push(r);
        return {
          allowed: resp.allowed ?? false,
          action: resp.action ?? "",
          matchedRule: resp.matchedRule ?? "",
          reason: resp.reason ?? "",
        };
      },
    },
  };
}

describe("createAgtEndpointSecondary — scope-skip (abstain when no projection)", () => {
  it("NO projection -> abstain (effect allow) WITHOUT calling the transport (call count 0)", async () => {
    const { transport, calls } = spyTransport({ allowed: false, action: "deny", reason: "no" });
    const out: PolicyDecision =
      await createAgtEndpointSecondary(transport).evaluate(reqNoProjection);
    // NON-VACUITY: drop the scope-skip (always call the transport) -> calls.length === 1 AND (deny resp)
    // out.effect === "deny" -> RED.
    expect(calls.length).toBe(0);
    expect(out.effect).toBe("allow");
  });

  it("WITH a projection -> the transport IS consulted (in-scope effectful path preserved)", async () => {
    const { transport, calls } = spyTransport({ allowed: true, action: "allow" });
    const out = await createAgtEndpointSecondary(transport).evaluate(reqWithProjection);
    expect(calls.length).toBe(1);
    expect(out.effect).toBe("allow");
  });

  it("WITH a projection + AGT-deny -> deny (the transport's deny is honoured)", async () => {
    const { transport, calls } = spyTransport({
      allowed: false,
      action: "deny",
      reason: "blocked",
    });
    const out = await createAgtEndpointSecondary(transport).evaluate(reqWithProjection);
    expect(calls.length).toBe(1);
    expect(out.effect).toBe("deny");
  });
});
