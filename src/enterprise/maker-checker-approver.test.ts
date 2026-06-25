/**
 * SLICE-CAP4b — `createMakerCheckerApprover` (the ENTERPRISE non-interactive approve posture).
 *
 * The Enterprise vertical does NOT auto-approve on a budget; a sensitive/destructive action requires a
 * CHECKER who POSSESSES a non-self-issuable `CheckerCapability` (maker != checker, bound to tenant +
 * action identity). CAP4b wraps the EXISTING `enforceMakerChecker` (5 deny-by-default checks) into the
 * CAP4a `approve` seam: allow => `{status:"approved"}`, deny => `{status:"denied"}`.
 *
 * CREDENTIAL-BLIND (CAP4a reviewer MINOR): the wrapped decision's `reason` is NOT forwarded raw into the
 * approve outcome — `enforceMakerChecker` returns only STATIC error codes today, but the seam must NOT
 * become a forwarding channel for any future/adversarial reason text. The approve outcome carries a
 * STATIC reason of the approver's OWN.
 *
 * What this file pins (RED-first; the factory does not exist yet):
 *  - enforceMakerChecker ALLOW (well-formed checker cap, maker != checker, identity matches) => approved;
 *  - enforceMakerChecker DENY (maker IS checker / cross-tenant / malformed cap / identity mismatch) => denied;
 *  - the approve outcome's reason is STATIC — it does NOT forward the maker-checker decision's reason.
 *
 * NON-VACUITY: an implementation that ignores the wrapped decision and always approves flips the deny
 * tests RED (a maker-checker deny would still yield "approved").
 */
import { describe, expect, it } from "vitest";
import { type CheckerCapability, deriveActionIdentity } from "../tenant/index.js";
import { createMakerCheckerApprover } from "./maker-checker-approver.js";

const tenantId = "tenant-ent";
const action = { kind: "tool:invoke", resource: "git.push" };

const checkerCtx = {
  actorId: "actor:checker",
  tenantId,
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

/** A well-formed checker capability bound to (tenant, this action's identity, a DIFFERENT maker). */
const validCap: CheckerCapability = {
  tenantId,
  actionIdentity: deriveActionIdentity(action),
  makerActorId: "actor:maker", // != checkerCtx.actorId => maker != checker
  capabilityRef: "cap-ref-opaque",
};

/**
 * The approver is built over a thunk supplying (ctx, action, cap) for the call under approval. CAP4b
 * keeps the bin/Personal path the focus; the Enterprise approver is a factory the surface can wire. We
 * exercise it directly: build it with a fixed (ctx, action, cap) resolver and approve a tool call.
 */
describe("CAP4b createMakerCheckerApprover — the Enterprise non-interactive maker-checker posture", () => {
  it("enforceMakerChecker ALLOW (maker != checker, valid cap, identity matches) => approved", () => {
    const approve = createMakerCheckerApprover(() => ({ ctx: checkerCtx, action, cap: validCap }));
    expect(approve({ tool: "git.push", context: checkerCtx })).toEqual({
      status: "approved",
      reason: expect.any(String),
    });
  });

  it("enforceMakerChecker DENY (maker IS checker) => denied", () => {
    // maker == checker: the capability's makerActorId equals the checker ctx actorId => maker_is_checker.
    const selfCap: CheckerCapability = { ...validCap, makerActorId: checkerCtx.actorId };
    const approve = createMakerCheckerApprover(() => ({ ctx: checkerCtx, action, cap: selfCap }));
    expect(approve({ tool: "git.push", context: checkerCtx }).status).toBe("denied");
  });

  it("enforceMakerChecker DENY (malformed cap) => denied (fail-closed)", () => {
    const approve = createMakerCheckerApprover(() => ({
      ctx: checkerCtx,
      action,
      cap: { not: "a-capability" },
    }));
    expect(approve({ tool: "git.push", context: checkerCtx }).status).toBe("denied");
  });

  it("enforceMakerChecker DENY (cross-tenant cap) => denied", () => {
    const crossTenantCap: CheckerCapability = { ...validCap, tenantId: "tenant-OTHER" };
    const approve = createMakerCheckerApprover(() => ({
      ctx: checkerCtx,
      action,
      cap: crossTenantCap,
    }));
    expect(approve({ tool: "git.push", context: checkerCtx }).status).toBe("denied");
  });

  it("the approve outcome reason is STATIC — it does NOT forward the maker-checker decision reason", () => {
    // Force a deny whose enforceMakerChecker reason is a known error code; assert it is NOT forwarded.
    const selfCap: CheckerCapability = { ...validCap, makerActorId: checkerCtx.actorId };
    const approve = createMakerCheckerApprover(() => ({ ctx: checkerCtx, action, cap: selfCap }));
    const out = approve({ tool: "git.push", context: checkerCtx });
    expect(out.status).toBe("denied");
    // enforceMakerChecker would return "maker_is_checker"; the approver must NOT forward it.
    expect(out.reason).not.toContain("maker_is_checker");
  });
});
