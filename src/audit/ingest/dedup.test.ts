import { describe, expect, it } from "vitest";
import type { AppendReceipt } from "../kernel/log.js";
import { createDedupTable } from "./dedup.js";

/**
 * RED-first spec for the (sourceId,sequence)->contentHash dedup table (slice P2R-R2-S3, design §4.2).
 *
 * Mirrors the Go outbox CheckDedup / ErrContentConflict semantics
 * (kernel/internal/outbox/outbox.go:30-31,236-249):
 *  - first present (s,seq,hash) -> {kind:"new"}; after `record` it becomes settled.
 *  - re-present with the SAME hash -> {kind:"replay", receipt} (idempotent no-op; never re-hits kernel).
 *  - re-present with a DIFFERENT hash -> {kind:"conflict"} (fail-closed; never overwrite a settled slot).
 *  - distinct sources never collide on the same sequence.
 *
 * The table is pure in-memory state — zero network, zero vendor — so it is fully unit-testable.
 */

function makeReceipt(sequence: number): AppendReceipt {
  return {
    sequence,
    contentHash: "sha256:cccc",
    prevHash: "sha256:pppp",
    entryHash: "sha256:eeee",
  };
}

describe("createDedupTable ((sourceId,sequence)->contentHash; replay vs conflict; fail-closed)", () => {
  it("first present of (s,0,hashA) is new; after record it is settled", () => {
    const table = createDedupTable();
    expect(table.check("s", 0, "hashA")).toEqual({ kind: "new" });
  });

  it("replay: re-present (s,0,hashA) with the SAME hash returns the recorded receipt", () => {
    const table = createDedupTable();
    const receipt = makeReceipt(0);
    expect(table.check("s", 0, "hashA")).toEqual({ kind: "new" });
    table.record("s", 0, "hashA", receipt);

    const result = table.check("s", 0, "hashA");
    expect(result).toEqual({ kind: "replay", receipt });
  });

  it("fail-closed conflict: re-present (s,0,hashB) with a DIFFERENT hash returns conflict", () => {
    const table = createDedupTable();
    table.record("s", 0, "hashA", makeReceipt(0));

    expect(table.check("s", 0, "hashB")).toEqual({ kind: "conflict" });
  });

  it("distinct sources do not collide on the same sequence", () => {
    const table = createDedupTable();
    table.record("sX", 0, "hashX", makeReceipt(0));

    // sY at sequence 0 is still unseen — independent key space.
    expect(table.check("sY", 0, "hashY")).toEqual({ kind: "new" });
    // sX at sequence 0 with its own hash replays.
    expect(table.check("sX", 0, "hashX")).toEqual({
      kind: "replay",
      receipt: makeReceipt(0),
    });
  });
});
