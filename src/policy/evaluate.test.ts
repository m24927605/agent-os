import { describe, expect, it } from "vitest";
import { evaluatePolicy, matchResource } from "./evaluate.js";
import type { AllowRule } from "./types.js";

const validRequest = {
  requestId: "req-1",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "fs:read",
  resource: "/workspace/readme.md",
};

const readRule: AllowRule = {
  id: "allow-workspace-read",
  action: "fs:read",
  resource: "/workspace/**",
};

describe("evaluatePolicy — deny-by-default", () => {
  it("denies when no rules are provided", () => {
    const decision = evaluatePolicy(validRequest, []);
    expect(decision.effect).toBe("deny");
    expect(decision.auditRequired).toBe(true);
    expect(decision.reason).toContain("deny-by-default");
  });

  it("denies an unknown action even if the resource matches a rule", () => {
    const decision = evaluatePolicy({ ...validRequest, action: "fs:write" }, [readRule]);
    expect(decision.effect).toBe("deny");
  });

  it("denies an unknown resource even if the action matches a rule", () => {
    const decision = evaluatePolicy({ ...validRequest, resource: "/etc/passwd" }, [readRule]);
    expect(decision.effect).toBe("deny");
  });

  it("allows only on an explicit matching rule, and reports the matched rule", () => {
    const decision = evaluatePolicy(validRequest, [readRule]);
    expect(decision.effect).toBe("allow");
    expect(decision.matchedRule).toBe("allow-workspace-read");
    expect(decision.auditRequired).toBe(true);
  });
});

describe("evaluatePolicy — fail closed", () => {
  it("denies a malformed request (missing required fields) without throwing", () => {
    const decision = evaluatePolicy({ action: "fs:read" }, [readRule]);
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("malformed");
  });

  it("denies (does not throw) when a rule entry is malformed and evaluation errors", () => {
    // A null rule makes the matcher throw; the evaluator must fail closed.
    const decision = evaluatePolicy(validRequest, [null as unknown as AllowRule]);
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("fail-closed");
  });

  it("does not echo request values that could carry secrets in the deny reason", () => {
    const decision = evaluatePolicy(
      { ...validRequest, requestId: "", context: { authorization: "Bearer leaked-value" } },
      [readRule],
    );
    expect(decision.effect).toBe("deny");
    expect(decision.reason).not.toContain("leaked-value");
  });
});

describe("matchResource", () => {
  it("matches exact resources", () => {
    expect(matchResource("/workspace/a.txt", "/workspace/a.txt")).toBe(true);
  });

  it("matches '**' across path segments but '*' only within one", () => {
    expect(matchResource("/workspace/**", "/workspace/a/b.txt")).toBe(true);
    expect(matchResource("/workspace/*", "/workspace/a/b.txt")).toBe(false);
    expect(matchResource("/workspace/*", "/workspace/a.txt")).toBe(true);
  });

  it("rejects wildcard-only patterns as too broad", () => {
    expect(matchResource("*", "/anything")).toBe(false);
    expect(matchResource("**", "/anything")).toBe(false);
  });
});

describe("evaluatePolicy — deny-precedence (PolicyRuleSet form)", () => {
  const denyRule = { id: "deny-secrets", action: "fs:read", resource: "/workspace/secrets/**" };

  it("denies when a request matches both an allow and a deny rule (deny precedence)", () => {
    const req = { ...validRequest, resource: "/workspace/secrets/key.txt" };
    const decision = evaluatePolicy(req, { allow: [readRule], deny: [denyRule] });
    expect(decision.effect).toBe("deny");
    expect(decision.matchedRule).toBe("deny-secrets");
    expect(decision.auditRequired).toBe(true);
  });

  it("allows only when an allow matches and no deny matches", () => {
    const decision = evaluatePolicy(validRequest, { allow: [readRule], deny: [denyRule] });
    expect(decision.effect).toBe("allow");
    expect(decision.matchedRule).toBe("allow-workspace-read");
  });

  it("denies by default on an empty ruleset", () => {
    const decision = evaluatePolicy(validRequest, { allow: [], deny: [] });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("deny-by-default");
  });

  it("fails closed on a malformed deny rule — null (throws) or non-throwing garbage", () => {
    // null deny element (throws in the matcher) -> fail-closed
    expect(
      evaluatePolicy(validRequest, {
        allow: [readRule],
        deny: [null as unknown as typeof denyRule],
      }).effect,
    ).toBe("deny");

    // A non-throwing garbage deny (action is not a string) MUST NOT be silently skipped:
    // a deny meant to protect /workspace/secrets/** must fail closed, never let an allow grant.
    const req = { ...validRequest, resource: "/workspace/secrets/key.txt" };
    const decision = evaluatePolicy(req, {
      allow: [readRule],
      deny: [{ id: "d", action: 0 as unknown as string, resource: "/workspace/secrets/**" }],
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("fail-closed");
  });

  it("wildcard-only deny over-matches (denies more) and overrides any allow", () => {
    const decision = evaluatePolicy(validRequest, {
      allow: [readRule],
      deny: [{ id: "deny-all", action: "fs:read", resource: "**" }],
    });
    expect(decision.effect).toBe("deny");
    expect(decision.matchedRule).toBe("deny-all");
  });

  it("wildcard-only allow still does NOT grant (allow side stays strict)", () => {
    const decision = evaluatePolicy(validRequest, {
      allow: [{ id: "allow-all", action: "fs:read", resource: "**" }],
      deny: [],
    });
    expect(decision.effect).toBe("deny");
    // deny-by-default (no valid allow matched), NOT a fail-closed error path.
    expect(decision.reason).toContain("deny-by-default");
  });
});
