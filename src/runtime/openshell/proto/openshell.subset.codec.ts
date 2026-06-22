/**
 * Hand-written proto3 wire codecs for the PINNED OpenShell subset — `ExecSandbox` (slice SLICE-OS-S1)
 * + the unary sandbox lifecycle CreateSandbox / GetSandbox / DeleteSandbox (slice SLICE-OS-S2a).
 *
 * SINGLE responsibility: serialize the requests + parse the replies byte-for-byte against the vendored
 * subset (openshell.subset.proto, v0.0.66). It mirrors the proto 1:1 — there is NO third-party codec
 * (mirrors the ingest hand-written codec in src/runtime/ingest/grpc-client.ts and the Health-descriptor
 * approach in client.ts). The `.proto` file is the source of truth and `pnpm run openshell:proto:check`
 * guards it against drift. The lifecycle codecs encode/decode ONLY the fields we consume
 * (CreateSandboxRequest spec.template.image/name/labels; SandboxResponse metadata id/name + status
 * phase=6; DeleteSandboxResponse deleted); every other upstream field is SKIPPED (forward-compatible).
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

/** Fully-qualified unary lifecycle method ids (slice SLICE-OS-S2a). */
export const CREATE_SANDBOX_METHOD = "/openshell.v1.OpenShell/CreateSandbox";
export const GET_SANDBOX_METHOD = "/openshell.v1.OpenShell/GetSandbox";
export const DELETE_SANDBOX_METHOD = "/openshell.v1.OpenShell/DeleteSandbox";

/** Fully-qualified WatchSandbox server-streaming method id (slice SLICE-OS-S2b). */
export const WATCH_SANDBOX_METHOD = "/openshell.v1.OpenShell/WatchSandbox";

// --- TS face of the pinned lifecycle messages (slice SLICE-OS-S2a; the codec owns the wire) ----------
//
// PARTIAL by design: only the fields we encode/decode are typed. The decoders SKIP every unknown field
// (forward-compatible) and read only the nested fields we consume.

/** `SandboxTemplate` subset — the pinned boot image lives here (template.image = 1). */
export interface SandboxTemplateWire {
  readonly image: string;
}

/** `SandboxSpec` subset — we encode ONLY `template` (= field 6). */
export interface SandboxSpecWire {
  readonly template: SandboxTemplateWire;
}

/** `CreateSandboxRequest` subset (spec=1, name=2, labels=3). */
export interface CreateSandboxRequestWire {
  readonly spec: SandboxSpecWire;
  /** Optional caller-supplied name; empty => the gateway generates one (proto3 zero omitted). */
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

/** `ObjectMeta` subset (datamodel.proto) — id=1, name=2. */
export interface ObjectMetaWire {
  readonly id?: string;
  readonly name?: string;
}

/** `SandboxStatus` subset — phase=6 (NOTE: field 6, NOT 1). */
export interface SandboxStatusWire {
  readonly phase?: number;
}

/** `Sandbox` subset — metadata=1, status=3 (spec=2 is skipped). */
export interface SandboxWire {
  readonly metadata?: ObjectMetaWire;
  readonly status?: SandboxStatusWire;
}

/** `SandboxResponse` — sandbox=1. */
export interface SandboxResponseWire {
  readonly sandbox?: SandboxWire;
}

/** `GetSandboxRequest` — name=1. */
export interface GetSandboxRequestWire {
  readonly name: string;
}

/** `DeleteSandboxRequest` — name=1. */
export interface DeleteSandboxRequestWire {
  readonly name: string;
}

/** `DeleteSandboxResponse` — deleted=1 bool. */
export interface DeleteSandboxResponseWire {
  readonly deleted?: boolean;
}

// --- TS face of the pinned WatchSandbox messages (slice SLICE-OS-S2b; the codec owns the wire) -------

/**
 * `WatchSandboxRequest` subset — we ENCODE ONLY the 3 readiness-relevant fields (id=1, follow_status=2,
 * stop_on_terminal=7). The log/event-following fields are out of scope and never emitted.
 */
export interface WatchSandboxRequestWire {
  /** id = 1 (string). */
  readonly id: string;
  /** follow_status = 2 (bool, optional; omitted as the proto3 zero when false/absent). */
  readonly followStatus?: boolean;
  /** stop_on_terminal = 7 (bool, optional; omitted as the proto3 zero when false/absent). */
  readonly stopOnTerminal?: boolean;
}

/**
 * `SandboxStreamEvent` subset — we DECODE ONLY the `sandbox` (=1) snapshot (reusing the OS-S2a
 * Sandbox/ObjectMeta/SandboxStatus decode). A non-sandbox oneof variant (log=2 / event=3 / warning=4 /
 * draft_policy_update=5) OR any unknown field is SKIPPED, yielding `{ sandbox: undefined }`
 * (forward-compatible — never a fabricated READY).
 */
export interface SandboxStreamEventWire {
  readonly sandbox?: SandboxWire;
}

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

// --- lifecycle encoders (slice SLICE-OS-S2a) --------------------------------------------------------

/**
 * Encode a `CreateSandboxRequest` to its proto3 message bytes. We encode ONLY the fields we use:
 *   spec (=1) -> SandboxSpec{ template (=6) -> SandboxTemplate{ image (=1) string } },
 *   name (=2, omitted when empty — proto3 zero),
 *   labels (=3, one map-entry submessage per key in insertion order).
 * No other SandboxSpec field (policy / providers / gpu / env) is emitted — the gateway does not
 * require policy for a minimal create (empirically confirmed).
 */
export function encodeCreateSandboxRequest(req: CreateSandboxRequestWire): Buffer {
  // SandboxTemplate { image = 1 }.
  const template: number[] = [];
  if (req.spec.template.image.length > 0) writeString(template, 1, req.spec.template.image);
  // SandboxSpec { template = 6 } — always present (even if the template is empty, the field is set).
  const spec: number[] = [];
  writeLenDelim(spec, 6, Uint8Array.from(template));

  const out: number[] = [];
  writeLenDelim(out, 1, Uint8Array.from(spec)); // CreateSandboxRequest.spec = 1
  if (req.name !== undefined && req.name.length > 0) writeString(out, 2, req.name); // name = 2
  if (req.labels !== undefined) {
    for (const [key, value] of Object.entries(req.labels)) {
      writeLenDelim(out, 3, encodeMapEntry(key, value)); // labels = 3 (map entry submessage)
    }
  }
  return Buffer.from(out);
}

/** Encode a `GetSandboxRequest { name = 1 }` (name omitted when empty — proto3 zero). */
export function encodeGetSandboxRequest(req: GetSandboxRequestWire): Buffer {
  const out: number[] = [];
  if (req.name.length > 0) writeString(out, 1, req.name);
  return Buffer.from(out);
}

/** Encode a `DeleteSandboxRequest { name = 1 }` (name omitted when empty — proto3 zero). */
export function encodeDeleteSandboxRequest(req: DeleteSandboxRequestWire): Buffer {
  const out: number[] = [];
  if (req.name.length > 0) writeString(out, 1, req.name);
  return Buffer.from(out);
}

// --- lifecycle decoders (slice SLICE-OS-S2a) — read ONLY the consumed fields; SKIP everything else ---

/** Read a length-delimited string field's bytes as UTF-8. */
function readString(r: Reader): string {
  return new TextDecoder().decode(readLenDelim(r));
}

/** Decode an `ObjectMeta { id=1 string, name=2 string }`; other fields are skipped. */
function decodeObjectMeta(bytes: Uint8Array): ObjectMetaWire {
  const r: Reader = { buf: bytes, pos: 0 };
  let id: string | undefined;
  let name: string | undefined;
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 0x7;
    if (field === 1 && wireType === 2) id = readString(r);
    else if (field === 2 && wireType === 2) name = readString(r);
    else skipField(r, wireType);
  }
  return {
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

/** Decode a `SandboxStatus { phase=6 enum (varint) }`; other fields are skipped. */
function decodeSandboxStatus(bytes: Uint8Array): SandboxStatusWire {
  const r: Reader = { buf: bytes, pos: 0 };
  let phase: number | undefined;
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 0x7;
    // SandboxStatus.phase is field 6 (NOT 1) per openshell.proto v0.0.66; an enum is a varint.
    if (field === 6 && wireType === 0) phase = readVarint(r);
    else skipField(r, wireType);
  }
  return phase !== undefined ? { phase } : {};
}

/** Decode a `Sandbox { metadata=1, status=3 }`; spec (=2) and unknown fields are skipped. */
function decodeSandbox(bytes: Uint8Array): SandboxWire {
  const r: Reader = { buf: bytes, pos: 0 };
  let metadata: ObjectMetaWire | undefined;
  let status: SandboxStatusWire | undefined;
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 0x7;
    if (field === 1 && wireType === 2) metadata = decodeObjectMeta(readLenDelim(r));
    else if (field === 3 && wireType === 2) status = decodeSandboxStatus(readLenDelim(r));
    else skipField(r, wireType);
  }
  return {
    ...(metadata !== undefined ? { metadata } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

/**
 * Decode a `SandboxResponse { sandbox=1 }` (shared by CreateSandbox / GetSandbox). An absent sandbox
 * (empty wire) decodes to `{}` — the adapter treats that as deny-by-default (no name => deny).
 */
export function decodeSandboxResponse(bytes: Uint8Array): SandboxResponseWire {
  const r: Reader = { buf: bytes, pos: 0 };
  let sandbox: SandboxWire | undefined;
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 0x7;
    if (field === 1 && wireType === 2) sandbox = decodeSandbox(readLenDelim(r));
    else skipField(r, wireType);
  }
  return sandbox !== undefined ? { sandbox } : {};
}

/** Decode a `DeleteSandboxResponse { deleted=1 bool }`. An absent field is the proto3 zero (false). */
export function decodeDeleteSandboxResponse(bytes: Uint8Array): DeleteSandboxResponseWire {
  const r: Reader = { buf: bytes, pos: 0 };
  let deleted = false; // proto3 zero when omitted.
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 0x7;
    if (field === 1 && wireType === 0) deleted = readVarint(r) !== 0;
    else skipField(r, wireType);
  }
  return { deleted };
}

// --- WatchSandbox codec (slice SLICE-OS-S2b) --------------------------------------------------------

/**
 * Encode a `WatchSandboxRequest` to its proto3 message bytes — ONLY the 3 readiness-relevant fields:
 *   id (=1, string; omitted when empty — proto3 zero),
 *   follow_status (=2, bool varint; omitted when false/absent — proto3 zero),
 *   stop_on_terminal (=7, bool varint; omitted when false/absent — proto3 zero).
 * The adapter's `WatchSandboxRequest` always sets follow_status=true + stop_on_terminal=true, so a
 * live watch faithfully tells the gateway to stream status snapshots and close on a terminal phase.
 * The log/event-following fields (3/4/5/6/8/9/10) are out of scope and never emitted.
 */
export function encodeWatchSandboxRequest(req: WatchSandboxRequestWire): Buffer {
  const out: number[] = [];
  if (req.id.length > 0) writeString(out, 1, req.id); // id = 1
  if (req.followStatus === true) {
    writeTag(out, 2, 0); // follow_status = 2 (bool varint)
    writeVarint(out, 1);
  }
  if (req.stopOnTerminal === true) {
    writeTag(out, 7, 0); // stop_on_terminal = 7 (bool varint)
    writeVarint(out, 1);
  }
  return Buffer.from(out);
}

/**
 * Decode one `SandboxStreamEvent` from its proto3 message bytes (the `oneof payload`). We read ONLY the
 * `sandbox` (=1) snapshot, REUSING {@link decodeSandbox} (the OS-S2a Sandbox/ObjectMeta/SandboxStatus
 * decode) so a watch snapshot yields the SAME `{ metadata?, status?:{phase?} }` shape as GetSandbox.
 * The other oneof variants — log (=2), event (=3), warning (=4), draft_policy_update (=5) — and ANY
 * unknown future field are SKIPPED (forward-compatible): a non-sandbox event yields `{ sandbox:
 * undefined }`, which the adapter treats as no readiness signal (NEVER a fabricated READY). proto3
 * oneof semantics: the LAST-set variant wins, so a later `sandbox` overrides an earlier non-sandbox
 * variant (and vice versa).
 */
export function decodeSandboxStreamEvent(bytes: Uint8Array): SandboxStreamEventWire {
  const r: Reader = { buf: bytes, pos: 0 };
  let sandbox: SandboxWire | undefined;
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 0x7;
    if (field === 1 && wireType === 2) {
      sandbox = decodeSandbox(readLenDelim(r)); // oneof payload.sandbox = 1 (REUSE the Sandbox decode).
    } else {
      // A non-sandbox oneof variant (log/event/warning/draft_policy) OR an unknown field. proto3 oneof:
      // a non-sandbox variant CLEARS the oneof, so a prior sandbox snapshot must be dropped (last wins).
      if (field >= 2 && field <= 5 && wireType === 2) sandbox = undefined;
      skipField(r, wireType);
    }
  }
  return sandbox !== undefined ? { sandbox } : {};
}
