import { describe, expect, it } from "vitest";
import {
  type AllowRule,
  type PolicyDecision,
  type PolicyRuleSet,
  combineDecisions,
} from "../policy/index.js";
import { authorizeToolInvoke } from "./authorize.js";
import { ToolRegistry } from "./registry.js";

const fsReadManifest = {
  name: "fs.read",
  version: "1.0.0",
  description: "Read a file",
  action: "tool:invoke",
  resourcePattern: "fs://**",
  sideEffect: "read",
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
} as const;

/** A registry that knows exactly one tool: `fs.read`. */
function seededRegistry(): ToolRegistry {
  return new ToolRegistry([{ ...fsReadManifest }]);
}

const invokeReq = {
  requestId: "req-1",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "tool:invoke",
  resource: "fs.read",
};

const allowFsRead: AllowRule = {
  id: "allow-fs-read",
  action: "tool:invoke",
  resource: "fs.read",
};

describe("authorizeToolInvoke — deny-only registry pre-screen", () => {
  it("unregistered tool on tool:invoke => deny (deny-by-default), reason names unregistered, auditRequired", () => {
    const decision = authorizeToolInvoke(
      { ...invokeReq, resource: "unknown-tool" },
      seededRegistry(),
      [allowFsRead],
    );
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("unregistered");
    expect(decision.auditRequired).toBe(true);
  });

  it("registered tool + matching allow rule => allow (delegates to evaluatePolicy)", () => {
    const decision = authorizeToolInvoke(invokeReq, seededRegistry(), [allowFsRead]);
    expect(decision.effect).toBe("allow");
  });

  it("registered tool + matching deny rule => deny (deny-precedence still enforced via PDP)", () => {
    const rules: PolicyRuleSet = {
      allow: [allowFsRead],
      deny: [{ id: "deny-fs-read", action: "tool:invoke", resource: "fs.read" }],
    };
    const decision = authorizeToolInvoke(invokeReq, seededRegistry(), rules);
    expect(decision.effect).toBe("deny");
  });

  it("fail-closed: malformed request (missing fields / wrong type / null) => deny, no crash, no allow", () => {
    for (const bad of [null, {}, { ...invokeReq, action: 123 }, { ...invokeReq, resource: "" }]) {
      const decision = authorizeToolInvoke(bad, seededRegistry(), [allowFsRead]);
      expect(decision.effect).toBe("deny");
      expect(decision.auditRequired).toBe(true);
    }
  });

  it("deny-only invariant: unregistered stays deny even with an allow rule that would match it", () => {
    const allowUnknown: AllowRule = {
      id: "allow-unknown",
      action: "tool:invoke",
      resource: "unknown-tool",
    };
    const decision = authorizeToolInvoke(
      { ...invokeReq, resource: "unknown-tool" },
      seededRegistry(),
      [allowUnknown],
    );
    expect(decision.effect).toBe("deny");
  });

  it("non tool:invoke action delegates fully to evaluatePolicy (registry does not affect it)", () => {
    const fileReadReq = {
      ...invokeReq,
      action: "file:read",
      resource: "/workspace/readme.md",
    };
    const allowFileRead: AllowRule = {
      id: "allow-file-read",
      action: "file:read",
      resource: "/workspace/**",
    };
    const decision = authorizeToolInvoke(fileReadReq, seededRegistry(), [allowFileRead]);
    expect(decision.effect).toBe("allow");
  });

  it("compatible with dedup #1: unregistered deny + secondary allow combines to deny", () => {
    const primary = authorizeToolInvoke(
      { ...invokeReq, resource: "unknown-tool" },
      seededRegistry(),
      [],
    );
    const secondaryAllow: PolicyDecision = {
      effect: "allow",
      reason: "advisory allow",
      auditRequired: true,
    };
    const combined = combineDecisions(primary, [secondaryAllow]);
    expect(combined.effect).toBe("deny");
  });
});
