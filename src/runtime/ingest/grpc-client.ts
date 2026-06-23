/**
 * The grpc-js-backed `AppendService` client — the SINGLE module that names the runtime RPC vendor
 * (@grpc/grpc-js). It lives under src/runtime/ (not core), so `no-vendor-in-core` stays intact.
 *
 * Mirrors the Go reference client (kernel/internal/client/client.go): a unary `Append` over the
 * `agentos.kernel.ingest.v1.AppendService/Append` method, append-only, with hand-written proto3 wire
 * codecs (the S5 stub is `onlyTypes=true` and carries no codec). A gRPC status error — including a
 * refused connection or a DEADLINE_EXCEEDED — surfaces as a rejected promise, which the transport
 * adapter (transport.ts) treats as fail-closed.
 *
 * NOTE: construction is exercised by S7 (composition-root + e2e against a live kernel). S6 tests inject
 * an in-process `AppendService` stub and never build this client, so it stays network-free under test.
 */
import { Client, type ServiceError, credentials } from "@grpc/grpc-js";
import type {
  AppendError,
  AppendRequest,
  AppendResponse,
  AppendService,
  CheckpointRequest,
  CheckpointResponse,
  Entry,
  ListEntriesRequest,
  ListEntriesResponse,
  Receipt,
} from "../_generated/ingest/ingest.js";

const METHOD = "/agentos.kernel.ingest.v1.AppendService/Append";
const LIST_ENTRIES_METHOD = "/agentos.kernel.ingest.v1.AppendService/ListEntries";
const CHECKPOINT_METHOD = "/agentos.kernel.ingest.v1.AppendService/Checkpoint";

/** Build a typed `AppendService` over a grpc-js channel to `endpoint` (insecure; TLS is an S7 concern). */
export function grpcAppendService(endpoint: string): AppendService {
  const client = new Client(endpoint, credentials.createInsecure());
  return {
    Append(request: AppendRequest): Promise<AppendResponse> {
      return new Promise<AppendResponse>((resolve, reject) => {
        client.makeUnaryRequest(
          METHOD,
          encodeAppendRequest,
          decodeAppendResponse,
          request,
          (err: ServiceError | null, value?: AppendResponse) => {
            if (err !== null) {
              reject(err);
              return;
            }
            if (value === undefined) {
              reject(new Error("append: missing RPC response (fail-closed)"));
              return;
            }
            resolve(value);
          },
        );
      });
    },
    // Checkpoint is the snapshot-safe SIGNED anchor RPC (K1 added checkpoint_signature + public_key;
    // SLICE-K2 wires the client so a signed read-back can reconstruct the operator's ACTUAL chain head).
    // It is READ-ONLY (the kernel signs under its append mutex). Mirrors Append/ListEntries' fail-closed
    // shape: an RPC error or a missing response surfaces as a rejected promise (the signed-chain reader
    // treats it as fail-closed — never a faked/empty/unsigned anchor a caller might trust as signed).
    Checkpoint(request: CheckpointRequest): Promise<CheckpointResponse> {
      return new Promise<CheckpointResponse>((resolve, reject) => {
        client.makeUnaryRequest(
          CHECKPOINT_METHOD,
          encodeCheckpointRequest,
          decodeCheckpointResponse,
          request,
          (err: ServiceError | null, value?: CheckpointResponse) => {
            if (err !== null) {
              reject(err);
              return;
            }
            if (value === undefined) {
              reject(new Error("checkpoint: missing RPC response (fail-closed)"));
              return;
            }
            resolve(value);
          },
        );
      });
    },
    // ListEntries is the read-only WORM chain read-back (P2R-PV-S3a contract): a unary RPC over the
    // SAME AppendService channel. It returns a CONSISTENT snapshot of entries (sequence >= from_sequence)
    // so a client can re-derive entryHash and reconstruct a timeline. Mirrors Append's fail-closed shape:
    // an RPC error or a missing response surfaces as a rejected promise (reader.ts treats it as
    // fail-closed — never a partial/faked entry set).
    ListEntries(request: ListEntriesRequest): Promise<ListEntriesResponse> {
      return new Promise<ListEntriesResponse>((resolve, reject) => {
        client.makeUnaryRequest(
          LIST_ENTRIES_METHOD,
          encodeListEntriesRequest,
          decodeListEntriesResponse,
          request,
          (err: ServiceError | null, value?: ListEntriesResponse) => {
            if (err !== null) {
              reject(err);
              return;
            }
            if (value === undefined) {
              reject(new Error("listEntries: missing RPC response (fail-closed)"));
              return;
            }
            resolve(value);
          },
        );
      });
    },
  };
}

// --- minimal proto3 wire codecs (no third-party codec; the S5 stub is types-only) -------------------

function writeVarint(out: number[], value: number): void {
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
}

function writeTag(out: number[], field: number, wireType: number): void {
  writeVarint(out, field * 8 + wireType);
}

function writeLenDelim(out: number[], field: number, bytes: Uint8Array): void {
  writeTag(out, field, 2);
  writeVarint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

/**
 * Encode an `AppendRequest` to proto3 wire bytes (fields 1/2/3, and 4 = partition_id since ES2b).
 *
 * ES2b PREREQUISITE — the field-4 branch: ES2a added proto `partition_id = 4`, but this encoder had no
 * field-4 branch (it only sent fields 1/2/3). That was wire-correct ONLY while every caller sent an
 * empty partition_id (Personal's single-chain path). The moment a NON-EMPTY partition_id is sent (the
 * Enterprise per-tenant path), a missing branch would SILENTLY DROP it -> the kernel's partitioned
 * server receives an empty partition_id -> fail-closed MALFORMED deny. So we encode field 4 here, with
 * the SAME `if (length > 0)` proto3-default guard as the other fields: an empty partitionId omits field
 * 4 entirely, keeping Personal's wire BYTE-IDENTICAL. Exported for the wire-level codec unit test
 * (no kernel needed), mirroring `encodeListEntriesRequest`.
 */
export function encodeAppendRequest(req: AppendRequest): Buffer {
  const out: number[] = [];
  if (req.sourceId.length > 0) {
    writeLenDelim(out, 1, new TextEncoder().encode(req.sourceId));
  }
  if (req.sequence !== 0) {
    writeTag(out, 2, 0);
    writeVarint(out, req.sequence);
  }
  if (req.canonicalEvent.length > 0) {
    writeLenDelim(out, 3, req.canonicalEvent);
  }
  if (req.partitionId.length > 0) {
    // proto field 4 (partition_id), len-delimited UTF-8. Empty => omitted (proto3 default), so the
    // single-chain Personal append stays byte-identical and the partitioned server fail-closed denies.
    writeLenDelim(out, 4, new TextEncoder().encode(req.partitionId));
  }
  return Buffer.from(out);
}

type Reader = { buf: Uint8Array; pos: number };

function readVarint(r: Reader): number {
  let result = 0;
  let shift = 1;
  for (;;) {
    const byte = r.buf[r.pos++];
    if (byte === undefined) throw new Error("append: truncated varint (fail-closed)");
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) break;
    shift *= 128;
  }
  return result;
}

function readLenDelim(r: Reader): Uint8Array {
  const len = readVarint(r);
  const start = r.pos;
  r.pos += len;
  if (r.pos > r.buf.length)
    throw new Error("append: truncated length-delimited field (fail-closed)");
  return r.buf.subarray(start, r.pos);
}

function decodeReceipt(bytes: Uint8Array): Receipt {
  const r: Reader = { buf: bytes, pos: 0 };
  const out: Receipt = { sequence: 0, contentHash: "", prevHash: "", entryHash: "" };
  const dec = new TextDecoder();
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    if (field === 1) out.sequence = readVarint(r);
    else if (field === 2) out.contentHash = dec.decode(readLenDelim(r));
    else if (field === 3) out.prevHash = dec.decode(readLenDelim(r));
    else if (field === 4) out.entryHash = dec.decode(readLenDelim(r));
    else throw new Error("append: unexpected field in Receipt (fail-closed)");
  }
  return out;
}

function decodeAppendError(bytes: Uint8Array): AppendError {
  const r: Reader = { buf: bytes, pos: 0 };
  const out: AppendError = { code: 0, detail: "" };
  const dec = new TextDecoder();
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    if (field === 1) out.code = readVarint(r);
    else if (field === 2) out.detail = dec.decode(readLenDelim(r));
    else throw new Error("append: unexpected field in AppendError (fail-closed)");
  }
  return out;
}

function decodeAppendResponse(bytes: Buffer): AppendResponse {
  const r: Reader = { buf: bytes, pos: 0 };
  let result: AppendResponse["result"];
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    if (field === 1) result = { $case: "receipt", receipt: decodeReceipt(readLenDelim(r)) };
    else if (field === 2) result = { $case: "error", error: decodeAppendError(readLenDelim(r)) };
    else throw new Error("append: unexpected field in AppendResponse (fail-closed)");
  }
  return { result };
}

// --- ListEntries codecs (P2R-PV-S3b: read-only WORM chain read-back; same hand-written proto3 path) -

/**
 * Encode a `ListEntriesRequest` { from_sequence = 1 : uint64 }. The proto3 zero value is omitted on
 * the wire (an absent from_sequence => the whole log), matching the kernel's `0 => whole chain` rule.
 * Exported for the S3b decoder/encoder unit fixture test (no kernel needed).
 */
export function encodeListEntriesRequest(req: ListEntriesRequest): Buffer {
  const out: number[] = [];
  if (req.fromSequence !== 0) {
    writeTag(out, 1, 0);
    writeVarint(out, req.fromSequence);
  }
  return Buffer.from(out);
}

/** Decode one `Entry` { sequence=1:uint64, canonical_event=2:bytes, prev_hash=3:string, entry_hash=4:string }. */
function decodeEntry(bytes: Uint8Array): Entry {
  const r: Reader = { buf: bytes, pos: 0 };
  const out: Entry = { sequence: 0, canonicalEvent: new Uint8Array(), prevHash: "", entryHash: "" };
  const dec = new TextDecoder();
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    if (field === 1) out.sequence = readVarint(r);
    // copy the canonical bytes out of the shared buffer so the Entry owns an independent slice.
    else if (field === 2) out.canonicalEvent = Uint8Array.from(readLenDelim(r));
    else if (field === 3) out.prevHash = dec.decode(readLenDelim(r));
    else if (field === 4) out.entryHash = dec.decode(readLenDelim(r));
    else throw new Error("listEntries: unexpected field in Entry (fail-closed)");
  }
  return out;
}

/**
 * Decode a `ListEntriesResponse` { repeated Entry = 1 (len-delimited) } in chain order. Exported for
 * the S3b byte-fixture unit test. A malformed frame throws (fail-closed; the reader rejects rather than
 * surfacing a partial entry set).
 */
export function decodeListEntriesResponse(bytes: Buffer): ListEntriesResponse {
  const r: Reader = { buf: bytes, pos: 0 };
  const entries: Entry[] = [];
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    if (field === 1) entries.push(decodeEntry(readLenDelim(r)));
    else throw new Error("listEntries: unexpected field in ListEntriesResponse (fail-closed)");
  }
  return { entries };
}

// --- Checkpoint codecs (SLICE-K2: signed read-back; same hand-written proto3 path) ------------------

/**
 * Encode a `CheckpointRequest` — it carries NO fields (the anchor is the kernel's single global chain
 * head), so the wire is always ZERO bytes. Exported for the K2 codec unit test (no kernel needed).
 */
export function encodeCheckpointRequest(_req: CheckpointRequest): Buffer {
  return Buffer.from([]);
}

/**
 * Decode one map<string,uint64> entry { key=1:string, value=2:uint64 } from `per_source_next_seq`. A
 * proto3 map field is encoded as repeated length-delimited messages with this shape.
 */
function decodePerSourceEntry(bytes: Uint8Array): { key: string; value: number } {
  const r: Reader = { buf: bytes, pos: 0 };
  let key = "";
  let value = 0;
  const dec = new TextDecoder();
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    if (field === 1) key = dec.decode(readLenDelim(r));
    else if (field === 2) value = readVarint(r);
    else throw new Error("checkpoint: unexpected field in per_source_next_seq entry (fail-closed)");
  }
  return { key, value };
}

/**
 * Decode a `CheckpointResponse`:
 *   head_entry_hash=1:string, head_sequence=2:uint64, per_source_next_seq=3:map<string,uint64>,
 *   checkpoint_signature=4:string (base64 Ed25519), public_key=5:bytes (SPKI/PKIX DER).
 *
 * K1 added fields 4 + 5; this decoder MUST carry them so a signed read-back can reconstruct the
 * operator's ACTUAL signed chain head + the kernel's pubkey (a dropped field 4/5 would silently
 * downgrade a signed checkpoint to an UNSIGNED one — the signed-chain reader then fails closed). A
 * malformed frame throws (fail-closed). Exported for the K2 byte-fixture unit test (no kernel needed).
 */
export function decodeCheckpointResponse(bytes: Buffer): CheckpointResponse {
  const r: Reader = { buf: bytes, pos: 0 };
  const out: CheckpointResponse = {
    headEntryHash: "",
    headSequence: 0,
    perSourceNextSeq: {},
    checkpointSignature: "",
    publicKey: new Uint8Array(),
  };
  const dec = new TextDecoder();
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    if (field === 1) out.headEntryHash = dec.decode(readLenDelim(r));
    else if (field === 2) out.headSequence = readVarint(r);
    else if (field === 3) {
      const { key, value } = decodePerSourceEntry(readLenDelim(r));
      out.perSourceNextSeq[key] = value;
    } else if (field === 4) out.checkpointSignature = dec.decode(readLenDelim(r));
    // copy the DER bytes out of the shared buffer so the response owns an independent slice.
    else if (field === 5) out.publicKey = Uint8Array.from(readLenDelim(r));
    else throw new Error("checkpoint: unexpected field in CheckpointResponse (fail-closed)");
  }
  return out;
}
