/**
 * The real SpendGuard `LedgerTransport` — grpc-js over a Unix Domain Socket (slice P2R-R11-S6).
 *
 * This is the SINGLE chokepoint where the runtime RPC vendor (@grpc/grpc-js) AND the SpendGuard
 * generated stub are named for the cost path. It lives under src/runtime/spendguard/ (NOT core), so
 * the `no-vendor-in-core` + `not-to-internal` boundaries (.dependency-cruiser.cjs) stay intact: the
 * SpendGuardCostGate (src/cost/adapters/spendguard/adapter.ts) keeps seeing only the injected
 * vendor-neutral `LedgerTransport` port, and no core module imports grpc-js or the stub.
 *
 * Responsibility (and ONLY this): bridge the `LedgerTransport` port to SpendGuard's `SidecarAdapter`
 * gRPC contract over `unix://<udsPath>` (services/sidecar/src/config.rs:243 default
 * /var/run/spendguard/adapter.sock; SO_PEERCRED peer-uid fail-closed config.rs:114-120):
 *   - reserve -> ReserveSession (adapter.proto:124): an `accepted` oneof -> {reservationId}; a
 *     `denied` outcome (over-budget hard-cap) -> {overBudget:true}.
 *   - commit  -> CommitSessionDelta (adapter.proto:129): an `accepted` oneof -> {overrun:false}; an
 *     OVERRUN_RESERVATION `error` outcome -> {overrun:true} (the provider was already hit — the real
 *     spend is recorded, never erased; adapter.ts:13-16, port.ts:30-36).
 *
 * FAIL-CLOSED (AGENTS.md deny-by-default; OVERRIDES SpendGuard's predictor fail-OPEN, adapter.ts:18-21):
 * a gRPC status error — a refused connection, a DEADLINE_EXCEEDED, a SO_PEERCRED reject — OR an
 * empty/unexpected oneof ALL surface as a REJECT. There is NO path that resolves a falsy success; the
 * adapter's catch turns a reject into denyReserve/denyCommit (adapter.ts:100-107 / :142-143).
 *
 * CREDENTIAL-BLIND: the wire request carries ONLY tenant_id + the atomic amount + route — never a
 * credential (the `LedgerReserveReq`/`LedgerCommitReq` port shapes have no credential field by
 * construction, adapter.ts:46-58; this transport adds none).
 *
 * The S5 stub is types-only (no codec), so — mirroring the ingest grpc client
 * (src/runtime/ingest/grpc-client.ts) — this module hand-writes the minimal proto3 wire codecs for the
 * two messages it speaks. Construction of the live channel is exercised by the in-process fake UDS
 * server in transport.test.ts; the live e2e against a real SpendGuard sidecar is R11-S7.
 */
import { type ChannelCredentials, Client, type ServiceError, credentials } from "@grpc/grpc-js";
import type {
  LedgerCommitReq,
  LedgerReserveReq,
  LedgerTransport,
} from "../../cost/adapters/spendguard/index.js";
import type {
  CommitSessionDeltaOutcome,
  CommitSessionDeltaRequest,
  ReserveSessionOutcome,
  ReserveSessionRequest,
} from "./_generated/sidecar_adapter.js";

const SERVICE = "/spendguard.sidecar_adapter.v1.SidecarAdapter";
const RESERVE_METHOD = `${SERVICE}/ReserveSession`;
const COMMIT_METHOD = `${SERVICE}/CommitSessionDelta`;

/** OVERRUN_RESERVATION (sidecar_adapter.subset.proto Error.Code:15). A committed delta that overshot. */
const ERROR_CODE_OVERRUN_RESERVATION = 15;

/** Default per-call deadline. A slow/hung sidecar fails CLOSED, never hangs the agent forever. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Exported service descriptor name so callers/tests share one source of truth for the gRPC path. */
export const SIDECAR_ADAPTER_SERVICE = SERVICE;

export interface SidecarLedgerTransportOpts {
  /**
   * Unix Domain Socket path to the SpendGuard sidecar adapter (e.g. /var/run/spendguard/adapter.sock).
   * A `unix://<udsPath>` channel is built; SO_PEERCRED is enforced server-side (config.rs:114-120).
   */
  readonly udsPath: string;
  /** Per-call deadline; on expiry the call REJECTS (fail-closed). Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Build a `LedgerTransport` that speaks real grpc-js to SpendGuard's `SidecarAdapter` over the UDS.
 * Every transport failure REJECTS (fail-closed); a served `accepted`/`denied` maps onto the
 * vendor-neutral port shape. The adapter's catch converts a reject into a deny.
 */
export function createSidecarLedgerTransport(opts: SidecarLedgerTransportOpts): LedgerTransport {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const insecure: ChannelCredentials = credentials.createInsecure();
  const client = new Client(`unix://${opts.udsPath}`, insecure);

  function unary<Resp>(
    method: string,
    serialize: (value: Buffer) => Buffer,
    deserialize: (bytes: Buffer) => Resp,
    requestBytes: Buffer,
  ): Promise<Resp> {
    const deadline = new Date(Date.now() + timeoutMs);
    return new Promise<Resp>((resolve, reject) => {
      try {
        client.makeUnaryRequest(
          method,
          (b: Buffer) => serialize(b),
          (b: Buffer) => b,
          requestBytes,
          { deadline },
          (err: ServiceError | null, value?: Buffer) => {
            if (err !== null) {
              reject(err);
              return;
            }
            if (value === undefined) {
              reject(new Error(`${method}: missing RPC response (fail-closed)`));
              return;
            }
            try {
              resolve(deserialize(value));
            } catch (decodeErr) {
              reject(decodeErr instanceof Error ? decodeErr : new Error(String(decodeErr)));
            }
          },
        );
      } catch (syncErr) {
        reject(syncErr instanceof Error ? syncErr : new Error(String(syncErr)));
      }
    });
  }

  return {
    async reserve(
      req: LedgerReserveReq,
    ): Promise<{ reservationId: string } | { overBudget: true }> {
      const wire = encodeReserveSessionRequest({
        tenantId: req.tenant_id,
        budgetId: "",
        windowInstanceId: "",
        unit: undefined,
        pricing: undefined,
        sessionId: "",
        route: req.route,
        estimatedAmountAtomic: atomicToWire(req.estimated_amount_atomic),
        ttlSeconds: 0,
        idempotencyKey: "",
      });
      const outcome = await unary(RESERVE_METHOD, (b) => b, decodeReserveSessionOutcome, wire);
      const o = outcome.outcome;
      if (o === undefined) {
        // Empty/unexpected oneof — fail CLOSED, never resolve a falsy success.
        throw new Error("ReserveSession: empty/unexpected outcome (fail-closed)");
      }
      if (o.$case === "accepted") {
        return { reservationId: o.accepted.sessionReservationId };
      }
      if (o.$case === "denied") {
        // Over-budget hard-cap: a runaway agent cannot bankrupt a tenant (port.ts:7-9).
        return { overBudget: true };
      }
      // An `error` outcome on reserve is a transport-level failure → fail CLOSED.
      throw new Error("ReserveSession: error outcome (fail-closed)");
    },

    async commit(req: LedgerCommitReq): Promise<{ overrun: boolean }> {
      const wire = encodeCommitSessionDeltaRequest({
        sessionReservationId: req.reservation_id,
        streamingCommitId: "",
        amountAtomicDelta: atomicToWire(req.amount_atomic_delta),
        outcome: 1 /* SUCCESS */,
        eventTime: undefined,
        idempotencyKey: "",
      });
      const outcome = await unary(COMMIT_METHOD, (b) => b, decodeCommitSessionDeltaOutcome, wire);
      const o = outcome.outcome;
      if (o === undefined) {
        throw new Error("CommitSessionDelta: empty/unexpected outcome (fail-closed)");
      }
      if (o.$case === "accepted") {
        return { overrun: false };
      }
      // An OVERRUN_RESERVATION error is the recorded in-flight overrun (the provider was already hit;
      // the real spend cannot be erased). Any OTHER error outcome is a genuine transport failure.
      if (o.error.code === ERROR_CODE_OVERRUN_RESERVATION) {
        return { overrun: true };
      }
      throw new Error(`CommitSessionDelta: error outcome code=${o.error.code} (fail-closed)`);
    },
  };
}

/**
 * Atomic amounts are proto3 strings on the wire (sidecar_adapter.subset.proto:129/161). The port
 * carries a non-negative integer; render it as a base-10 string. A non-finite/negative value is a
 * caller bug → throw (fail-closed; never silently send a bogus amount).
 */
function atomicToWire(amount: number): string {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`atomic amount must be a non-negative integer, got ${amount} (fail-closed)`);
  }
  return String(amount);
}

// --- minimal proto3 wire codecs (the S5 stub is types-only; mirrors ingest/grpc-client.ts) ----------

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

function writeString(out: number[], field: number, value: string): void {
  if (value.length === 0) return;
  const bytes = new TextEncoder().encode(value);
  writeTag(out, field, 2);
  writeVarint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

function writeLenDelim(out: number[], field: number, bytes: Uint8Array): void {
  writeTag(out, field, 2);
  writeVarint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

function writeUint32(out: number[], field: number, value: number): void {
  if (value === 0) return;
  writeTag(out, field, 0);
  writeVarint(out, value);
}

function writeEnum(out: number[], field: number, value: number): void {
  if (value === 0) return;
  writeTag(out, field, 0);
  writeVarint(out, value);
}

function encodeReserveSessionRequest(req: ReserveSessionRequest): Buffer {
  const out: number[] = [];
  writeString(out, 1, req.tenantId);
  writeString(out, 7, req.route);
  writeString(out, 8, req.estimatedAmountAtomic);
  writeUint32(out, 9, req.ttlSeconds);
  // budget_id / window_instance_id / unit / pricing / session_id / idempotency_key intentionally
  // omitted — the credential-blind reserve carries ONLY tenant + amount + route (adapter.ts:46-51).
  return Buffer.from(out);
}

function encodeCommitSessionDeltaRequest(req: CommitSessionDeltaRequest): Buffer {
  const out: number[] = [];
  writeString(out, 1, req.sessionReservationId);
  writeString(out, 3, req.amountAtomicDelta);
  writeEnum(out, 4, req.outcome);
  return Buffer.from(out);
}

type Reader = { buf: Uint8Array; pos: number };

function readVarint(r: Reader): number {
  let result = 0;
  let shift = 1;
  for (;;) {
    const byte = r.buf[r.pos++];
    if (byte === undefined) throw new Error("truncated varint (fail-closed)");
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
  if (r.pos > r.buf.length) throw new Error("truncated length-delimited field (fail-closed)");
  return r.buf.subarray(start, r.pos);
}

/** Skip a field whose tag we do not decode, advancing the reader past its value. */
function skipField(r: Reader, wireType: number): void {
  if (wireType === 0) {
    readVarint(r);
  } else if (wireType === 2) {
    readLenDelim(r);
  } else if (wireType === 5) {
    r.pos += 4;
  } else if (wireType === 1) {
    r.pos += 8;
  } else {
    throw new Error(`unsupported wire type ${wireType} (fail-closed)`);
  }
  if (r.pos > r.buf.length) throw new Error("truncated field while skipping (fail-closed)");
}

function decodeReserveSessionAccepted(bytes: Uint8Array): { sessionReservationId: string } {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  let sessionReservationId = "";
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) sessionReservationId = dec.decode(readLenDelim(r));
    else skipField(r, wireType);
  }
  return { sessionReservationId };
}

function decodeReserveSessionOutcome(bytes: Buffer): ReserveSessionOutcome {
  const r: Reader = { buf: bytes, pos: 0 };
  let outcome: ReserveSessionOutcome["outcome"];
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) {
      const acc = decodeReserveSessionAccepted(readLenDelim(r));
      outcome = {
        $case: "accepted",
        accepted: {
          sessionReservationId: acc.sessionReservationId,
          ledgerTransactionId: "",
          auditSessionEventId: "",
          ttlExpiresAt: undefined,
          reservedAmountAtomic: "",
          remainingAmountAtomic: "",
        },
      };
    } else if (field === 2 && wireType === 2) {
      readLenDelim(r); // denied — we only need its presence, not its fields.
      outcome = {
        $case: "denied",
        denied: {
          auditSessionEventId: "",
          reasonCodes: [],
          matchedRuleIds: [],
          error: undefined,
        },
      };
    } else if (field === 3 && wireType === 2) {
      readLenDelim(r); // error — presence is enough to fail closed.
      outcome = { $case: "error", error: { code: 0, message: "", details: {} } };
    } else {
      skipField(r, wireType);
    }
  }
  return { outcome };
}

function decodeError(bytes: Uint8Array): { code: number } {
  const r: Reader = { buf: bytes, pos: 0 };
  let code = 0;
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 0) code = readVarint(r);
    else skipField(r, wireType);
  }
  return { code };
}

function decodeCommitSessionDeltaOutcome(bytes: Buffer): CommitSessionDeltaOutcome {
  const r: Reader = { buf: bytes, pos: 0 };
  let outcome: CommitSessionDeltaOutcome["outcome"];
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) {
      readLenDelim(r); // accepted — presence means the delta was recorded with no overrun.
      outcome = {
        $case: "accepted",
        accepted: {
          sessionReservationId: "",
          streamingCommitId: "",
          ledgerTransactionId: "",
          auditSessionEventId: "",
          committedDeltaAtomic: "",
          cumulativeCommittedAtomic: "",
          remainingAmountAtomic: "",
          recordedAt: undefined,
        },
      };
    } else if (field === 2 && wireType === 2) {
      const err = decodeError(readLenDelim(r));
      outcome = { $case: "error", error: { code: err.code, message: "", details: {} } };
    } else {
      skipField(r, wireType);
    }
  }
  return { outcome };
}

// --- test-only codec exports (the in-process fake UDS server reuses these wire codecs) ---------------
// Exported so transport.test.ts's fake `SidecarAdapter` server speaks the SAME wire format the
// transport speaks, proving a real round-trip rather than a mocked client.

/** @internal test-only: decode a `ReserveSessionRequest` from the wire (fake server side). */
export function decodeReserveSessionRequestForTest(bytes: Buffer): ReserveSessionRequest {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  const out: ReserveSessionRequest = {
    tenantId: "",
    budgetId: "",
    windowInstanceId: "",
    unit: undefined,
    pricing: undefined,
    sessionId: "",
    route: "",
    estimatedAmountAtomic: "",
    ttlSeconds: 0,
    idempotencyKey: "",
  };
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) out.tenantId = dec.decode(readLenDelim(r));
    else if (field === 7 && wireType === 2) out.route = dec.decode(readLenDelim(r));
    else if (field === 8 && wireType === 2) out.estimatedAmountAtomic = dec.decode(readLenDelim(r));
    else if (field === 9 && wireType === 0) out.ttlSeconds = readVarint(r);
    else skipField(r, wireType);
  }
  return out;
}

/** @internal test-only: decode a `CommitSessionDeltaRequest` from the wire (fake server side). */
export function decodeCommitSessionDeltaRequestForTest(bytes: Buffer): CommitSessionDeltaRequest {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  const out: CommitSessionDeltaRequest = {
    sessionReservationId: "",
    streamingCommitId: "",
    amountAtomicDelta: "",
    outcome: 0,
    eventTime: undefined,
    idempotencyKey: "",
  };
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) out.sessionReservationId = dec.decode(readLenDelim(r));
    else if (field === 3 && wireType === 2) out.amountAtomicDelta = dec.decode(readLenDelim(r));
    else if (field === 4 && wireType === 0) out.outcome = readVarint(r);
    else skipField(r, wireType);
  }
  return out;
}

/** @internal test-only: encode a `ReserveSessionOutcome` to the wire (fake server side). */
export function encodeReserveSessionOutcomeForTest(outcome: ReserveSessionOutcome): Buffer {
  const out: number[] = [];
  const o = outcome.outcome;
  if (o === undefined) return Buffer.from(out);
  if (o.$case === "accepted") {
    const inner: number[] = [];
    writeString(inner, 1, o.accepted.sessionReservationId);
    writeLenDelim(out, 1, Buffer.from(inner));
  } else if (o.$case === "denied") {
    const inner: number[] = [];
    for (const rc of o.denied.reasonCodes) writeString(inner, 2, rc);
    writeLenDelim(out, 2, Buffer.from(inner));
  } else {
    const inner: number[] = [];
    writeEnum(inner, 1, o.error.code);
    writeLenDelim(out, 3, Buffer.from(inner));
  }
  return Buffer.from(out);
}

/** @internal test-only: encode a `CommitSessionDeltaOutcome` to the wire (fake server side). */
export function encodeCommitSessionDeltaOutcomeForTest(outcome: CommitSessionDeltaOutcome): Buffer {
  const out: number[] = [];
  const o = outcome.outcome;
  if (o === undefined) return Buffer.from(out);
  if (o.$case === "accepted") {
    const inner: number[] = [];
    writeString(inner, 1, o.accepted.sessionReservationId);
    writeLenDelim(out, 1, Buffer.from(inner));
  } else {
    const inner: number[] = [];
    writeEnum(inner, 1, o.error.code);
    writeLenDelim(out, 2, Buffer.from(inner));
  }
  return Buffer.from(out);
}
