/**
 * SLICE-CAP4b — `createBudgetApprover` (the vendor-neutral PERSONAL approve posture).
 *
 * CAP4a built the fail-closed approval STAGE + the surface-agnostic `approve` seam; it had NO approver.
 * CAP4b adds `createBudgetApprover(isPreAuthorized)` — the Personal posture: a destructive/approval-
 * requiring call is AUTO-APPROVED iff it is within a PRE-AUTHORIZED budget/allowlist (`isPreAuthorized`
 * returns true), else DENIED with a STATIC reason. `isPreAuthorized` is config-injected; an UNCONFIGURED
 * (deny-all) predicate => EVERY call denied => fail-closed (an unconfigured Personal shell never auto-
 * approves a destructive effect). This lets the AUTONOMOUS loop proceed inside a budget WITHOUT a
 * blocking interactive gate, while staying deny-by-default outside it.
 *
 * What this file pins (RED-first; the factory does not exist yet):
 *  - isPreAuthorized -> true  => `{status:"approved"}`;
 *  - isPreAuthorized -> false => `{status:"denied"}` with a STATIC, value-free reason;
 *  - a DENY-ALL predicate (the unconfigured Personal default) => EVERY call denied (fail-closed);
 *  - PURE: the approver forwards the EXACT toolCall to the predicate (no mutation) and is sync;
 *  - the denied reason is STATIC — it does NOT echo the toolCall (credential-blind, no untrusted text).
 *
 * NON-VACUITY: an implementation that ignores `isPreAuthorized` and always approves flips the deny tests
 * RED (a false predicate would still yield "approved").
 */
import { describe, expect, it } from "vitest";
import { createBudgetApprover } from "./approvers.js";

const call = { tool: "git.push", context: { tenantId: "t" } };

describe("CAP4b createBudgetApprover — the Personal pre-authorized-budget posture", () => {
  it("isPreAuthorized -> true => approved", () => {
    const approve = createBudgetApprover(() => true);
    expect(approve(call)).toEqual({ status: "approved", reason: expect.any(String) });
  });

  it("isPreAuthorized -> false => denied (deny-by-default)", () => {
    const approve = createBudgetApprover(() => false);
    const out = approve(call);
    expect(out.status).toBe("denied");
    expect(out.reason.length).toBeGreaterThan(0);
  });

  it("DENY-ALL predicate (the UNCONFIGURED Personal default) => EVERY call denied (fail-closed)", () => {
    // An unconfigured Personal shell injects a deny-all predicate — no destructive effect auto-approves.
    const denyAll = createBudgetApprover(() => false);
    for (const tc of [call, { tool: "x", context: {} }, { tool: "", context: null }]) {
      expect(denyAll(tc).status).toBe("denied");
    }
  });

  it("PURE: forwards the EXACT toolCall to the predicate unchanged (no mutation)", () => {
    let seen: unknown;
    const approve = createBudgetApprover((tc) => {
      seen = tc;
      return true;
    });
    approve(call);
    expect(seen).toBe(call);
  });

  it("the denied reason is STATIC — it does NOT echo the toolCall (credential-blind)", () => {
    const secretTool = "git.push-sk-CANARY-must-not-leak";
    const approve = createBudgetApprover(() => false);
    const out = approve({ tool: secretTool, context: { token: "sk-CANARY" } });
    expect(out.status).toBe("denied");
    expect(out.reason).not.toContain("CANARY");
    expect(out.reason).not.toContain(secretTool);
  });
});
