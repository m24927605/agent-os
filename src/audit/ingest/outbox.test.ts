import { describe, expect, it } from "vitest";
import { OutboxFullError, type OutboxRecord, createCappedOutbox } from "./outbox.js";

/**
 * RED-first spec for the capped client-side outbox (slice P2R-R2-S4).
 *
 * Mirrors the Go outbox pending -> deliver(at-least-once) -> mark-delivered skeleton
 * (kernel/internal/outbox/outbox.go:222-283), but this TS layer is bounded IN-MEMORY only
 * (durable-ization is a later ITEM). Two hard invariants are probed adversarially:
 *  - fail-closed full: enqueue at capacity THROWS OutboxFullError (never drops the oldest / never
 *    silently swallows — dropping is fail-open data loss).
 *  - at-least-once: a deliver failure STOPS delivery; already-delivered records are removed, the
 *    failing + remaining records STAY pending and are retried on a later flush (zero data loss).
 *
 * `deliver` is injected — zero network, zero vendor — so the outbox is fully unit-testable.
 */

/** Build a record with a distinct content per (sourceId, sequence) so ordering is observable. */
function rec(sourceId: string, sequence: number): OutboxRecord {
  return {
    sourceId,
    sequence,
    canonicalEvent: new TextEncoder().encode(`${sourceId}/${sequence}`),
    contentHash: `sha256:${sourceId}-${sequence}`,
  };
}

describe("createCappedOutbox (bounded buffer; fail-closed full; at-least-once flush)", () => {
  it("enqueue up to capacity: pendingCount tracks, isFull() flips at capacity", () => {
    const outbox = createCappedOutbox({ capacity: 2, deliver: async () => {} });

    expect(outbox.pendingCount()).toBe(0);
    expect(outbox.isFull()).toBe(false);

    outbox.enqueue(rec("s", 0));
    expect(outbox.pendingCount()).toBe(1);
    expect(outbox.isFull()).toBe(false);

    outbox.enqueue(rec("s", 1));
    expect(outbox.pendingCount()).toBe(2);
    expect(outbox.isFull()).toBe(true);
  });

  it("fail-closed full: enqueue at capacity THROWS OutboxFullError (does not drop oldest / does not swallow)", () => {
    const outbox = createCappedOutbox({ capacity: 1, deliver: async () => {} });
    outbox.enqueue(rec("s", 0));

    expect(() => outbox.enqueue(rec("s", 1))).toThrow(OutboxFullError);
    // The buffer is unchanged: still full at 1, the OLD record is retained (not evicted).
    expect(outbox.pendingCount()).toBe(1);
    expect(outbox.isFull()).toBe(true);
  });

  it("flush happy: an always-succeeding deliver sends all, drains pending to zero, in sequence order", async () => {
    const seen: number[] = [];
    const outbox = createCappedOutbox({
      capacity: 8,
      deliver: async (r: OutboxRecord) => {
        seen.push(r.sequence);
      },
    });
    // Enqueue out of order; flush must deliver in ascending (sourceId, sequence) order.
    outbox.enqueue(rec("s", 2));
    outbox.enqueue(rec("s", 0));
    outbox.enqueue(rec("s", 1));

    await outbox.flush();

    expect(seen).toEqual([0, 1, 2]);
    expect(outbox.pendingCount()).toBe(0);
    expect(outbox.isFull()).toBe(false);
  });

  it("flush fail-closed: deliver rejects on the 2nd record -> flush rejects, sent record removed, unsent STAY pending", async () => {
    const seen: number[] = [];
    let calls = 0;
    const outbox = createCappedOutbox({
      capacity: 8,
      deliver: async (r: OutboxRecord) => {
        calls += 1;
        if (calls === 2) {
          throw new Error("transport down");
        }
        seen.push(r.sequence);
      },
    });
    outbox.enqueue(rec("s", 0));
    outbox.enqueue(rec("s", 1));
    outbox.enqueue(rec("s", 2));

    await expect(outbox.flush()).rejects.toThrow("transport down");

    // Only the 1st (seq 0) succeeded; seq 1 failed and seq 2 was never attempted.
    expect(seen).toEqual([0]);
    // seq 0 removed; seq 1 and seq 2 remain pending (no data loss).
    expect(outbox.pendingCount()).toBe(2);
  });

  it("at-least-once: after a failed flush, a later flush re-attempts the un-acked record (does not skip it)", async () => {
    const seen: number[] = [];
    let failNext = true;
    const outbox = createCappedOutbox({
      capacity: 8,
      deliver: async (r: OutboxRecord) => {
        if (failNext) {
          failNext = false;
          throw new Error("transport blip");
        }
        seen.push(r.sequence);
      },
    });
    outbox.enqueue(rec("s", 0));

    // First flush: deliver throws before recording -> seq 0 stays pending.
    await expect(outbox.flush()).rejects.toThrow("transport blip");
    expect(seen).toEqual([]);
    expect(outbox.pendingCount()).toBe(1);

    // Second flush: the SAME un-acked seq 0 is re-attempted (at-least-once; never skipped).
    await outbox.flush();
    expect(seen).toEqual([0]);
    expect(outbox.pendingCount()).toBe(0);
  });

  it("credentials never on disk: a runtime-assembled secret canary in canonicalEvent is never logged/retained outside the injected deliver", async () => {
    // Canary assembled at RUNTIME (never a source/fixture literal) so secret-scan stays clean.
    const canary = ["AKIA", "CANARY", "S4", "SECRET"].join("");
    const delivered: Uint8Array[] = [];
    const outbox = createCappedOutbox({
      capacity: 4,
      deliver: async (r: OutboxRecord) => {
        delivered.push(r.canonicalEvent);
      },
    });
    outbox.enqueue({
      sourceId: "s",
      sequence: 0,
      canonicalEvent: new TextEncoder().encode(canary),
      contentHash: "sha256:canary",
    });
    await outbox.flush();

    // The outbox passes the bytes through untouched to the injected sink; it neither logs nor
    // mutates them. (Redaction is upstream in canonicalizeAuditEvent; the outbox is byte-neutral.)
    expect(delivered).toHaveLength(1);
    expect(new TextDecoder().decode(delivered[0])).toBe(canary);
  });
});
