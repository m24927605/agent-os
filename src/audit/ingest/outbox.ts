/**
 * Capped client-side outbox (slice P2R-R2-S4, design §4.3).
 *
 * When the transport is transiently unreachable, a pending append is staged in a BOUNDED in-memory
 * buffer to be re-sent. Two hard, fail-closed invariants — mirroring the Go outbox skeleton
 * (kernel/internal/outbox/outbox.go:222-283):
 *
 *  - BOUNDED, fail-closed full: `enqueue` throws `OutboxFullError` when the buffer is at capacity.
 *    It NEVER drops the oldest record and NEVER silently swallows the new one — dropping would be
 *    silent data loss = fail-OPEN. The caller sees the error -> commitgate aborts -> effect never
 *    happens ("unknown / error => deny").
 *
 *  - at-least-once flush: `flush` sends still-pending records ordered by (sourceId, sequence) through
 *    the injected `deliver`, removing a record only AFTER its deliver resolves. Any deliver rejection
 *    STOPS the flush immediately; the failing record + every record after it STAY pending (to be
 *    retried on a later flush) — never silently dropped, never skipped.
 *
 * This layer is IN-MEMORY only (durable-ization — framed-append + fsync + replay — is a later ITEM;
 * the Go outbox is already durable). `deliver` is injected, so the outbox imports no other module and
 * touches no network: it is fully unit-testable.
 *
 * Out-of-scope (see slice §3): durable persistence, automatic background re-send scheduling (the
 * caller / composition root drives `flush`), and (sourceId,sequence) dedup (that lives in S3; outbox
 * and dedup compose orthogonally in S7).
 */

/**
 * A pending append staged in the outbox — mirrors the AppendRequest fields plus the content hash.
 * `canonicalEvent` is ALREADY-redacted canonical bytes (redaction is upstream in
 * canonicalizeAuditEvent); the outbox is byte-neutral and never mutates or logs them.
 */
export type OutboxRecord = {
  readonly sourceId: string;
  readonly sequence: number;
  readonly canonicalEvent: Uint8Array;
  readonly contentHash: string;
};

/**
 * Thrown by `enqueue` when the buffer is at capacity. A distinct error type lets the caller map a
 * full buffer to a fail-closed commitgate abort, separate from a transport/deliver rejection.
 */
export class OutboxFullError extends Error {
  constructor(capacity: number) {
    super(`outbox: full (capacity ${capacity}); enqueue rejected (fail-closed)`);
    this.name = "OutboxFullError";
  }
}

/** Dependencies for a capped outbox. `deliver` is the injected at-least-once sink (no network here). */
export interface CappedOutboxDeps<R = unknown> {
  /** Maximum number of pending records; must be a positive integer. */
  readonly capacity: number;
  /** Inject the actual send; resolving = durably delivered, rejecting = retry (record stays pending). */
  readonly deliver: (record: OutboxRecord) => Promise<R>;
}

export interface CappedOutbox {
  /** Stage a record; throws `OutboxFullError` when at capacity (fail-closed — never evicts). */
  enqueue(record: OutboxRecord): void;
  /**
   * Send still-pending records in (sourceId, sequence) order, at-least-once. A record is removed only
   * after its deliver resolves; the first rejection stops the flush and rejects (remaining stay pending).
   */
  flush(): Promise<void>;
  /** Number of records currently pending. */
  pendingCount(): number;
  /** Whether the buffer is at capacity (next enqueue would throw). */
  isFull(): boolean;
}

/** Composite key for a pending slot; the literal separator keeps distinct sources from colliding. */
function key(sourceId: string, sequence: number): string {
  return `${sourceId}/${sequence}`;
}

/** Total order over pending records: by sourceId, then ascending sequence (mirrors Go Deliver sort). */
function compareRecords(a: OutboxRecord, b: OutboxRecord): number {
  if (a.sourceId !== b.sourceId) {
    return a.sourceId < b.sourceId ? -1 : 1;
  }
  return a.sequence - b.sequence;
}

/** Create an empty bounded in-memory outbox. */
export function createCappedOutbox<R = unknown>(deps: CappedOutboxDeps<R>): CappedOutbox {
  const { capacity, deliver } = deps;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    // Fail-closed on a nonsensical bound: an unbounded/zero buffer would defeat the whole point.
    throw new RangeError(`outbox: capacity must be a positive integer, got ${capacity}`);
  }

  // Insertion-ordered map keyed by (sourceId, sequence). A re-enqueue of the same slot overwrites in
  // place and does NOT count against capacity twice (idempotent staging).
  const pending = new Map<string, OutboxRecord>();

  return {
    enqueue(record: OutboxRecord): void {
      const k = key(record.sourceId, record.sequence);
      // Only a genuinely NEW slot consumes capacity; re-staging an existing slot is allowed.
      if (!pending.has(k) && pending.size >= capacity) {
        // Fail-closed: reject the NEW work; retain the existing buffer untouched (never evict oldest).
        throw new OutboxFullError(capacity);
      }
      pending.set(k, record);
    },

    async flush(): Promise<void> {
      // Snapshot + sort so iteration order is deterministic and independent of insertion order.
      const ordered = [...pending.values()].sort(compareRecords);
      for (const record of ordered) {
        // Send first; remove only AFTER the deliver resolves (at-least-once). A rejection propagates,
        // stopping the loop with this record + all later records still pending.
        await deliver(record);
        pending.delete(key(record.sourceId, record.sequence));
      }
    },

    pendingCount(): number {
      return pending.size;
    },

    isFull(): boolean {
      return pending.size >= capacity;
    },
  };
}
