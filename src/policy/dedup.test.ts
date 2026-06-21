import { describe, expect, it } from "vitest";
import {
  AllowAllSecondaryPolicy,
  DenyAllSecondaryPolicy,
  type SecondaryPolicyAdapter,
  combineDecisions,
  evaluateSecondaries,
} from "./dedup.js";
import { type PolicyDecision, PolicyRequest } from "./types.js";

const allow: PolicyDecision = {
  effect: "allow",
  reason: "pdp: matched allow",
  auditRequired: true,
};
const deny: PolicyDecision = {
  effect: "deny",
  reason: "pdp: deny-by-default",
  matchedRule: "deny-1",
  auditRequired: true,
};
const secondaryAllow: PolicyDecision = {
  effect: "allow",
  reason: "agt: allow",
  auditRequired: true,
};
const secondaryDeny: PolicyDecision = { effect: "deny", reason: "agt: deny", auditRequired: true };

const req = PolicyRequest.parse({
  requestId: "req-1",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "send",
  resource: "email/x",
});

describe("combineDecisions — PDP is the SOLE deny authority (dedup #1)", () => {
  it("HEADLINE: a secondary ALLOW can NEVER flip a PDP DENY", () => {
    const out = combineDecisions(deny, [secondaryAllow]);
    expect(out.effect).toBe("deny");
    // The secondary's opinion is recorded for audit, but it did not grant anything.
    expect(out.reason).toContain("pdp");
    expect(out.reason.toLowerCase()).toContain("allow"); // secondary allow annotated
    expect(out.auditRequired).toBe(true);
  });

  it("any-deny-wins: PDP allow + a secondary deny => deny (defense-in-depth)", () => {
    expect(combineDecisions(allow, [secondaryDeny]).effect).toBe("deny");
  });

  it("allow only when PDP allows AND every secondary allows", () => {
    expect(combineDecisions(allow, [secondaryAllow]).effect).toBe("allow");
    expect(combineDecisions(allow, []).effect).toBe("allow");
  });

  it("PDP deny + secondary deny => deny", () => {
    expect(combineDecisions(deny, [secondaryDeny]).effect).toBe("deny");
  });

  it("mixed secondaries: any single deny wins", () => {
    expect(combineDecisions(allow, [secondaryAllow, secondaryDeny]).effect).toBe("deny");
  });

  it("fail-closed on a MALFORMED secondary effect (anything not exactly 'allow' => deny)", () => {
    const garbage = {
      effect: "maybe",
      reason: "garbage advisory",
      auditRequired: true,
    } as unknown as PolicyDecision;
    expect(combineDecisions(allow, [garbage]).effect).toBe("deny");
  });
});

describe("evaluateSecondaries — fail-closed (a secondary that throws is treated as DENY)", () => {
  const throwing: SecondaryPolicyAdapter = {
    evaluate() {
      throw new Error("agt adapter blew up");
    },
  };

  it("a throwing secondary yields a synthetic deny (deny-by-default)", () => {
    const decisions = evaluateSecondaries([throwing], req);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.effect).toBe("deny");
  });

  it("a throwing secondary makes the combined decision deny even when PDP allowed", () => {
    const out = combineDecisions(allow, evaluateSecondaries([throwing], req));
    expect(out.effect).toBe("deny");
  });
});

describe("fake secondary adapters (the >=2 impls of the pluggable Policy slot)", () => {
  it("AllowAll returns allow, DenyAll returns deny — both schema-valid PolicyDecisions", () => {
    for (const a of [new AllowAllSecondaryPolicy(), new DenyAllSecondaryPolicy()]) {
      const d = a.evaluate(req);
      expect(["allow", "deny"]).toContain(d.effect);
      expect(d.reason.length).toBeGreaterThan(0);
      expect(d.auditRequired).toBe(true);
    }
    expect(new AllowAllSecondaryPolicy().evaluate(req).effect).toBe("allow");
    expect(new DenyAllSecondaryPolicy().evaluate(req).effect).toBe("deny");
  });
});
