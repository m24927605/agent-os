/**
 * Restore FSM + RestoreEvent forward-append — NEVER truncate the log
 * (SLICE-P2R-R10-S3; design docs/design/time-travel-snapshot-replay.md §44, §49 correction 1,
 * §56 Build-list #4).
 *
 * `restore-to-S` is NOT a log truncation. It is an ORDERED, fail-closed orchestration that emits TWO
 * NEW forward `RestoreEvent`s (`RestoreInitiated`, then `RestoreCompleted`) into the append-only WORM
 * hash-chain and rebuilds the STATE-LAYER projection in between. The original events[0..M] all stay
 * on the chain; forward continues at M+1. There is intentionally no truncate/rewrite surface — the
 * only emit seam is the injected `RestoreAppender`, whose sole capability is `append`.
 *
 * Phases (mirroring the R5 Task FSM style — explicit, deny-by-default):
 *   idle -> validating -> locked -> initiated -> rebuilding -> completed | aborted
 * Every phase is fail-closed: any failed guard / rejected dependency aborts AT that phase and is NOT
 * partially applied. Critically, a failure during `rebuilding` aborts WITHOUT emitting
 * RestoreCompleted — no half-completed illusion is ever left on the chain.
 *
 * Hard invariants (the security spine of this slice):
 *  - FORWARD-ONLY (design §44/§49): the FSM only ever `append`s. There is no truncate/rewrite API.
 *  - attester != actor (design §44): `sourceId` being a brain source -> deny-by-default at
 *    `validating`. The brain can NEVER self-restore; restore is admin/approver-signed.
 *  - fail-closed: an unknown/rejected step aborts; it never silently advances.
 *
 * Low coupling / high cohesion: this module ONLY sequences the phases + emits the two forward events.
 * The GLOBAL cross-ingest lock (R10-S4), the authorize decision (PDP, Build-list #8), the concrete
 * projection rebuild (DB txn / PITR / brain import / sandbox reprovision), and the real ingest
 * transport (R2) are ALL injected through `RestoreDeps`. It consumes only the `SnapshotRecord` type
 * from `./snapshot.js` and the `AppendReceipt` type from the audit barrel (`../audit/index.js`) —
 * never a deep import, never a vendor name.
 */
import type { AppendReceipt } from "../audit/index.js";
import type { ExternalEffect, SnapshotRecord } from "./snapshot.js";

/** Which forward event this RestoreEvent is — the chain shows "initiated" then "completed". */
export type RestorePhaseMarker = "RestoreInitiated" | "RestoreCompleted";

/**
 * A new, forward, authorized restore event appended into the hash-chain (design §44). It is NEVER a
 * truncation — the original events stay on the chain and this continues forward from the head.
 */
export interface RestoreEvent {
  readonly kind: "system.restore";
  /** Which of the two forward markers this is (RestoreInitiated | RestoreCompleted). */
  readonly restorePhase: RestorePhaseMarker;
  /** The admin/approver identity that signed this restore (NOT the brain). */
  readonly actor: string;
  /** The non-brain source that initiated the restore (orchestration), for attester!=actor. */
  readonly sourceId: string;
  /** The snapshot being restored to. */
  readonly targetSnapshotId: string;
  /** The unified WORM-sequence anchor of that snapshot. */
  readonly targetSequence: number;
  /**
   * The DivergenceReport seed — external effects since baseline an operator must see BEFORE
   * approving (design §23). Carried verbatim into RestoreInitiated; never swallowed.
   */
  readonly divergenceReport: readonly ExternalEffect[];
}

/** An allow/deny decision from the injected authorize hook (PDP seam; Build-list #8). */
export interface RestoreAuthorization {
  readonly effect: "allow" | "deny";
  readonly reason: string;
}

/**
 * The NARROW forward-append seam (the R2 ingest client is injected as this; design §44). Its ONLY
 * capability is `append` — there is deliberately NO truncate/rewrite method, so the FSM physically
 * cannot rewrite history.
 */
export interface RestoreAppender {
  append(event: RestoreEvent): Promise<AppendReceipt>;
}

/** Everything mutating/external the FSM needs — ALL injected (composition root owns the concretes). */
export interface RestoreDeps {
  /** Acquire the GLOBAL cross-ingest checkpoint/lock (R10-S4). Rejecting aborts at `locked`. */
  acquireCheckpoint(): Promise<unknown>;
  /** Authorize the actor for this snapshot (PDP, Build-list #8). Deny aborts at `validating`. */
  authorize(actor: string, snapshot: SnapshotRecord): RestoreAuthorization;
  /** The narrow forward-append seam (R2 ingest client). */
  readonly appender: RestoreAppender;
  /** Rebuild the state-layer projection (DB txn / PITR / brain import / sandbox reprovision). */
  rebuildProjection(snapshot: SnapshotRecord): Promise<void>;
}

/** The ordered phases — exposed so callers/tests reason over the exact failure point. */
export type RestorePhase =
  | "idle"
  | "validating"
  | "locked"
  | "initiated"
  | "rebuilding"
  | "completed"
  | "aborted";

/** The terminal outcome: where it ended and (on abort) why. */
export interface RestoreOutcome {
  readonly status: "completed" | "aborted";
  /** The phase at which it terminated (`completed`, or the phase that failed closed). */
  readonly phase: RestorePhase;
  readonly reason?: string;
}

/** Brain source identifiers that can NEVER self-restore (attester != actor, design §44). */
const BRAIN_SOURCE_IDS: ReadonlySet<string> = new Set(["brain", "hermes"]);

function isBrainSource(sourceId: string): boolean {
  return BRAIN_SOURCE_IDS.has(sourceId.trim().toLowerCase());
}

function aborted(phase: RestorePhase, reason: string): RestoreOutcome {
  return { status: "aborted", phase, reason };
}

function errMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Run the restore FSM. Returns a terminal `RestoreOutcome`; it NEVER throws and NEVER partially
 * applies — every phase is fail-closed. On success the chain shows exactly two new forward events:
 * RestoreInitiated (before the projection rebuild) and RestoreCompleted (after it).
 */
export async function runRestore(
  deps: RestoreDeps,
  snapshot: SnapshotRecord,
  actor: string,
  sourceId: string,
): Promise<RestoreOutcome> {
  // Phase: validating — attester!=actor deny-by-default, then authorize. NO append yet.
  if (isBrainSource(sourceId)) {
    return aborted(
      "validating",
      `attester != actor: source "${sourceId}" may not self-restore (brain cannot initiate restore)`,
    );
  }
  let decision: RestoreAuthorization;
  try {
    decision = deps.authorize(actor, snapshot);
  } catch (cause) {
    // An authorize hook that throws is unknown -> deny-by-default (fail closed).
    return aborted("validating", `authorize failed closed: ${errMessage(cause)}`);
  }
  if (decision.effect !== "allow") {
    return aborted("validating", `restore denied: ${decision.reason}`);
  }

  // Phase: locked — acquire the GLOBAL cross-ingest checkpoint. Reject aborts here, pre-append.
  try {
    await deps.acquireCheckpoint();
  } catch (cause) {
    return aborted("locked", `acquireCheckpoint failed closed: ${errMessage(cause)}`);
  }

  // Phase: initiated — emit the FIRST forward event (RestoreInitiated), carrying the DivergenceReport.
  try {
    await deps.appender.append({
      kind: "system.restore",
      restorePhase: "RestoreInitiated",
      actor,
      sourceId,
      targetSnapshotId: snapshot.snapshotId,
      targetSequence: snapshot.sequence,
      divergenceReport: snapshot.externalEffectsSinceBaseline,
    });
  } catch (cause) {
    return aborted("initiated", `append(RestoreInitiated) failed closed: ${errMessage(cause)}`);
  }

  // Phase: rebuilding — rebuild the STATE-LAYER projection. A failure here aborts WITHOUT emitting
  // RestoreCompleted (no half-completed illusion; the forward log already shows the attempt).
  try {
    await deps.rebuildProjection(snapshot);
  } catch (cause) {
    return aborted("rebuilding", `rebuildProjection failed closed: ${errMessage(cause)}`);
  }

  // Phase: completed — emit the SECOND forward event (RestoreCompleted).
  try {
    await deps.appender.append({
      kind: "system.restore",
      restorePhase: "RestoreCompleted",
      actor,
      sourceId,
      targetSnapshotId: snapshot.snapshotId,
      targetSequence: snapshot.sequence,
      divergenceReport: snapshot.externalEffectsSinceBaseline,
    });
  } catch (cause) {
    return aborted("completed", `append(RestoreCompleted) failed closed: ${errMessage(cause)}`);
  }

  return { status: "completed", phase: "completed" };
}
