/**
 * Hand-written proto3 wire codecs for the PINNED OpenShell `ExecSandbox` subset (slice SLICE-OS-S1).
 *
 * SINGLE responsibility: serialize an `ExecSandboxRequest` and parse an `ExecSandboxEvent` byte-for-byte
 * against the vendored subset (openshell.subset.proto, v0.0.66). It mirrors the proto 1:1 — there is NO
 * third-party codec (mirrors the ingest hand-written codec in src/runtime/ingest/grpc-client.ts and the
 * Health-descriptor approach in client.ts). The `.proto` file is the source of truth and
 * `pnpm run openshell:proto:check` guards it against drift.
 *
 * proto3 semantics this codec honours (so the wire matches the gateway exactly):
 *   - a zero/empty SCALAR field is OMITTED on the wire (empty stdin, "" workdir, 0 timeout => no bytes);
 *   - `command` (repeated string) emits ONE field-2 length-delimited entry per element, in order;
 *   - `environment` (map<string,string>) emits ONE field-4 length-delimited submessage per entry
 *     `{ key=1 string, value=2 string }`;
 *   - `ExecSandboxEvent` is a `oneof` — exactly one of stdout(1)/stderr(2)/exit(3), each a
 *     length-delimited submessage. A negative `int32` exit_code is a 10-byte sign-extended varint.
 *
 * pinned rev: f23c2c8e84193beac5c35af8cd80276b60b8dbd4 (v0.0.66) — NVIDIA OpenShell proto/openshell.proto
 */

/** Fully-qualified ExecSandbox method id used on the wire (`/<package>.<service>/<method>`). */
export const EXEC_SANDBOX_METHOD = "/openshell.v1.OpenShell/ExecSandbox";

// --- TS face of the pinned ExecSandbox messages (mirrors client.ts 1:1; the codec owns the wire) -----

/** `ExecSandboxRequest` subset (openshell.subset.proto / openshell.proto:645-672). */
export interface ExecSandboxRequestWire {
  /** sandbox_id = 1 (string). */
  readonly sandboxId: string;
  /** command = 2 (repeated string). */
  readonly command: readonly string[];
  /** workdir = 3 (string, optional). */
  readonly workdir?: string;
  /** environment = 4 (map<string,string>, optional). */
  readonly environment?: Readonly<Record<string, string>>;
  /** timeout_seconds = 5 (uint32, optional; 0 = no timeout). */
  readonly timeoutSeconds?: number;
  /** stdin = 6 (bytes, optional). */
  readonly stdin?: Uint8Array;
}

/** `ExecSandboxStdout` (openshell.proto:675-677). */
export interface ExecSandboxStdout {
  readonly data?: Uint8Array;
}

/** `ExecSandboxStderr` (openshell.proto:680-682). */
export interface ExecSandboxStderr {
  readonly data?: Uint8Array;
}

/** `ExecSandboxExit` (openshell.proto:685-687) — the terminal event carrying the command exit code. */
export interface ExecSandboxExit {
  readonly exitCode?: number;
}

/** `ExecSandboxEvent` (openshell.proto:690-696) — one frame; exactly one oneof variant is set. */
export interface ExecSandboxEvent {
  readonly stdout?: ExecSandboxStdout;
  readonly stderr?: ExecSandboxStderr;
  readonly exit?: ExecSandboxExit;
}

// --- minimal proto3 writer (no third-party codec; mirrors ingest/grpc-client.ts) --------------------

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

function writeString(out: number[], field: number, value: string): void {
  writeLenDelim(out, field, new TextEncoder().encode(value));
}

/** Encode a map<string,string> entry submessage `{ key=1 string, value=2 string }` (proto3 map). */
function encodeMapEntry(key: string, value: string): Uint8Array {
  const out: number[] = [];
  // proto3 zero-value rule: an empty key/value is omitted INSIDE the entry submessage.
  if (key.length > 0) writeString(out, 1, key);
  if (value.length > 0) writeString(out, 2, value);
  return Uint8Array.from(out);
}

/**
 * Encode an `ExecSandboxRequest` to its proto3 message bytes (fields 1..6). proto3 zero/empty scalar
 * values are OMITTED (no `sandbox_id` if "", no `timeout_seconds` if 0, no `stdin` if empty), the
 * `command` repeated string emits one field-2 entry per element IN ORDER, and `environment` emits one
 * field-4 map-entry submessage per key. The tty/cols/rows fields (7/8/9) are out of scope and never
 * emitted.
 */
export function encodeExecSandboxRequest(req: ExecSandboxRequestWire): Buffer {
  const out: number[] = [];
  if (req.sandboxId.length > 0) writeString(out, 1, req.sandboxId); // sandbox_id = 1
  for (const arg of req.command) writeString(out, 2, arg); // command = 2 (repeated, in order)
  if (req.workdir !== undefined && req.workdir.length > 0) writeString(out, 3, req.workdir); // workdir = 3
  if (req.environment !== undefined) {
    for (const [key, value] of Object.entries(req.environment)) {
      writeLenDelim(out, 4, encodeMapEntry(key, value)); // environment = 4 (map entry submessage)
    }
  }
  if (req.timeoutSeconds !== undefined && req.timeoutSeconds !== 0) {
    writeTag(out, 5, 0); // timeout_seconds = 5 (varint)
    writeVarint(out, req.timeoutSeconds);
  }
  if (req.stdin !== undefined && req.stdin.length > 0) writeLenDelim(out, 6, req.stdin); // stdin = 6
  return Buffer.from(out);
}

// --- minimal proto3 reader (no third-party codec; mirrors ingest/grpc-client.ts) --------------------

type Reader = { buf: Uint8Array; pos: number };

/** Read an UNSIGNED varint (used for tags, lengths, and uint32 fields). */
function readVarint(r: Reader): number {
  let result = 0;
  let shift = 1;
  for (;;) {
    const byte = r.buf[r.pos++];
    if (byte === undefined) throw new Error("openshell exec: truncated varint (fail-closed)");
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) break;
    shift *= 128;
  }
  return result;
}

/**
 * Read a SIGNED `int32` varint. proto3 encodes a negative int32 as a 64-bit-sign-extended varint (up to
 * 10 bytes, the high bytes all 1s). We accumulate the low 32 bits and re-interpret them as a signed
 * 32-bit integer, so e.g. a signal-killed command's `-1` decodes back to `-1` (never a fabricated 0).
 */
function readInt32Varint(r: Reader): number {
  let lo = 0;
  let shift = 0;
  for (;;) {
    const byte = r.buf[r.pos++];
    if (byte === undefined) throw new Error("openshell exec: truncated int32 varint (fail-closed)");
    if (shift < 32) lo |= (byte & 0x7f) << shift; // accumulate the low 32 bits (bitwise => int32)
    shift += 7;
    if ((byte & 0x80) === 0) break;
    if (shift > 70) throw new Error("openshell exec: varint too long (fail-closed)");
  }
  return lo | 0; // coerce to a signed 32-bit integer.
}

function readLenDelim(r: Reader): Uint8Array {
  const len = readVarint(r);
  const start = r.pos;
  r.pos += len;
  if (r.pos > r.buf.length) {
    throw new Error("openshell exec: truncated length-delimited field (fail-closed)");
  }
  return r.buf.subarray(start, r.pos);
}

/** Skip one field of `wireType` (so an unknown future field never derails the decode). */
function skipField(r: Reader, wireType: number): void {
  if (wireType === 0) {
    readVarint(r);
  } else if (wireType === 2) {
    readLenDelim(r);
  } else if (wireType === 5) {
    r.pos += 4; // 32-bit
  } else if (wireType === 1) {
    r.pos += 8; // 64-bit
  } else {
    throw new Error("openshell exec: unsupported wire type (fail-closed)");
  }
  if (r.pos > r.buf.length) throw new Error("openshell exec: truncated field (fail-closed)");
}

/** Decode an `ExecSandboxExit { exit_code=1 int32 }` submessage. A missing field defaults to 0. */
function decodeExecSandboxExit(bytes: Uint8Array): ExecSandboxExit {
  const r: Reader = { buf: bytes, pos: 0 };
  let exitCode = 0; // proto3 zero value when omitted.
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 0x7;
    if (field === 1 && wireType === 0) exitCode = readInt32Varint(r);
    else skipField(r, wireType);
  }
  return { exitCode };
}

/** Decode an `ExecSandboxStdout`/`ExecSandboxStderr { data=1 bytes }` submessage (copies the bytes). */
function decodeBytesField(bytes: Uint8Array): { data: Uint8Array } {
  const r: Reader = { buf: bytes, pos: 0 };
  let data = new Uint8Array();
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 0x7;
    // Copy the chunk out of the shared buffer so the event owns an independent slice.
    if (field === 1 && wireType === 2) data = Uint8Array.from(readLenDelim(r));
    else skipField(r, wireType);
  }
  return { data };
}

/**
 * Decode one `ExecSandboxEvent` from its proto3 message bytes (the `oneof payload`): stdout=1 / stderr=2 /
 * exit=3, each a length-delimited submessage. The LAST-set variant wins (proto3 oneof semantics); the
 * caller (adapter / transport) validates that exactly one is present and fails closed otherwise. A
 * truncated/garbled frame THROWS (fail-closed; never silently treated as a partial success).
 */
export function decodeExecSandboxEvent(bytes: Uint8Array): ExecSandboxEvent {
  const r: Reader = { buf: bytes, pos: 0 };
  let stdout: ExecSandboxStdout | undefined;
  let stderr: ExecSandboxStderr | undefined;
  let exit: ExecSandboxExit | undefined;
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 0x7;
    if (field === 1 && wireType === 2) {
      stdout = decodeBytesField(readLenDelim(r));
      stderr = undefined;
      exit = undefined; // proto3 oneof: setting one clears the others.
    } else if (field === 2 && wireType === 2) {
      stderr = decodeBytesField(readLenDelim(r));
      stdout = undefined;
      exit = undefined;
    } else if (field === 3 && wireType === 2) {
      exit = decodeExecSandboxExit(readLenDelim(r));
      stdout = undefined;
      stderr = undefined;
    } else {
      skipField(r, wireType);
    }
  }
  return {
    ...(stdout !== undefined ? { stdout } : {}),
    ...(stderr !== undefined ? { stderr } : {}),
    ...(exit !== undefined ? { exit } : {}),
  };
}
