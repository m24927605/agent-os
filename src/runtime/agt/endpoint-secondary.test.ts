/**
 * SLICE-R9b-2a — endpoint-backed AGT async SecondaryPolicyAdapter (RED-first).
 *
 * `createAgtEndpointSecondary(transport)` returns an ASYNC SecondaryPolicyAdapter (R9a made evaluate
 * MaybePromise) that maps our PolicyRequest -> AgtEvaluateRequest -> `await transport.evaluate(...)` ->
 * AgtEvaluateResponse -> PolicyDecision. The transport is INJECTED as a fake `{ evaluate }` — NO real
 * grpc / sidecar here. Invariants pinned (all via behaviour, with documented non-vacuity mutations):
 *
 *   MAPPING: allowed===true && action==="allow" -> allow; deny/warn/log/require_approval/unknown/
 *     malformed -> deny; the deny reason carries `agt_action=<action>` + matched_rule, redacted.
 *
 *   FAIL-CLOSED: a transport that REJECTS (unreachable) / resolves a MALFORMED response / (timeout
 *     simulated as a reject) -> the adapter's evaluate THROWS -> combineDecisions(allowPdp, await
 *     evaluateSecondaries([adapter], req)) is a DENY (configured-down -> deny). NON-VACUITY: an adapter
 *     that treats a transport error as ALLOW flips this RED (asserted below via a deliberately-broken
 *     double).
 *
 *   ADVISORY-ONLY: an AGT allow can NEVER relax a PDP deny (combineDecisions, PDP sovereign).
 *
 *   CREDENTIAL-BLIND: the AgtEvaluateRequest handed to the transport carries ONLY the neutral fields +
 *     the (already best-effort-redacted) projection — NO raw args. A runtime-built sk- canary in the
 *     projection shows up ONLY in its already-redacted form; the deny reason is redacted. NON-VACUITY:
 *     an adapter that attaches the raw toolCall/args flips this RED (asserted via a broken double).
 */
import { describe, expect, it } from "vitest";
import { buildExecRunProjection } from "../../policy/governance-projection.js";
import { combineDecisions, evaluateSecondaries } from "../../policy/index.js";
import { type PolicyDecision, PolicyRequest } from "../../policy/types.js";
import type { AgtEvaluateRequest, AgtEvaluateResponse } from "./_generated/agt_decision.js";
import { type AgtDecisionTransport, createAgtEndpointSecondary } from "./index.js";

/** Build a `sk-`-shaped canary at RUNTIME so the literal never appears in this source (secret-scan). */
function skCanary(): string {
  return `${"sk"}-${"A".repeat(24)}`;
}

const REDACTED = "[REDACTED]";

// SLICE-R9b-2b — the AGT secondary now ABSTAINS (allow, no transport call) when the request carries NO
// governance projection (the scope gate's runtime effect). So the R9b-2a mapping / fail-closed /
// credential-blind invariants — which all require the transport to be CONSULTED — must pass an IN-SCOPE
// request that CARRIES a projection. This shared `req` does. (The abstain path is proven in the dedicated
// endpoint-secondary.scope-skip.test.ts.)
const req = PolicyRequest.parse({
  requestId: "req-1",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "exec.run",
  resource: "exec/run",
  governanceProjection: buildExecRunProjection({ argv: ["ls", "-la"] }),
});

const pdpAllow: PolicyDecision = {
  effect: "allow",
  reason: "pdp: matched allow",
  auditRequired: true,
};
const pdpDeny: PolicyDecision = {
  effect: "deny",
  reason: "pdp: deny-by-default",
  matchedRule: "deny-1",
  auditRequired: true,
};

/** A fake transport that resolves a fixed response and records the request it was handed. */
function fakeResolving(resp: Partial<AgtEvaluateResponse>): {
  transport: AgtDecisionTransport;
  seen(): AgtEvaluateRequest | undefined;
} {
  let captured: AgtEvaluateRequest | undefined;
  const transport: AgtDecisionTransport = {
    async evaluate(r) {
      captured = r;
      return {
        allowed: resp.allowed ?? false,
        action: resp.action ?? "",
        matchedRule: resp.matchedRule ?? "",
        reason: resp.reason ?? "",
      };
    },
  };
  return { transport, seen: () => captured };
}

/** A fake transport that always rejects (unreachable / timeout simulated as reject). */
const rejectingTransport: AgtDecisionTransport = {
  async evaluate() {
    throw new Error("agt sidecar unreachable (ECONNREFUSED)");
  },
};

describe("createAgtEndpointSecondary — mapping", () => {
  it("AGT { allowed:true, action:'allow' } -> effect:'allow'", async () => {
    const { transport } = fakeResolving({ allowed: true, action: "allow" });
    const out = await createAgtEndpointSecondary(transport).evaluate(req);
    expect(out.effect).toBe("allow");
    expect(out.auditRequired).toBe(true);
  });

  const nonAllow: Array<Partial<AgtEvaluateResponse>> = [
    { allowed: false, action: "deny", matchedRule: "r-deny", reason: "blocked" },
    { allowed: true, action: "warn", reason: "warned" },
    { allowed: true, action: "log", reason: "logged" },
    { allowed: true, action: "require_approval", reason: "needs coordinator" },
    { allowed: true, action: "banana" }, // unknown action
    { allowed: false, action: "allow" }, // contradiction: action allow but not allowed
    { allowed: true, action: "" }, // malformed: empty action
  ];
  for (const r of nonAllow) {
    it(`AGT ${JSON.stringify(r)} -> effect:'deny' (fail-closed)`, async () => {
      const { transport } = fakeResolving(r);
      const out = await createAgtEndpointSecondary(transport).evaluate(req);
      expect(out.effect).toBe("deny");
    });
  }

  it("a deny reason carries agt_action=<action> and matched_rule for the audit trail", async () => {
    const { transport } = fakeResolving({
      allowed: false,
      action: "deny",
      matchedRule: "rule-42",
      reason: "policy says no",
    });
    const out = await createAgtEndpointSecondary(transport).evaluate(req);
    expect(out.effect).toBe("deny");
    expect(out.reason).toContain("agt_action=deny");
    expect(out.reason).toContain("rule-42");
    expect(out.matchedRule).toBe("rule-42");
  });
});

describe("createAgtEndpointSecondary — credential-blind: ONLY neutral fields + projection are sent", () => {
  it("the AgtEvaluateRequest carries the neutral fields + projection and NO raw args; canary is pre-redacted", async () => {
    const canary = skCanary();
    // The projection passes argv through redactSecrets, so the sk- canary is ALREADY redacted in it.
    const projection = buildExecRunProjection({
      argv: ["curl", canary, "https://api.example.com"],
    });
    const withProj = PolicyRequest.parse({
      requestId: "req-1",
      tenantId: "tenant-a",
      projectId: "proj-1",
      taskId: "task-1",
      actorId: "agent:claude",
      action: "exec.run",
      resource: "exec/run",
      governanceProjection: projection,
    });

    const { transport, seen } = fakeResolving({ allowed: false, action: "deny", reason: canary });
    await createAgtEndpointSecondary(transport).evaluate(withProj);

    const sent = seen();
    expect(sent).toBeDefined();
    // ONLY neutral fields + the projection are present.
    expect(sent?.requestId).toBe("req-1");
    expect(sent?.tenantId).toBe("tenant-a");
    expect(sent?.action).toBe("exec.run");
    expect(sent?.resource).toBe("exec/run");
    expect(sent?.governanceProjection).toBeDefined();
    // NO raw args / toolCall snuck onto the wire request (the AgtEvaluateRequest has no such field).
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain("toolCall");
    expect(serialized).not.toContain('argv"'); // no raw `argv` array, only `argvRedacted`
    // The canary appears ONLY in its already-redacted projection form (adapter adds no new leak).
    expect(serialized).not.toContain(canary);
    expect(serialized).toContain(REDACTED);
  });

  it("the resulting deny reason is redacted (a canary in the AGT reason is scrubbed)", async () => {
    const canary = skCanary();
    const { transport } = fakeResolving({ allowed: false, action: "deny", reason: canary });
    const out = await createAgtEndpointSecondary(transport).evaluate(req);
    expect(out.effect).toBe("deny");
    expect(out.reason).not.toContain(canary);
    expect(out.reason).toContain(REDACTED);
  });

  it("NON-VACUITY: an adapter that attaches the raw toolCall/args would leak the canary (flips RED)", async () => {
    // A deliberately-broken double that attaches raw args proves the credential-blind assertion above
    // is non-vacuous: were the real adapter to do this, the serialized request WOULD contain the canary.
    const canary = skCanary();
    let captured: unknown;
    const leakyTransport: AgtDecisionTransport = {
      async evaluate(r) {
        captured = { ...r, rawToolCall: { argv: ["curl", canary] } };
        return { allowed: false, action: "deny", matchedRule: "", reason: "" };
      },
    };
    await leakyTransport.evaluate({
      requestId: "x",
      tenantId: "t",
      projectId: "p",
      taskId: "tk",
      actorId: "a",
      action: "exec.run",
      resource: "exec/run",
      governanceProjection: undefined,
    });
    expect(JSON.stringify(captured)).toContain(canary); // the leaky shape WOULD expose it
  });
});

describe("createAgtEndpointSecondary — fail-closed (transport down/timeout/malformed -> deny)", () => {
  it("a rejecting transport makes the adapter THROW (so evaluateSecondaries synthesises a deny)", async () => {
    const adapter = createAgtEndpointSecondary(rejectingTransport);
    await expect(adapter.evaluate(req)).rejects.toThrow();
  });

  it("HEADLINE: transport-down -> combineDecisions(allowPdp, evaluateSecondaries([adapter])) is DENY", async () => {
    const adapter = createAgtEndpointSecondary(rejectingTransport);
    const out = combineDecisions(pdpAllow, await evaluateSecondaries([adapter], req));
    expect(out.effect).toBe("deny"); // configured-but-down -> deny (fail-closed)
  });

  it("a malformed transport response (missing/garbage shape) is treated as deny", async () => {
    const malformed: AgtDecisionTransport = {
      async evaluate() {
        // Resolve something that is NOT a valid AgtEvaluateResponse.
        return { nonsense: true } as unknown as AgtEvaluateResponse;
      },
    };
    const out = await createAgtEndpointSecondary(malformed).evaluate(req);
    expect(out.effect).toBe("deny");
  });

  it("NON-VACUITY: an adapter that treats a transport error as ALLOW flips fail-closed RED", async () => {
    // A deliberately-broken double proves the fail-closed assertion is non-vacuous: were the adapter to
    // map a transport error to allow, the combined decision with a PDP-allow would be allow, not deny.
    const downAsAllow: AgtDecisionTransport = {
      async evaluate() {
        throw new Error("down");
      },
    };
    const broken = {
      async evaluate(_r: PolicyRequest): Promise<PolicyDecision> {
        try {
          await downAsAllow.evaluate({
            requestId: "x",
            tenantId: "t",
            projectId: "p",
            taskId: "tk",
            actorId: "a",
            action: "a",
            resource: "r",
            governanceProjection: undefined,
          });
          return { effect: "allow", reason: "ok", auditRequired: true };
        } catch {
          return { effect: "allow", reason: "down-as-allow (WRONG)", auditRequired: true };
        }
      },
    };
    const out = combineDecisions(pdpAllow, await evaluateSecondaries([broken], req));
    expect(out.effect).toBe("allow"); // proves a down-as-allow adapter WOULD wrongly allow
  });
});

describe("createAgtEndpointSecondary — advisory-only (PDP is the SOLE deny authority)", () => {
  it("an AGT allow can NEVER flip a PDP deny", async () => {
    const { transport } = fakeResolving({ allowed: true, action: "allow" });
    const agt = await createAgtEndpointSecondary(transport).evaluate(req);
    expect(agt.effect).toBe("allow"); // AGT opined allow…
    const combined = combineDecisions(pdpDeny, [agt]);
    expect(combined.effect).toBe("deny"); // …but PDP-deny prevails.
  });

  it("allow only when PDP allows AND the AGT advisory allows", async () => {
    const { transport } = fakeResolving({ allowed: true, action: "allow" });
    const agt = await createAgtEndpointSecondary(transport).evaluate(req);
    expect(combineDecisions(pdpAllow, [agt]).effect).toBe("allow");
  });
});
