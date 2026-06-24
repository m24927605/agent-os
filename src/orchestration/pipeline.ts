/**
 * Governed intent->effect pipeline — the composition layer that ties the vendor-neutral ports into one
 * ordered, fail-closed flow for a single brain-proposed ToolCall:
 *
 *   screen (credential-blind) -> authorize (PDP sole deny authority) -> cost.reserve (budget hard-cap)
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
export type AuthorizeDecision = { effect: "allow" | "deny"; reason: string };
export type EffectResult = { ok: boolean; detail?: string; tokensUsed?: number };

export interface GovernedToolCallDeps<TC extends GovernedCall, R> {
  /** Credential-blind / structural screen of the brain's proposed call. */
  readonly screen: (toolCall: TC) => ScreenOutcome;
  /** The SOLE authorization decision (PDP + any secondary dedup folded in by the composition root). */
  readonly authorize: (toolCall: TC) => AuthorizeDecision;
  readonly cost: CostGate;
  readonly estimateTokens: (toolCall: TC) => number;
  /** Append-before-effect appender (commitgate). */
  readonly appender: CommitAppender<unknown, R>;
  /** The actual effect — invoked ONLY after every gate passes and the audit receipt is in hand. */
  readonly effect: (toolCall: TC) => Promise<EffectResult>;
}

export type GovernedStage = "screen" | "policy" | "cost" | "commit";

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

  // 2) policy (PDP sole deny authority)
  const decision = deps.authorize(toolCall);
  if (decision.effect === "deny") {
    return { status: "denied", stage: "policy", reason: decision.reason };
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
