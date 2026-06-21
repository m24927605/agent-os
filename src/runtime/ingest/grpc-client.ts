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
  Receipt,
} from "../_generated/ingest/ingest.js";

const METHOD = "/agentos.kernel.ingest.v1.AppendService/Append";

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
    // Checkpoint is part of the AppendService contract (R10-S4: snapshot-safe checkpoint RPC). Its
    // wire codecs + composition-root wiring are consumed by R10-S3 (out of scope here). Until that
    // slice wires it, fail CLOSED: never return a faked/empty anchor that a caller might trust.
    Checkpoint(_request: CheckpointRequest): Promise<CheckpointResponse> {
      return Promise.reject(
        new Error("Checkpoint RPC client not wired yet (R10-S3 composition root; fail-closed)"),
      );
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

function encodeAppendRequest(req: AppendRequest): Buffer {
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
