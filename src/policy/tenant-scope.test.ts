import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "./evaluate.js";
import type { PolicyRuleSet } from "./types.js";

function req(tenantId: string, action = "send", resource = "email/x") {
  return {
    requestId: "req-1",
    tenantId,
    projectId: "proj-1",
    taskId: "task-1",
    actorId: "agent:claude",
    action,
    resource,
  };
}

describe("tenant-scoped PDP rules — cross-tenant deny-by-default (Enterprise spine, brick 1)", () => {
  it("HEADLINE: a tenant-A allow rule does NOT grant a tenant-B request (cross-tenant deny)", () => {
    const rules: PolicyRuleSet = {
      allow: [{ id: "a1", action: "send", resource: "email/x", tenantId: "tenant-a" }],
      deny: [],
    };
    const out = evaluatePolicy(req("tenant-b"), rules);
    expect(out.effect).toBe("deny");
    expect(out.reason).toContain("cross-tenant");
  });

  it("the same tenant-A allow rule DOES grant a tenant-A request", () => {
    const rules: PolicyRuleSet = {
      allow: [{ id: "a1", action: "send", resource: "email/x", tenantId: "tenant-a" }],
      deny: [],
    };
    expect(evaluatePolicy(req("tenant-a"), rules).effect).toBe("allow");
  });

  it("backward-compatible: an allow rule WITHOUT tenantId applies to any tenant", () => {
    const rules: PolicyRuleSet = {
      allow: [{ id: "a-global", action: "send", resource: "email/x" }],
      deny: [],
    };
    expect(evaluatePolicy(req("tenant-a"), rules).effect).toBe("allow");
    expect(evaluatePolicy(req("tenant-b"), rules).effect).toBe("allow");
  });

  it("a deny rule scoped to tenant-A does NOT block tenant-B (tenant-B keeps its own allow)", () => {
    const rules: PolicyRuleSet = {
      allow: [{ id: "a-global", action: "send", resource: "email/x" }],
      deny: [{ id: "d1", action: "send", resource: "email/x", tenantId: "tenant-a" }],
    };
    expect(evaluatePolicy(req("tenant-a"), rules).effect).toBe("deny"); // own tenant blocked
    expect(evaluatePolicy(req("tenant-b"), rules).effect).toBe("allow"); // other tenant unaffected
  });

  it("a deny rule WITHOUT tenantId blocks ALL tenants (fail-safe global deny)", () => {
    const rules: PolicyRuleSet = {
      allow: [{ id: "a-global", action: "send", resource: "email/x" }],
      deny: [{ id: "d-global", action: "send", resource: "email/x" }],
    };
    expect(evaluatePolicy(req("tenant-a"), rules).effect).toBe("deny");
    expect(evaluatePolicy(req("tenant-b"), rules).effect).toBe("deny");
  });

  it("fail-closed: a deny rule with a malformed tenantId (empty string) => deny", () => {
    const rules = {
      allow: [{ id: "a-global", action: "send", resource: "email/x" }],
      deny: [{ id: "d-bad", action: "send", resource: "email/x", tenantId: "" }],
    } as unknown as PolicyRuleSet;
    const out = evaluatePolicy(req("tenant-a"), rules);
    expect(out.effect).toBe("deny");
    expect(out.reason).toContain("malformed");
  });
});
