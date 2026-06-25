/**
 * Governed intent->effect pipeline — the composition layer that ties the vendor-neutral ports into one
 * ordered, fail-closed flow for a single brain-proposed ToolCall:
 *
 *   screen (credential-blind) -> authorize (PDP sole deny authority) -> approval (fail-closed, only when
 *   the PDP allow carries requiresApproval) -> cost.reserve (budget hard-cap)
 *   -> commit-before-effect (append AuditEvent, await receipt) -> effect -> cost.commit
 *
 * Each gate SHORT-CIRCUITS to a denied outcome; the effect runs ONLY after every gate passes AND the
 * audit receipt is in hand (so no un-recorded effect, no over-budget spend, no secret egress).
 *
 * Low coupling by DEPENDENCY INJECTION (same pattern as commitgate / the brain credential guard): this
 * module imports only barrel'd port TYPES (ToolCall, CostGate, CommitAppender + commitBeforeEffect);
 * the policy decision, the credential screen, and the effect are injected by the composition root, so
 * orchestration never reaches into another module's internals and names no vendor.
 */
import { type CommitAppender, commitBeforeEffect } from "../commitgate/index.js";
import type { CostGate } from "../cost/index.js";
import type { MaybePromise } from "../policy/index.js";

/**
 * Re-export the policy-barrel `MaybePromise<T>` on the orchestration surface so a consumer that already
 * imports the orchestration ports (e.g. the exec MCP server's `ExecMcpServerDeps`) can type its async-
 * capable `authorize` seam WITHOUT a new cross-zone import. The canonical definition lives in the policy
 * barrel (SLICE-R9a).
 */
export type { MaybePromise } from "../policy/index.js";

/**
 * The minimal shape the pipeline needs from a brain-proposed tool call. Kept structural (NOT an import
 * of the brain module's concrete `ToolCall`) so orchestration stays decoupled from any specific brain
 * port — the composition root passes its real ToolCall, which structurally satisfies this.
 */
export interface GovernedCall {
  readonly tool: string;
  readonly context: unknown;
}

export type ScreenOutcome = { ok: true } | { ok: false; reason: string };
/**
 * The PDP decision. `requiresApproval?` (SLICE-CAP4a) is an OPTIONAL, additive flag the composition
 * root's authorize closure will set from the tool manifest (`requiresApproval`) in CAP4b — the manifest
 * schema FORCES `sideEffect:"destructive" => requiresApproval:true`. When `=== true`, the pipeline
 * enforces a fail-CLOSED APPROVAL stage (a SECOND, pre-effect authorization) AFTER this allow and BEFORE
 * cost.reserve. Absent / `false` => the stage is SKIPPED (byte-identical to pre-CAP4a; the 14 existing
 * tools are all `requiresApproval:false`). This flag is PDP-SUBORDINATE: it can only ADD a gate on an
 * allow — it can never appear on (or relax) a `deny`, which short-circuits at the policy stage first.
 */
export type AuthorizeDecision = {
  effect: "allow" | "deny";
  reason: string;
  readonly requiresApproval?: boolean;
};
export type EffectResult = { ok: boolean; detail?: string; tokensUsed?: number };

/**
 * The outcome of the injected approval seam (SLICE-CAP4a). `"approved"` is the ONLY value that lets the
 * pipeline proceed to cost/commit/effect; anything else (including a throw/reject) is fail-closed to
 * `denied@approval`. The composition root wires the real policy in CAP4b (Personal pre-authorized-budget
 * auto-approve; Enterprise non-interactive maker-checker) — CAP4a only defines the surface-agnostic seam.
 */
export type ApprovalOutcome = { status: "approved" | "denied"; reason: string };

export interface GovernedToolCallDeps<TC extends GovernedCall, R> {
  /** Credential-blind / structural screen of the brain's proposed call. */
  readonly screen: (toolCall: TC) => ScreenOutcome;
  /**
   * The SOLE authorization decision (PDP + any secondary dedup folded in by the composition root).
   * `MaybePromise` (SLICE-R9a): the seam accepts a sync closure OR an async one (e.g. a composition root
   * that awaits a cross-language advisory). The pipeline `await`s it; a sync value resolves to itself, so
   * the absent/sync path is behaviorally byte-identical. A THROW or a promise REJECTION is fail-closed.
   */
  readonly authorize: (toolCall: TC) => MaybePromise<AuthorizeDecision>;
  /**
   * OPTIONAL pre-effect approval seam (SLICE-CAP4a). Consulted ONLY when the PDP allow carries
   * `requiresApproval === true` (otherwise NEVER called — the stage is skipped, byte-identical). Like
   * `authorize` it is `MaybePromise` (a sync auto-approve OR an async maker-checker). FAIL-CLOSED: if a
   * decision REQUIRES approval but this seam is ABSENT, the call is denied (a tool that declared it needs
   * approval must NEVER run unapproved); a non-`"approved"` outcome OR a throw/reject is denied too.
   */
  readonly approve?: (toolCall: TC) => MaybePromise<ApprovalOutcome>;
  readonly cost: CostGate;
  readonly estimateTokens: (toolCall: TC) => number;
  /** Append-before-effect appender (commitgate). */
  readonly appender: CommitAppender<unknown, R>;
  /** The actual effect — invoked ONLY after every gate passes and the audit receipt is in hand. */
  readonly effect: (toolCall: TC) => Promise<EffectResult>;
}

export type GovernedStage = "screen" | "policy" | "approval" | "cost" | "commit";

/**
 * The outcome of settling the REAL cost AFTER the effect ran (`cost.commit`). Surfaced on every
 * executed outcome so a post-effect deny or a recorded budget overrun is NEVER silently swallowed.
 * The effect is irreversible (commit-before-effect -> effect -> settle), so settlement does NOT change
 * the executed status; it is an auditable, alertable signal for the caller / composition root. A
 * recorded `overrun` exhausts the budget so every SUBSEQUENT reserve is denied (the hard-cap is
 * proactive on reserve; an in-flight overshoot is recorded, not erased — cf. the cost-port invariant).
 */
export type CostSettlement =
  | { status: "committed"; overrun: boolean }
  | { status: "denied"; reason: string };

export type GovernedOutcome<R> =
  | {
      status: "executed";
      reservationId: string;
      receipt: R;
      detail?: string;
      settlement: CostSettlement;
    }
  | { status: "denied"; stage: GovernedStage; reason: string };

/** Run one brain-proposed tool call through the governed pipeline. Fail-closed at every gate. */
export async function runGovernedToolCall<TC extends GovernedCall, R>(
  deps: GovernedToolCallDeps<TC, R>,
  toolCall: TC,
): Promise<GovernedOutcome<R>> {
  // 1) credential-blind screen
  const screened = deps.screen(toolCall);
  if (!screened.ok) {
    return { status: "denied", stage: "screen", reason: screened.reason };
  }

  // 2) policy (PDP sole deny authority). `authorize` is `MaybePromise` (SLICE-R9a): `await` works for a
  // sync value (resolves to itself) AND an async advisory. FAIL-CLOSED: a THROW or a promise REJECTION
  // from authorize is mapped to a STATIC `denied@policy` reason — the error message NEVER leaks (no
  // secret/internal egress), the rejection NEVER escapes, and (like an ordinary deny) the cost reserve,
  // commit-before-effect append, and the effect do NOT run.
  let decision: AuthorizeDecision;
  try {
    decision = await deps.authorize(toolCall);
  } catch {
    decision = { effect: "deny", reason: "authorize failed closed (deny-by-default)" };
  }
  if (decision.effect === "deny") {
    return { status: "denied", stage: "policy", reason: decision.reason };
  }

  // 2b) approval (SLICE-CAP4a) — a SECOND, pre-effect authorization that runs ONLY when the PDP allow
  // carries `requiresApproval === true`. It is PDP-SUBORDINATE: it cannot relax a deny (that already
  // short-circuited at policy above), it can only ADD a gate on an allow. FAIL-CLOSED at every branch:
  //   - requiresApproval !== true              -> SKIP (byte-identical: the 14 existing tools, all false);
  //   - requiresApproval === true, no `approve` -> denied@approval (a tool that DECLARED it needs approval
  //                                                must NEVER run unapproved — close the manifest fail-open);
  //   - approve resolves non-"approved"         -> denied@approval (STATIC reason; the outcome reason is
  //                                                NOT forwarded raw — it may carry untrusted text);
  //   - approve THROWS / REJECTS                -> denied@approval (STATIC reason; error message NEVER
  //                                                leaks — mirrors the R9a authorize reject->deny pattern).
  // Cost.reserve, the commit-before-effect append, and the effect do NOT run unless approval passes.
  if (decision.requiresApproval === true) {
    if (deps.approve === undefined) {
      return {
        status: "denied",
        stage: "approval",
        reason: "approval required but no approver wired (deny-by-default)",
      };
    }
    try {
      const approval = await deps.approve(toolCall);
      if (approval.status !== "approved") {
        return { status: "denied", stage: "approval", reason: "approval denied (deny-by-default)" };
      }
    } catch {
      return {
        status: "denied",
        stage: "approval",
        reason: "approval failed closed (deny-by-default)",
      };
    }
  }

  // 3) cost reserve (budget hard-cap) — before the audit/effect
  const reservation = await deps.cost.reserve(toolCall.context, {
    estimatedTokens: deps.estimateTokens(toolCall),
    resource: toolCall.tool,
  });
  if (reservation.status === "denied") {
    return { status: "denied", stage: "cost", reason: reservation.reason };
  }

  // 4) commit-before-effect: append the AuditEvent, await the receipt, and ONLY THEN run the effect.
  const event = {
    kind: "tool-invocation",
    tool: toolCall.tool,
    context: toolCall.context,
    decisionReason: decision.reason,
  };
  const committed = await commitBeforeEffect({
    appender: deps.appender,
    event,
    effect: () => deps.effect(toolCall),
  });
  if (committed.status === "aborted") {
    // The audit was not durably recorded, so the effect never ran and no spend occurred. Release the
    // held reservation (NOT commit) so reserve-then-abort cannot chronically erode the hard-cap.
    await deps.cost.release(toolCall.context, reservation.reservationId);
    return { status: "denied", stage: "commit", reason: committed.reason };
  }

  // 5) effect ran -> settle the real cost. The effect is IRREVERSIBLE, so the status STAYS "executed"
  // regardless of how settlement lands; but the settlement result is SURFACED (never swallowed) so a
  // post-effect deny or a recorded budget overrun can be audited/alerted on. A commit that THROWS is
  // mapped to a static `denied` reason (no error-message/secret leak) — it must NOT propagate (that
  // would lose the receipt of an effect that already ran) and must NOT be silently dropped.
  let settlement: CostSettlement;
  try {
    const settled = await deps.cost.commit(toolCall.context, reservation.reservationId, {
      actualTokens: committed.result.tokensUsed ?? deps.estimateTokens(toolCall),
    });
    settlement =
      settled.status === "committed"
        ? { status: "committed", overrun: settled.overrun }
        : { status: "denied", reason: settled.reason };
  } catch {
    settlement = {
      status: "denied",
      reason: "cost settlement failed (post-effect; effect already ran)",
    };
  }
  return {
    status: "executed",
    reservationId: reservation.reservationId,
    receipt: committed.receipt,
    detail: committed.result.detail,
    settlement,
  };
}
