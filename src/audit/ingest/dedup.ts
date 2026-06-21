/**
 * (sourceId,sequence)->contentHash dedup table (slice P2R-R2-S3, design §4.2).
 *
 * A front-of-`append` short-circuit that mirrors the Go outbox CheckDedup / ErrContentConflict
 * semantics (kernel/internal/outbox/outbox.go:30-31,236-249):
 *  - An unseen (sourceId, sequence) is `new` — the client should send it to the kernel.
 *  - A re-present with the SAME contentHash is a `replay` — return the cached receipt, NEVER re-hit
 *    the transport (saves a crash-resume RTT + a denial-audit; the kernel stays the SEQUENCE_REPLAY
 *    authority — this gate only declines to ASK again).
 *  - A re-present with a DIFFERENT contentHash is a `conflict` — fail-closed: a settled slot is never
 *    overwritten and never silently re-delivered (mirrors ErrContentConflict). The client throws.
 *
 * This is IN-MEMORY only (durable-ization is a later ITEM; the Go outbox is already durable). It does
 * not relax any kernel denial — it is purely a prefix short-circuit that keeps the client's invariants
 * aligned with the kernel's.
 */
import type { AppendReceipt } from "../kernel/log.js";

/** Result of a dedup `check` — exactly one of three fail-closed outcomes. */
export type DedupResult =
  | { readonly kind: "new" }
  | { readonly kind: "replay"; readonly receipt: AppendReceipt }
  | { readonly kind: "conflict" };

export interface DedupTable {
  /**
   * Classify a (sourceId, sequence, contentHash) against settled slots.
   * `new` (unseen) | `replay` (same hash, returns cached receipt) | `conflict` (different hash).
   */
  check(sourceId: string, sequence: number, contentHash: string): DedupResult;
  /** Record a successfully committed (sourceId, sequence) -> {contentHash, receipt} as settled. */
  record(sourceId: string, sequence: number, contentHash: string, receipt: AppendReceipt): void;
}

/** A settled delivery: the contentHash that occupies the slot + the receipt to replay. */
interface Settled {
  readonly contentHash: string;
  readonly receipt: AppendReceipt;
}

/** Compose the composite key; the literal separator keeps distinct sources from colliding. */
function key(sourceId: string, sequence: number): string {
  return `${sourceId}/${sequence}`;
}

/** Create an empty in-memory dedup table. */
export function createDedupTable(): DedupTable {
  const delivered = new Map<string, Settled>();

  return {
    check(sourceId, sequence, contentHash): DedupResult {
      const settled = delivered.get(key(sourceId, sequence));
      if (settled === undefined) {
        return { kind: "new" };
      }
      // Settled slot: same hash replays the cached receipt; a different hash is a fail-closed conflict.
      if (settled.contentHash !== contentHash) {
        return { kind: "conflict" };
      }
      return { kind: "replay", receipt: settled.receipt };
    },
    record(sourceId, sequence, contentHash, receipt): void {
      delivered.set(key(sourceId, sequence), { contentHash, receipt });
    },
  };
}
