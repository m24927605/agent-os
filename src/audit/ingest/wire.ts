import type { CommitAppender } from "../../commitgate/index.js";
/**
 * Composition convenience: assemble the core ingest pieces into ONE `CommitAppender` (slice P2R-R2-S7).
 *
 * `createIngestAppender` composes S2 `createIngestClient` (canonicalize -> redact -> assign per-source
 * monotonic sequence -> send via the injected `AppendTransport` -> S1 `parseAppendResponse`) with the
 * S3 dedup table and the S4 capped outbox into a single `CommitAppender<E, AppendReceipt>`. It is the
 * production replacement for the P2-I in-memory appender (`AppendOnlyLog.append`): same `AppendReceipt`
 * shape, same single-argument `append(event)` signature, so the P2-I `CommitAppender<unknown, R>`
 * injection point takes it with ZERO type change.
 *
 * Fail-closed / deny-by-default (the load-bearing invariant — the commitgate treats a RESOLVED promise
 * as a durable commit, so a non-success MUST reject; src/commitgate/guard.ts §17-19): the client's
 * `append` REJECTS on a dedup conflict, a transport reject/timeout, or a non-receipt response (S1
 * parser). That reject propagates here unchanged, the commitgate aborts, and the external effect NEVER
 * becomes observable. The appender NEVER resolves a falsy receipt.
 *
 * The S4 capped outbox is composed as the BOUNDED at-least-once staging buffer for a later flush
 * (re-sending staged records through the SAME transport). Automatic background re-send / durable
 * staging is a later ITEM (design §3 "新增 / capped outbox", §7); this slice wires it as an available,
 * fail-closed (`OutboxFullError` on a full buffer) capability and exposes a manual `flush`.
 *
 * Vendor-neutral: depends only on the injected `AppendTransport` port (the concrete RPC adapter, S6,
 * is supplied by the composition root) and on same-module / barrel'd core surfaces. No vendor import,
 * no network here.
 */
import type { AppendReceipt } from "../kernel/log.js";
import { createIngestClient } from "./client.js";
import { type DedupTable, createDedupTable } from "./dedup.js";
import { type CappedOutbox, createCappedOutbox } from "./outbox.js";
import type { AppendTransport } from "./transport.js";

/** Default bound for the staging outbox; a full buffer fails closed rather than growing unbounded. */
const DEFAULT_OUTBOX_CAPACITY = 1024;

export interface IngestAppenderDeps {
  /** The injected vendor-neutral transport port (the concrete RPC adapter is supplied by S6). */
  readonly transport: AppendTransport;
  /** Per-source identity; bound here so `append(event)` keeps the single-arg CommitAppender signature. */
  readonly sourceId: string;
  /** (sourceId,sequence)->contentHash dedup gate; defaults to a fresh in-memory table (S3). */
  readonly dedup?: DedupTable;
  /** Bound on the staging outbox (positive integer); defaults to {@link DEFAULT_OUTBOX_CAPACITY}. */
  readonly outboxCapacity?: number;
}

/**
 * The composed ingest appender: a `CommitAppender<E, AppendReceipt>` plus its bounded staging outbox.
 * `flush` drives the at-least-once re-send of any staged records through the same transport.
 */
export interface IngestAppender<E> extends CommitAppender<E, AppendReceipt> {
  /** The bounded at-least-once staging buffer (S4); a full buffer fails closed on enqueue. */
  readonly outbox: CappedOutbox;
}

/**
 * Build the single `CommitAppender<E, AppendReceipt>` the P2-I pipeline injects in place of the
 * in-memory appender. Generic over the event type so the structural pipeline event (and a branded
 * `AuditEvent`) both slot into the `CommitAppender<unknown, R>` injection point; the canonicalizer is
 * structural, so any serializable record is redacted + canonicalized identically.
 */
export function createIngestAppender<E = unknown>(deps: IngestAppenderDeps): IngestAppender<E> {
  const { transport, sourceId } = deps;
  const dedup = deps.dedup ?? createDedupTable();
  // The client owns the per-source monotonic sequence + dedup + canonicalize/send/parse (S2+S3).
  const client = createIngestClient({ transport, sourceId, dedup });

  // Bounded staging buffer (S4). Its `deliver` re-sends a staged record through the SAME transport,
  // driven by a later flush; it is byte-neutral (stages only already-redacted canonical bytes).
  const outbox: CappedOutbox = createCappedOutbox({
    capacity: deps.outboxCapacity ?? DEFAULT_OUTBOX_CAPACITY,
    deliver: (record) =>
      transport.append({
        sourceId: record.sourceId,
        sequence: record.sequence,
        canonicalEvent: record.canonicalEvent,
      }),
  });

  return {
    outbox,
    // Sync-commit: the client canonicalizes, sequences, sends, and awaits a durable receipt. ANY
    // failure (dedup conflict / transport reject / non-receipt) REJECTS here -> commitgate aborts ->
    // the effect never runs. We never resolve a falsy receipt (fail-closed).
    append: (event: E): Promise<AppendReceipt> => client.append(event as never),
  };
}
