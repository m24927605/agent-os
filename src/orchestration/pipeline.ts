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
import { createAuditEvent } from "../audit/index.js";
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
  /**
   * SLICE-CAP7 — set by the composition root's authorize closure from the tool manifest's
   * `containment`: `true` when the effect PUNCHES the sandbox seal (`network-egress` / `host-fs-write`),
   * absent / `false` for an `in-sandbox` effect. When `=== true` AND the effect EXECUTES, the pipeline
   * appends a DISTINCT post-effect boundary WORM event (a stronger record than the commit-before-effect
   * intent). This is AUDIT-ONLY: it NEVER changes allow/deny (the PDP stays the sole deny authority) and
   * is consulted ONLY on the `executed` path — a denied/aborted call (the effect never ran) appends NO
   * boundary. Absent / `false` => byte-identical to pre-CAP7 (the 14 in-sandbox seed tools).
   */
  readonly external?: boolean;
  /**
   * SLICE-CAP7 — the OPTIONAL redacted GovernanceProjection (R9b-1-redacted; credential-blind) the
   * composition root already builds. When `external === true` and the effect executes, it rides the
   * boundary record AS-IS (opaque to the pipeline — the pipeline never inspects/redacts it; it is
   * already redacted). Present-only: absent => the boundary event carries neutral fields only. The
   * pipeline NEVER records raw args/env/stdin — only this redacted projection + neutral context ids.
   */
  readonly projection?: unknown;
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

/**
 * SLICE-CAP7 — the result of appending the post-effect boundary WORM event for an EXTERNAL effect that
 * EXECUTED. Surfaced (like {@link CostSettlement}) so a boundary-append FAILURE is NEVER silently
 * swallowed. The external effect is IRREVERSIBLE (commit-before-effect -> effect -> boundary), so a
 * failed boundary append does NOT change the executed status — it is an auditable/alertable marker the
 * caller/composition root can react to (re-drive the ledger, alert), not a reason to fake "didn't run".
 * Present ONLY on an `executed` outcome whose decision was `external === true` (absent otherwise =>
 * byte-identical for in-sandbox tools).
 */
export type BoundaryRecord = { status: "recorded" } | { status: "append-failed" };

export type GovernedOutcome<R> =
  | {
      status: "executed";
      reservationId: string;
      receipt: R;
      detail?: string;
      settlement: CostSettlement;
      /** SLICE-CAP7 — present ONLY for an external effect; the boundary-ledger append result. */
      boundary?: BoundaryRecord;
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

  // 6) SLICE-CAP7 — the external-effect BOUNDARY LEDGER. The effect has ALREADY run (executed). IF the
  // PDP decision classified this call as `external` (a seal-PUNCHING containment: network-egress /
  // host-fs-write), append a DISTINCT post-effect boundary WORM event — a stronger record than the
  // commit-before-effect intent ("the irreversible external fact happened", not just "about to run").
  //
  // This is AUDIT-ONLY, NOT a second deny authority: it runs ONLY on the executed path (a denied/aborted
  // call never reached here, so there is NEVER a boundary-without-effect), it NEVER changes the executed
  // status, and the boundary's own `policyDecision` is a forward `allow` record (the PDP stays the sole
  // deny).
  //
  // CREDENTIAL-BLIND (the WORM is IMMUTABLE — get this right): the GovernanceProjection is only
  // BEST-EFFORT redacted — its OWN R9b-1 header (src/policy/governance-projection.ts) warns that a
  // NON-shape credential (e.g. a `?access_token=...` URL query, `--password=hunter2`) SURVIVES
  // `argvRedacted`, so the projection is safe ONLY for the local AGT engine, "NEVER a log / WORM / audit
  // payload" sink. We therefore record NOT the full projection but ONLY a `boundarySummary` of its SAFE
  // DERIVED fields (networkHosts = userinfo-stripped host-only; operationClass; the shape flags) — NEVER
  // `argv0` / `argvRedacted` / `argc` / any raw token. Plus the neutral context ids + tool name. So a
  // URL-query token can never reach the immutable WORM via this event.
  //
  // POST-EFFECT FAIL-SAFE (mirrors the settlement try/catch above): a boundary-append REJECT does NOT
  // un-run the irreversible effect — the status STAYS "executed" and a `boundary:"append-failed"` marker
  // is SURFACED (never swallowed; the caller can alert / re-drive the ledger). It is NEVER faked as
  // "didn't run". An in-sandbox call (external !== true) skips this entirely => byte-identical.
  let boundary: BoundaryRecord | undefined;
  if (decision.external === true) {
    const ids = boundaryContextIds(toolCall.context);
    const summary = boundarySummaryFromProjection(decision.projection);
    try {
      await deps.appender.append({
        ...createAuditEvent({
          ...ids,
          action: "effect.boundary-crossed",
          resource: toolCall.tool,
          result: committed.result.ok ? "success" : "error",
          policyDecision: { effect: "allow", reason: "external effect boundary" },
        }),
        // ONLY the SAFE derived summary (if any) rides — NEVER argv0/argvRedacted/argc/raw tokens.
        ...(summary !== undefined ? { boundarySummary: summary } : {}),
      });
      boundary = { status: "recorded" };
    } catch {
      boundary = { status: "append-failed" };
    }
  }

  return {
    status: "executed",
    reservationId: reservation.reservationId,
    receipt: committed.receipt,
    detail: committed.result.detail,
    settlement,
    ...(boundary !== undefined ? { boundary } : {}),
  };
}

/**
 * SLICE-CAP7 — pull the neutral context ids the boundary AuditEvent needs from the (structural) tool-call
 * context. The composition root's context carries the branded ids as strings (the SAME shape
 * `createAuditEvent` validates). Best-effort structural read (the pipeline stays decoupled from the
 * concrete context type); `createAuditEvent` fail-closes on a missing/invalid id (no partial boundary
 * event). NO raw args/env are read — ONLY these five neutral identity fields.
 */
function boundaryContextIds(context: unknown): {
  actorId: string;
  tenantId: string;
  projectId: string;
  taskId: string;
  requestId: string;
} {
  const c = (context ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    actorId: str(c.actorId),
    tenantId: str(c.tenantId),
    projectId: str(c.projectId),
    taskId: str(c.taskId),
    requestId: str(c.requestId),
  };
}

/**
 * SLICE-CAP7 — the SAFE-fields-only summary of the GovernanceProjection for the IMMUTABLE WORM boundary
 * event. ALLOW-LIST (never deny-list): pick ONLY the fields R9b-1 derives that cannot carry a raw token —
 *
 *   - `networkHosts`   : userinfo-stripped, host-ONLY (no path/query) — the very thing the egress gate
 *                        decides on; safe by construction.
 *   - `operationClass` : a coarse bucket (filesystem/network/shell/process/unknown).
 *   - `usesShellInterpreter`, `truncated` : booleans.
 *   - `destructiveFlags` : an intersection with a KNOWN flag set (no free-form token).
 *   - `version`        : the contract pin.
 *
 * DELIBERATELY DROPPED: `argv0`, `argvRedacted`, `argc` — `argvRedacted` is only SHAPE-redacted, so a
 * non-shape credential (a `?access_token=...` URL query, `--password=hunter2`) survives it (R9b-1's own
 * header). Those MUST NOT reach the WORM. Returns `undefined` for an absent/non-object projection (the
 * boundary event then carries neutral fields only). Reads defensively (the projection is `unknown` to the
 * pipeline) and copies ONLY string entries out of the string-array fields (no nested object passthrough).
 */
function boundarySummaryFromProjection(projection: unknown): Record<string, unknown> | undefined {
  if (projection === null || typeof projection !== "object") return undefined;
  const p = projection as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const summary: Record<string, unknown> = {
    networkHosts: strings(p.networkHosts),
    destructiveFlags: strings(p.destructiveFlags),
    // SLICE-CAP9 — writeTargets are SAFE path metadata (the very thing the host-write gate decides on:
    // lexically canonical write-target paths, NOT a raw arg). Rebuilt via the SAME string-filter the other
    // array fields use; like networkHosts, parallel and safe-by-construction. NO argvRedacted.
    writeTargets: strings(p.writeTargets),
  };
  if (typeof p.version === "number") summary.version = p.version;
  if (typeof p.operationClass === "string") summary.operationClass = p.operationClass;
  if (typeof p.usesShellInterpreter === "boolean")
    summary.usesShellInterpreter = p.usesShellInterpreter;
  if (typeof p.truncated === "boolean") summary.truncated = p.truncated;
  return summary;
}
