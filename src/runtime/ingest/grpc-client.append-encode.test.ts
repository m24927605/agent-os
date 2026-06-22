/**
 * RED-first wire-level unit test for the `encodeAppendRequest` proto3 codec — specifically the
 * field-4 (`partition_id`) encode branch (SLICE-ES2b PREREQUISITE).
 *
 * ES2a added proto `partition_id = 4`, but the hand-written `encodeAppendRequest` in grpc-client.ts
 * had NO field-4 branch (it encoded only fields 1/2/3). ES2a only ever sent an EMPTY partition_id, so
 * it was still wire-correct then. But the moment ES2b sends a NON-EMPTY partition_id, the missing
 * branch would SILENTLY DROP it on the wire -> the kernel's partitioned server receives an empty
 * partition_id -> fail-closed MALFORMED deny. So this test pins, at the byte level, that:
 *
 *   (a) a NON-EMPTY partitionId emits proto3 field 4 (tag 0x22 = field 4, wiretype 2 len-delim) carrying
 *       the UTF-8 bytes of the id; and
 *   (b) an EMPTY partitionId OMITS field 4 entirely — so Personal's single-chain append (which never
 *       sets a partition) stays BYTE-IDENTICAL to its pre-ES2b wire (no spurious tag 0x22).
 *
 * No kernel, no network: this asserts the production encoder's bytes against a hand-decoded fixture.
 */
import { describe, expect, it } from "vitest";
import type { AppendRequest } from "../_generated/ingest/ingest.js";
import { encodeAppendRequest } from "./grpc-client.js";

/** tag byte for proto3 field 4, wiretype 2 (length-delimited) = 4*8 + 2 = 0x22. */
const FIELD4_TAG = 0x22;

/** A minimal AppendRequest with a chosen partitionId; sourceId/canonicalEvent kept tiny + stable. */
function reqWith(partitionId: string): AppendRequest {
  return {
    sourceId: "src-es2b",
    sequence: 0,
    canonicalEvent: new Uint8Array([0xaa, 0xbb]),
    partitionId,
  };
}

/**
 * Walk a proto3 wire buffer and return the raw bytes of the FIRST len-delimited field whose tag
 * matches `tag`, or undefined if absent. Independent of the production decoder so the test cannot pass
 * by sharing a bug with it.
 */
function lenDelimField(buf: Uint8Array, tag: number): Uint8Array | undefined {
  let pos = 0;
  while (pos < buf.length) {
    const t = buf[pos++] as number;
    const wireType = t & 0x07;
    if (t === tag) {
      // length-delimited: next is a varint length, then that many bytes.
      let len = 0;
      let shift = 1;
      for (;;) {
        const b = buf[pos++] as number;
        len += (b & 0x7f) * shift;
        if ((b & 0x80) === 0) break;
        shift *= 128;
      }
      return buf.subarray(pos, pos + len);
    }
    // Skip the non-matching field by wiretype so we can keep scanning for `tag`.
    if (wireType === 0) {
      // varint
      while ((buf[pos++] as number) & 0x80) {
        /* consume continuation bytes */
      }
    } else if (wireType === 2) {
      // length-delimited: read length varint, then skip that many bytes.
      let len = 0;
      let shift = 1;
      for (;;) {
        const b = buf[pos++] as number;
        len += (b & 0x7f) * shift;
        if ((b & 0x80) === 0) break;
        shift *= 128;
      }
      pos += len;
    } else {
      throw new Error(`unexpected wiretype ${wireType} in fixture scan`);
    }
  }
  return undefined;
}

describe("encodeAppendRequest field-4 (partition_id) encode branch (ES2b prerequisite)", () => {
  it("emits proto3 field 4 (tag 0x22) carrying the UTF-8 partitionId bytes when partitionId is non-empty", () => {
    const bytes = encodeAppendRequest(reqWith("partition-tenant-a"));
    // field 4 is present on the wire...
    expect(Array.from(bytes).includes(FIELD4_TAG)).toBe(true);
    // ...and its payload is exactly the UTF-8 encoding of the partitionId (no drop, no mutation).
    const payload = lenDelimField(bytes, FIELD4_TAG);
    expect(payload).toBeDefined();
    expect(Array.from(payload ?? new Uint8Array())).toEqual(
      Array.from(new TextEncoder().encode("partition-tenant-a")),
    );
  });

  it("OMITS field 4 entirely when partitionId is empty — Personal's wire stays byte-identical", () => {
    const bytes = encodeAppendRequest(reqWith(""));
    // No tag 0x22 anywhere: an empty (proto3 default) partition_id is not written.
    expect(Array.from(bytes).includes(FIELD4_TAG)).toBe(false);
    expect(lenDelimField(bytes, FIELD4_TAG)).toBeUndefined();
  });

  it("two different non-empty partitionIds produce DIFFERENT field-4 payloads (the id is the routing key)", () => {
    const a = lenDelimField(encodeAppendRequest(reqWith("partition-tenant-a")), FIELD4_TAG);
    const b = lenDelimField(encodeAppendRequest(reqWith("partition-tenant-b")), FIELD4_TAG);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(Array.from(a ?? new Uint8Array())).not.toEqual(Array.from(b ?? new Uint8Array()));
  });
});
