/**
 * AgtSecondaryPolicy adapter — behavioural + adversarial RED tests.
 *
 * AGT's GovernedCallable.__call__ produces a PolicyDecision { allowed, action, matched_rule, reason }
 * (verified from /tmp/agent-governance-toolkit/.../governance/policy.py:435-455; default action = deny,
 * policy.py:238). This adapter DEMOTES the whole AGT engine to an ADVISORY input on our P2-E
 * SecondaryPolicyAdapter seam: ONLY AGT `allowed===true && action==="allow"` maps to effect:"allow";
 * EVERYTHING else (deny / warn / log / require_approval / malformed) is fail-CLOSED to effect:"deny".
 * AGT can never be the deny authority — combineDecisions guarantees an AGT-allow can never flip a
 * PDP-deny, and an AGT throw becomes a synthetic deny via evaluateSecondaries (deny-by-default).
 *
 * The real AGT Python engine (R9 SDK seam) is replaced by an injected in-process AgtEvaluateFn that can
 * be scripted to return allow / deny / warn / log / require_approval / malformed / throw, so the
 * contract runs with zero I/O and the core imports no vendor SDK.
 */
import { describe, expect, it } from "vitest";
import { combineDecisions, evaluateSecondaries } from "../../dedup.js";
import { type PolicyDecision, PolicyRequest } from "../../types.js";
import { type AgtDecision, type AgtEvaluateFn, AgtSecondaryPolicy } from "./index.js";

const req = PolicyRequest.parse({
  requestId: "req-1",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "send",
  resource: "email/x",
});

/** A PDP deny — the SOLE deny authority; an AGT advisory must never flip it. */
const pdpDeny: PolicyDecision = {
  effect: "deny",
  reason: "pdp: deny-by-default",
  matchedRule: "deny-1",
  auditRequired: true,
};
const pdpAllow: PolicyDecision = {
  effect: "allow",
  reason: "pdp: matched allow",
  auditRequired: true,
};

/** Build an AgtSecondaryPolicy whose injected engine returns a fixed AGT decision. */
function withAgt(decision: AgtDecision): AgtSecondaryPolicy {
  const fn: AgtEvaluateFn = () => decision;
  return new AgtSecondaryPolicy(fn);
}

describe("AgtSecondaryPolicy — AGT allow maps to advisory allow", () => {
  it("AGT { allowed:true, action:'allow' } => effect:'allow', auditRequired:true", () => {
    const out = withAgt({ allowed: true, action: "allow" }).evaluate(req);
    expect(out.effect).toBe("allow");
    expect(out.auditRequired).toBe(true);
  });
});

describe("AgtSecondaryPolicy — fail-CLOSED: anything that is not an unambiguous AGT allow is DENY", () => {
  // Each of these is an AGT non-allow (or a malformed shape) and MUST map to deny — never allow.
  const nonAllow: AgtDecision[] = [
    { allowed: false, action: "deny", matchedRule: "r-deny", reason: "blocked" },
    { allowed: true, action: "warn", reason: "warned" },
    { allowed: true, action: "log", reason: "logged" },
    { allowed: true, action: "require_approval", reason: "needs coordinator" },
    { allowed: true, action: "banana" } as AgtDecision, // malformed action
    { allowed: false, action: "allow" } as AgtDecision, // contradiction: action says allow but not allowed
  ];
  for (const d of nonAllow) {
    it(`AGT ${JSON.stringify(d)} => effect:'deny' (fail-closed)`, () => {
      expect(withAgt(d).evaluate(req).effect).toBe("deny");
    });
  }

  it("a malformed AGT decision object (missing fields / wrong types) => deny, never throws", () => {
    for (const garbage of [null, undefined, {}, { allowed: "yes" }, { action: "allow" }, 42]) {
      const adapter = new AgtSecondaryPolicy((() => garbage) as unknown as AgtEvaluateFn);
      expect(adapter.evaluate(req).effect).toBe("deny");
    }
  });
});

describe("AgtSecondaryPolicy — mapping fidelity (matchedRule/reason carried for audit)", () => {
  it("carries AGT matchedRule + reason into our reason and auditRequired", () => {
    const out = withAgt({
      allowed: false,
      action: "deny",
      matchedRule: "rule-42",
      reason: "policy says no",
    }).evaluate(req);
    expect(out.effect).toBe("deny");
    expect(out.auditRequired).toBe(true);
    expect(out.reason).toContain("rule-42");
    expect(out.reason).toContain("policy says no");
    expect(out.matchedRule).toBe("rule-42");
  });

  it("an AGT allow still annotates the AGT action/rule for audit", () => {
    const out = withAgt({ allowed: true, action: "allow", matchedRule: "allow-7" }).evaluate(req);
    expect(out.effect).toBe("allow");
    expect(out.reason.toLowerCase()).toContain("agt");
  });
});

describe("AgtSecondaryPolicy — PDP is the SOLE deny authority (dedup #1, adversarial)", () => {
  it("HEADLINE: a REAL AGT-allow can NEVER flip a PDP-deny (advisory only)", () => {
    const agt = withAgt({ allowed: true, action: "allow" }).evaluate(req);
    expect(agt.effect).toBe("allow"); // AGT did opine allow…
    const combined = combineDecisions(pdpDeny, [agt]);
    expect(combined.effect).toBe("deny"); // …but PDP-deny prevails.
    expect(combined.reason.toLowerCase()).toContain("allow"); // AGT allow recorded for audit
  });

  it("AGT-deny adds defense-in-depth: PDP-allow + AGT-deny => deny", () => {
    const agt = withAgt({ allowed: false, action: "deny" }).evaluate(req);
    expect(combineDecisions(pdpAllow, [agt]).effect).toBe("deny");
  });

  it("allow only when PDP allows AND the AGT advisory allows", () => {
    const agt = withAgt({ allowed: true, action: "allow" }).evaluate(req);
    expect(combineDecisions(pdpAllow, [agt]).effect).toBe("allow");
  });
});

describe("AgtSecondaryPolicy — a throwing AGT engine synthesises a DENY (deny-by-default)", () => {
  const throwing = new AgtSecondaryPolicy(() => {
    throw new Error("agt python engine blew up");
  });

  it("evaluateSecondaries turns an AGT throw into a synthetic deny", async () => {
    const decisions = await evaluateSecondaries([throwing], req);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.effect).toBe("deny");
  });

  it("a throwing AGT advisory makes the combined decision deny even when PDP allowed", async () => {
    const out = combineDecisions(pdpAllow, await evaluateSecondaries([throwing], req));
    expect(out.effect).toBe("deny");
  });
});
