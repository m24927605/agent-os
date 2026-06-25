/**
 * SLICE-CAP4b — the ENTERPRISE approve-seam factory (the non-interactive maker-checker posture).
 *
 * The Enterprise vertical does NOT auto-approve on a budget (that is the Personal posture —
 * `createBudgetApprover`). A sensitive / destructive action requires a CHECKER who POSSESSES a
 * non-self-issuable `CheckerCapability` bound to (tenant, action identity, a DIFFERENT maker). CAP4a built
 * the surface-agnostic `approve` seam; this factory wraps the EXISTING `enforceMakerChecker` (the 5
 * deny-by-default checks — REUSED, not re-implemented) into that seam: allow => `{status:"approved"}`,
 * deny => `{status:"denied"}`.
 *
 * CREDENTIAL-BLIND (CAP4a reviewer MINOR — do NOT forward an untrusted reason): the wrapped decision's
 * `reason` is NOT forwarded into the approve outcome. `enforceMakerChecker` returns only STATIC error
 * codes today, but the approve seam must NOT become a forwarding channel for any future / adversarial
 * reason text that could land (via the approval reason) in the commit-before-effect AuditEvent. The
 * approve outcome carries the approver's OWN static reason.
 *
 * SCOPE (CAP4b honest boundary): CAP4b proves the END-TO-END approval mechanism on the AUTONOMOUS (bin)
 * path with the Personal budget approver; this Enterprise factory is provided READY for the Enterprise
 * surface to wire (a thin extension). The `resolve` seam maps a proposed tool call to the
 * (ctx, action, cap) the maker-checker primitive enforces — the surface supplies it from its request +
 * the checker's possessed capability.
 *
 * Lives in the Enterprise zone (alongside the maker-checker usage in `bootstrap.ts`). Imports the
 * maker-checker primitive via the `tenant` barrel and the `ApprovalOutcome` type via the `orchestration`
 * barrel (both legal cross-module barrel imports). `src/enterprise/` is NOT a `no-vendor-in-core` zone.
 */
import type { ApprovalOutcome } from "../orchestration/index.js";
import { enforceMakerChecker } from "../tenant/index.js";

/** What the surface resolves a proposed tool call into — the maker-checker primitive's exact inputs. */
export interface MakerCheckerInputs {
  /** The CHECKER's AgentContext (parsed fail-closed inside enforceMakerChecker). */
  readonly ctx: unknown;
  /** The action about to run (its identity is re-derived + matched against the capability — TOCTOU). */
  readonly action: { readonly kind: string; readonly resource: string };
  /** The checker's POSSESSED CheckerCapability (untrusted; malformed => deny). */
  readonly cap: unknown;
}

/** STATIC, value-free reasons (credential-blind: never forward enforceMakerChecker's raw reason). */
const REASON_APPROVED = "maker-checker satisfied (checker capability verified)";
const REASON_DENIED = "maker-checker denied (deny-by-default)";

/**
 * Build the ENTERPRISE maker-checker approver. `resolve` maps the proposed tool call to the
 * (ctx, action, cap) `enforceMakerChecker` enforces; the wrapped ALLOW => `{status:"approved"}`, the
 * wrapped DENY => `{status:"denied"}`. The outcome reason is STATIC — the wrapped decision's reason is
 * NEVER forwarded (credential-blind). SYNC (enforceMakerChecker is pure).
 */
export function createMakerCheckerApprover(
  resolve: (toolCall: unknown) => MakerCheckerInputs,
): (toolCall: unknown) => ApprovalOutcome {
  return (toolCall: unknown): ApprovalOutcome => {
    const { ctx, action, cap } = resolve(toolCall);
    const decision = enforceMakerChecker(ctx, action, cap);
    return decision.effect === "allow"
      ? { status: "approved", reason: REASON_APPROVED }
      : { status: "denied", reason: REASON_DENIED };
  };
}
