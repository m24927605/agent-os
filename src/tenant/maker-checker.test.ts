import { describe, expect, it } from "vitest";
import {
  type CheckerCapability,
  deriveActionIdentity,
  enforceMakerChecker,
} from "./maker-checker.js";

/**
 * A valid AgentContext for the CHECKER. Other ids are non-empty so parseAgentContext
 * (fail-closed) accepts the context; actorId is the checker's identity.
 */
function checkerCtx(actorId: string, tenantId: string): unknown {
  return {
    actorId,
    tenantId,
    projectId: "project-1",
    taskId: "task-1",
    requestId: "request-1",
  };
}

const action = { kind: "suspend-agent", resource: "agent-42" } as const;

/**
 * A capability bound to the action above, made by `maker-1` in `tenant-a`. The capabilityRef is
 * opaque (independent issuer in real life); this slice treats "passed in" as "possessed".
 */
function capFor(overrides: Partial<CheckerCapability> = {}): CheckerCapability {
  return {
    tenantId: "tenant-a",
    actionIdentity: deriveActionIdentity(action),
    makerActorId: "maker-1",
    capabilityRef: "cap-ref-opaque-1",
    ...overrides,
  };
}

describe("deriveActionIdentity — deterministic action identity", () => {
  it("is deterministic: same action => same identity", () => {
    expect(deriveActionIdentity(action)).toBe(deriveActionIdentity({ ...action }));
  });

  it("distinguishes different actions: different kind or resource => different identity", () => {
    const base = deriveActionIdentity(action);
    expect(deriveActionIdentity({ kind: "other-kind", resource: "agent-42" })).not.toBe(base);
    expect(deriveActionIdentity({ kind: "suspend-agent", resource: "agent-99" })).not.toBe(base);
  });
});

describe("enforceMakerChecker — capability-possession maker-checker (fail-closed)", () => {
  it("headline allow: valid cap (same tenant, identity match, maker != checker) + valid ctx => allow", () => {
    const d = enforceMakerChecker(checkerCtx("checker-1", "tenant-a"), action, capFor());
    expect(d.effect).toBe("allow");
    expect(d.auditRequired).toBe(true);
  });

  it("maker == checker: cap.makerActorId === ctx.actorId => deny (maker_is_checker)", () => {
    const d = enforceMakerChecker(
      checkerCtx("maker-1", "tenant-a"),
      action,
      capFor({ makerActorId: "maker-1" }),
    );
    expect(d.effect).toBe("deny");
    expect(d.reason).toContain("maker_is_checker");
    expect(d.auditRequired).toBe(true);
  });

  it("TOCTOU / rederive: cap bound to action X but action Y executed => deny (action_identity_mismatch)", () => {
    // cap is bound to `action`; the action actually presented is a DIFFERENT one.
    const swapped = { kind: "delete-agent", resource: "agent-42" };
    const d = enforceMakerChecker(checkerCtx("checker-1", "tenant-a"), swapped, capFor());
    expect(d.effect).toBe("deny");
    expect(d.reason).toContain("action_identity_mismatch");
  });

  it("cross-tenant: cap.tenantId !== ctx.tenantId => deny (cross-tenant deny-by-default)", () => {
    // Checker in tenant-b presents a tenant-a capability.
    const d = enforceMakerChecker(
      checkerCtx("checker-1", "tenant-b"),
      action,
      capFor({ tenantId: "tenant-a" }),
    );
    expect(d.effect).toBe("deny");
  });

  it("fail-closed: malformed ctx (missing fields) => deny (never allow)", () => {
    const d = enforceMakerChecker({ tenantId: "tenant-a" }, action, capFor());
    expect(d.effect).toBe("deny");
  });

  it("fail-closed: non-object ctx => deny", () => {
    for (const bad of [null, undefined, "checker-1", 42, []]) {
      const d = enforceMakerChecker(bad, action, capFor());
      expect(d.effect).toBe("deny");
    }
  });

  it("fail-closed: malformed cap (missing field) => deny (never allow)", () => {
    const d = enforceMakerChecker(checkerCtx("checker-1", "tenant-a"), action, {
      tenantId: "tenant-a",
      actionIdentity: deriveActionIdentity(action),
      makerActorId: "maker-1",
      // capabilityRef missing
    });
    expect(d.effect).toBe("deny");
  });

  it("fail-closed: malformed cap (empty-string field) => deny", () => {
    const d = enforceMakerChecker(
      checkerCtx("checker-1", "tenant-a"),
      action,
      capFor({ capabilityRef: "" }),
    );
    expect(d.effect).toBe("deny");
  });

  it("fail-closed: non-object cap => deny", () => {
    for (const bad of [null, undefined, "cap", 42, []]) {
      const d = enforceMakerChecker(checkerCtx("checker-1", "tenant-a"), action, bad);
      expect(d.effect).toBe("deny");
    }
  });

  it("reason does not leak: secret-looking capabilityRef / actorId never appears in any reason", () => {
    // Distinctive sensitive-looking values (deliberately NOT real credential patterns, so they do
    // not trip secret-scan). Invariant: such values are never echoed into a decision reason.
    const secretRef = "capref-CONFIDENTIAL-do-not-leak-98765";
    const secretActor = "actor-CONFIDENTIAL-do-not-leak-54321";
    // Force every deny branch and assert neither secret leaks.
    const decisions = [
      // maker == checker
      enforceMakerChecker(
        checkerCtx(secretActor, "tenant-a"),
        action,
        capFor({ makerActorId: secretActor, capabilityRef: secretRef }),
      ),
      // action identity mismatch
      enforceMakerChecker(
        checkerCtx("checker-1", "tenant-a"),
        { kind: "delete-agent", resource: "agent-42" },
        capFor({ capabilityRef: secretRef }),
      ),
      // cross-tenant
      enforceMakerChecker(
        checkerCtx("checker-1", "tenant-b"),
        action,
        capFor({ tenantId: "tenant-a", capabilityRef: secretRef }),
      ),
    ];
    for (const d of decisions) {
      expect(d.effect).toBe("deny");
      expect(d.reason).not.toContain(secretRef);
      expect(d.reason).not.toContain(secretActor);
    }
  });
});
