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
 *   idle -> validating -> locked -> verifying-anchor -> initiated -> rebuilding -> completed | aborted
 * Every phase is fail-closed: any failed guard / rejected dependency aborts AT that phase and is NOT
 * partially applied. Critically, a failure during `rebuilding` aborts WITHOUT emitting
 * RestoreCompleted — no half-completed illusion is ever left on the chain.
 *
 * Hard invariants (the security spine of this slice):
 *  - FORWARD-ONLY (design §44/§49): the FSM only ever `append`s. There is no truncate/rewrite API.
 *  - attester != actor (design §44): `sourceId` being a brain source -> deny-by-default at
 *    `validating`. The brain can NEVER self-restore; restore is admin/approver-signed.
 *  - ANCHOR CROSS-VALIDATION (design §40 unified anchor): a SnapshotRecord records the WORM head
 *    content address (`wormHeadHash`) and brain `memoryVersion` AT its `sequence` SPECIFICALLY so a
 *    restore can PROVE the snapshot is consistent with the live chain before rebuilding to it. The
 *    `verifying-anchor` phase reads the LIVE chain's anchor AT `snapshot.sequence` (under the global
 *    lock, so it is a consistent read) and refuses — fail-closed, pre-`initiated`, no append — to
 *    rebuild to a STALE or FORGED anchor (a sequence that still exists but whose recorded head hash
 *    or memory version no longer matches the live chain there).
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

/**
 * The LIVE-chain anchor read back AT a sequence — the WORM head content address + brain memory
 * version the kernel currently records there. The FSM compares this against the SnapshotRecord's
 * recorded anchor to detect a stale/forged snapshot before rebuilding. The CONCRETE read (R2 read-
 * transport / kernel `ListEntries` + memory version lookup) is injected at the composition root; a
 * Fake supplies it in tests. The COMPARISON + fail-closed decision lives in the reviewed FSM below.
 */
export interface LiveChainAnchor {
  readonly wormHeadHash: string;
  readonly memoryVersion: number;
}

/** Everything mutating/external the FSM needs — ALL injected (composition root owns the concretes). */
export interface RestoreDeps {
  /** Acquire the GLOBAL cross-ingest checkpoint/lock (R10-S4). Rejecting aborts at `locked`. */
  acquireCheckpoint(): Promise<unknown>;
  /** Authorize the actor for this snapshot (PDP, Build-list #8). Deny aborts at `validating`. */
  authorize(actor: string, snapshot: SnapshotRecord): RestoreAuthorization;
  /**
   * Read the LIVE chain's anchor (WORM head content address + brain memory version) AT `sequence`.
   * Called under the global lock so the read is consistent. A throw fails closed (deny-by-default).
   * The FSM cross-validates the result against the snapshot's recorded anchor at `verifying-anchor`.
   */
  readLiveChainAnchor(sequence: number): Promise<LiveChainAnchor>;
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
  | "verifying-anchor"
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

  // Phase: verifying-anchor — cross-validate the snapshot's recorded anchor against the LIVE chain.
  // Read AFTER the lock (so it is a consistent read) and BEFORE `initiated` (so a bad anchor records
  // NO forward event — no append on this failure path, same as the other pre-initiated aborts). The
  // comparison + fail-closed decision is made HERE, in the reviewed FSM, never delegated.
  let live: LiveChainAnchor;
  try {
    live = await deps.readLiveChainAnchor(snapshot.sequence);
  } catch (cause) {
    return aborted("verifying-anchor", `anchor read failed closed: ${errMessage(cause)}`);
  }
  if (
    live.wormHeadHash !== snapshot.wormHeadHash ||
    live.memoryVersion !== snapshot.memoryVersion
  ) {
    // The sequence still exists but its recorded head hash / memory version no longer matches the
    // live chain there — a stale or forged anchor. Refuse to rebuild to it. Static reason shape:
    // the sequence and hashes are not secret, but we keep it concise and interpolate no payload.
    return aborted(
      "verifying-anchor",
      `snapshot anchor does not match live chain @ sequence ${snapshot.sequence} — refusing to restore to a stale/forged anchor`,
    );
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
