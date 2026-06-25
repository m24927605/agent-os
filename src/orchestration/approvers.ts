/**
 * SLICE-CAP4b — approve-seam FACTORIES (vendor-neutral). CAP4a built the fail-closed approval STAGE in
 * `runGovernedToolCall` + the surface-agnostic `approve` seam (`(toolCall) => MaybePromise<ApprovalOutcome>`),
 * but shipped NO approver. This module supplies the PERSONAL posture as a PURE, vendor-neutral factory the
 * composition root (the bin, the Personal surface) wires.
 *
 * `createBudgetApprover(isPreAuthorized)` is the Personal posture: a destructive / approval-requiring call
 * is AUTO-APPROVED iff it is within a PRE-AUTHORIZED budget/allowlist (`isPreAuthorized` returns true),
 * otherwise DENIED with a STATIC, value-free reason. `isPreAuthorized` is CONFIG-INJECTED — an
 * UNCONFIGURED (deny-all) predicate denies EVERY call => fail-closed (an unconfigured Personal shell never
 * auto-approves a destructive effect). This lets the AUTONOMOUS loop proceed inside its budget WITHOUT a
 * blocking interactive gate, while staying deny-by-default outside it.
 *
 * CREDENTIAL-BLIND: the denied reason is STATIC — it does NOT echo the toolCall (the predicate sees the
 * call; the OUTCOME reason carries none of its values, so an untrusted tool name / context never flows
 * into the commit-before-effect AuditEvent via the approval reason).
 *
 * PURE + vendor-neutral: imports ONLY the `ApprovalOutcome` TYPE from the pipeline (same module). No state,
 * no I/O, no vendor name — `no-vendor-in-core` holds for `src/orchestration/`.
 */
import type { ApprovalOutcome } from "./pipeline.js";

/** STATIC, value-free reasons (credential-blind: never interpolate a toolCall value). */
const REASON_APPROVED = "pre-authorized (auto-approve within budget)";
const REASON_DENIED = "not pre-authorized (deny-by-default)";

/**
 * Build the PERSONAL budget approver. `isPreAuthorized` is a config-injected predicate over the proposed
 * tool call: `true` => the call is within the pre-authorized budget/allowlist => `{status:"approved"}`;
 * `false` => `{status:"denied"}` with a STATIC reason. PURE + SYNC: the proposed call is forwarded VERBATIM
 * to the predicate (no mutation). An UNCONFIGURED / deny-all predicate denies every call (fail-closed).
 */
export function createBudgetApprover(
  isPreAuthorized: (toolCall: unknown) => boolean,
): (toolCall: unknown) => ApprovalOutcome {
  return (toolCall: unknown): ApprovalOutcome =>
    isPreAuthorized(toolCall)
      ? { status: "approved", reason: REASON_APPROVED }
      : { status: "denied", reason: REASON_DENIED };
}
