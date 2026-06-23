/**
 * RED-first unit tests for the hand-written `Checkpoint` proto3 wire codec (SLICE-K2).
 *
 * K1 added two fields to CheckpointResponse: checkpoint_signature (4, string) + public_key (5, bytes).
 * The pre-K2 hand-written client had only a reject STUB for Checkpoint (no codec), so a real signed
 * read-back could not decode the signature/pubkey. These tests run with NO kernel and NO network: they
 * assert the encode/decode codecs the grpc-js client now uses are byte-correct against a KNOWN wire
 * fixture, mirroring the ListEntries codec tests. A dropped or mis-tagged field 4/5 is a RED test (the
 * exact regression the spec warns about: "if the hand-written CheckpointResponse decoder drops field
 * 4/5, ADD them").
 *
 * Wire layout (ingest.proto):
 *   CheckpointRequest {}  (no fields)
 *   CheckpointResponse {
 *     head_entry_hash = 1 : string, head_sequence = 2 : uint64,
 *     per_source_next_seq = 3 : map<string,uint64>,   (encoded as repeated message entries)
 *     checkpoint_signature = 4 : string, public_key = 5 : bytes }
 */
import { describe, expect, it } from "vitest";
import { decodeCheckpointResponse, encodeCheckpointRequest } from "./grpc-client.js";

// --- a tiny, independent proto3 encoder used ONLY to build a known fixture (not the production path) ---

function pushVarint(out: number[], value: number): void {
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
}

function pushTag(out: number[], field: number, wireType: number): void {
  pushVarint(out, field * 8 + wireType);
}

function pushLenDelim(out: number[], field: number, bytes: Uint8Array): void {
  pushTag(out, field, 2);
  pushVarint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

function pushString(out: number[], field: number, value: string): void {
  pushLenDelim(out, field, new TextEncoder().encode(value));
}

/** Encode one map<string,uint64> entry { key=1:string, value=2:varint } as a proto3 message. */
function encodeMapEntry(key: string, value: number): Uint8Array {
  const out: number[] = [];
  if (key.length > 0) pushString(out, 1, key);
  if (value !== 0) {
    pushTag(out, 2, 0);
    pushVarint(out, value);
  }
  return Uint8Array.from(out);
}

describe("Checkpoint request encoder (K2)", () => {
  it("encodes the empty CheckpointRequest to zero bytes (no fields)", () => {
    expect(encodeCheckpointRequest({}).length).toBe(0);
  });
});

describe("Checkpoint response decoder (K2) — decodes signature(4) + public_key(5)", () => {
  it("decodes every field round-trip incl. checkpoint_signature + public_key", () => {
    const head = `sha256:${"a".repeat(64)}`;
    const sig = "dGVzdC1zaWduYXR1cmU="; // base64 "test-signature"
    const pub = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70]); // SPKI-ish DER prefix

    const out: number[] = [];
    pushString(out, 1, head);
    pushTag(out, 2, 0);
    pushVarint(out, 7); // head_sequence = 7
    pushLenDelim(out, 3, encodeMapEntry("src-a", 8)); // per_source_next_seq["src-a"] = 8
    pushString(out, 4, sig);
    pushLenDelim(out, 5, pub);

    const decoded = decodeCheckpointResponse(Buffer.from(out));
    expect(decoded.headEntryHash).toBe(head);
    expect(decoded.headSequence).toBe(7);
    expect(decoded.perSourceNextSeq).toEqual({ "src-a": 8 });
    expect(decoded.checkpointSignature).toBe(sig);
    expect(Array.from(decoded.publicKey)).toEqual(Array.from(pub));
  });

  it("decodes an empty response to genesis-shaped defaults (empty sig/pubkey)", () => {
    const decoded = decodeCheckpointResponse(Buffer.from([]));
    expect(decoded.headEntryHash).toBe("");
    expect(decoded.headSequence).toBe(0);
    expect(decoded.perSourceNextSeq).toEqual({});
    expect(decoded.checkpointSignature).toBe("");
    expect(decoded.publicKey.length).toBe(0);
  });
});
