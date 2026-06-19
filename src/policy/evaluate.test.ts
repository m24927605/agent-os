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
