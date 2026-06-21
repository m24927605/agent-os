/**
 * Capability-possession maker-checker — maker != checker enforced by CAPABILITY POSSESSION, not by
 * an `if (maker === checker)` string compare.
 *
 * A sensitive action requires the checker to POSSESS a `CheckerCapability` bound to
 * (tenantId, actionIdentity, makerActorId). The capability cannot be self-issued by the maker: it
 * is produced by an independent issuing path (out of scope here), so "passed in" == "possessed".
 *
 * Enforcement is a deny-by-default pure function. ANY unmet condition denies (never short-circuits
 * to allow). It re-derives the identity of the action ABOUT TO RUN and fails closed on mismatch —
 * borrowing AGT's TOCTOU defence (approval bound to enforced_identity, rederive before effect,
 * mismatch => runtime_error:approval_action_mismatch; SPECIFICATION.md:388,432), upgraded from a
 * host-callback approval to a non-self-issuable capability. Cross-tenant capabilities do not apply
 * (sits on the PDP cross-tenant deny-by-default semantics).
 *
 * Imports only the identity primitive (`parseAgentContext`, fail-closed). No vendor, no I/O, no
 * deep import of policy internals — the decision shape mirrors PolicyDecision by convention only.
 */
import { z } from "zod";
import { parseAgentContext } from "../iam/ids.js";

/**
 * The checker's capability. Holds NO secret: `capabilityRef` is an OPAQUE reference to an
 * independently-issued capability. Bound to a single (tenantId, actionIdentity, makerActorId), so
 * it grants nothing for another tenant, another action, or a maker who is also the checker.
 */
export interface CheckerCapability {
  readonly tenantId: string;
  readonly actionIdentity: string;
  readonly makerActorId: string;
  readonly capabilityRef: string;
}

/** Every maker-checker decision is auditable. `auditRequired` is always true (no silent path). */
export interface MakerCheckerDecision {
  readonly effect: "allow" | "deny";
  readonly reason: string;
  readonly auditRequired: true;
}

// Fail-closed schema for an untrusted capability: every field is a non-empty (trimmed) string.
const nonEmpty = z.string().trim().min(1);
const CheckerCapabilitySchema = z
  .object({
    tenantId: nonEmpty,
    actionIdentity: nonEmpty,
    makerActorId: nonEmpty,
    capabilityRef: nonEmpty,
  })
  .strict();

// Static deny reasons — only error codes / field names, never a value from `ctx` or `cap`.
const REASON_INVALID_CONTEXT = "invalid_agent_context";
const REASON_INVALID_CAPABILITY = "invalid_capability";
const REASON_CROSS_TENANT = "cross_tenant_capability";
const REASON_MAKER_IS_CHECKER = "maker_is_checker";
const REASON_ACTION_MISMATCH = "action_identity_mismatch";
const REASON_ALLOWED = "maker_checker_satisfied";

function deny(reason: string): MakerCheckerDecision {
  return { effect: "deny", reason, auditRequired: true };
}

/**
 * Deterministically derive the identity of the action about to run. Stable, collision-resistant
 * across (kind, resource) via length-prefixed encoding so distinct fields cannot alias (e.g.
 * `a|b` vs `ab|`). Pure — no time, no randomness.
 */
export function deriveActionIdentity(action: {
  readonly kind: string;
  readonly resource: string;
}): string {
  const { kind, resource } = action;
  return `mc1:${kind.length}:${kind}:${resource.length}:${resource}`;
}

/**
 * Enforce maker-checker on a sensitive action. Deny-by-default — every check must pass:
 *  1. parseAgentContext(ctx) fail-closed (malformed/empty ids => deny).
 *  2. cap is a well-formed CheckerCapability (possession; malformed => deny).
 *  3. cap.tenantId === ctx.tenantId (cross-tenant capability does not apply => deny).
 *  4. cap.makerActorId !== ctx.actorId (same person cannot be both maker and checker => deny).
 *  5. deriveActionIdentity(action) === cap.actionIdentity (rederive; mismatch => fail-closed deny).
 */
export function enforceMakerChecker(
  ctx: unknown,
  action: { kind: string; resource: string },
  cap: unknown,
): MakerCheckerDecision {
  // 1. Checker identity — fail-closed.
  const parsedCtx = parseAgentContext_safe(ctx);
  if (parsedCtx === undefined) {
    return deny(REASON_INVALID_CONTEXT);
  }

  // 2. Capability well-formed (possession) — fail-closed.
  const capResult = CheckerCapabilitySchema.safeParse(cap);
  if (!capResult.success) {
    return deny(REASON_INVALID_CAPABILITY);
  }
  const capability = capResult.data;

  // 3. Cross-tenant capability does not apply (PDP cross-tenant deny-by-default).
  if (capability.tenantId !== parsedCtx.tenantId) {
    return deny(REASON_CROSS_TENANT);
  }

  // 4. Maker != checker — enforced via the capability's bound makerActorId, not a free string.
  if (capability.makerActorId === parsedCtx.actorId) {
    return deny(REASON_MAKER_IS_CHECKER);
  }

  // 5. Rederive the action identity; mismatch => fail-closed (TOCTOU defence).
  if (deriveActionIdentity(action) !== capability.actionIdentity) {
    return deny(REASON_ACTION_MISMATCH);
  }

  return { effect: "allow", reason: REASON_ALLOWED, auditRequired: true };
}

/** parseAgentContext wrapped fail-closed: any throw => undefined (=> deny at the call site). */
function parseAgentContext_safe(ctx: unknown): { actorId: string; tenantId: string } | undefined {
  try {
    const parsed = parseAgentContext(ctx);
    return { actorId: parsed.actorId, tenantId: parsed.tenantId };
  } catch {
    return undefined;
  }
}
