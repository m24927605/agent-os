/**
 * The RequestDecision-based SpendGuard `LedgerTransport` — grpc-js over a UDS (slice P2R-R11-S8).
 *
 * R11-S7 GROUND TRUTH: the demo sidecar's session RPCs (ReserveSession / CommitSessionDelta) are
 * `Err(Status::unimplemented)` (services/sidecar/src/server/adapter_uds.rs:142-173). The flow the demo
 * ACTUALLY serves is Handshake (:73) -> RequestDecision (:82, request_decision_inner:312 ->
 * run_through_reserve:370) -> ConfirmPublishOutcome (:91). This transport maps the vendor-neutral
 * `LedgerTransport` seam (src/cost/adapters/spendguard/adapter.ts:65-68) onto THAT flow, so the
 * SpendGuardCostGate can get a live proof against the real demo in S9 — while S6's session transport
 * (createSidecarLedgerTransport) stays valid for whenever the vendor lands the session bridge.
 *
 * Like S6's transport, this is a CHOKEPOINT for the runtime RPC vendor (@grpc/grpc-js) + the generated
 * stub — confined to src/runtime/spendguard/ so the `no-vendor-in-core` + `not-to-internal` boundaries
 * stay intact (no core module imports grpc-js or the stub; the gate sees only the injected port).
 *
 * Mapping:
 *   - reserve -> Handshake (lazy, once per transport; obtains session_id, adapter_uds.rs:73) then
 *     RequestDecision(trigger=LLM_CALL_PRE, route=req.route, projected cost from
 *     req.estimated_amount_atomic rendered into Inputs.projected_p50/p90/p95/p99_atomic). The served
 *     DecisionResponse.decision:
 *       CONTINUE (proto:429)                     -> {reservationId: decision_id}
 *       STOP / STOP_RUN_PROJECTION (proto:432/452, per-call / run budget hard-cap) -> {overBudget:true}
 *       DEGRADE / SKIP / REQUIRE_APPROVAL / UNSPECIFIED / unknown enum -> THROW (deny-by-default;
 *         proto:448 mandates unknown enum fails closed). An empty/missing decision_id on CONTINUE is
 *         also a THROW (no usable reservation handle).
 *   - commit -> ConfirmPublishOutcome(decision_id = reservation_id, outcome=APPLIED). A clean response
 *     -> {overrun:false}; a populated `error` -> THROW.
 *
 * FAIL-CLOSED (AGENTS.md deny-by-default; OVERRIDES SpendGuard's predictor fail-OPEN): a gRPC status
 * error (refused connection, DEADLINE_EXCEEDED, peercred reject), an empty/unexpected response, OR any
 * non-CONTINUE / non-STOP decision ALL surface as a REJECT. There is NO path that resolves a falsy
 * success; the adapter's catch turns a reject into denyReserve/denyCommit (adapter.ts:100-107/:142-143).
 *
 * CREDENTIAL-BLIND: the DecisionRequest carries ONLY the cost projection + route + session id (the
 * `LedgerReserveReq` port shape has no credential field by construction, adapter.ts:46-51; this
 * transport adds none, and runtime_metadata is never populated). The handshake sends only a static
 * runtime descriptor + tenant assertion — never a secret.
 *
 * The S5 stub is types-only (no codec), so — mirroring transport.ts (S6) + ingest/grpc-client.ts —
 * this module hand-writes the minimal proto3 wire codecs for the messages it speaks. The in-process
 * fake UDS server in decision-transport.test.ts exercises a real round-trip; the live e2e against a
 * real SpendGuard sidecar is R11-S9.
 */
import { randomUUID } from "node:crypto";
import { type ChannelCredentials, Client, type ServiceError, credentials } from "@grpc/grpc-js";
import type {
  LedgerCommitReq,
  LedgerReserveReq,
  LedgerTransport,
} from "../../cost/adapters/spendguard/index.js";
import {
  type DecisionRequest,
  type DecisionRequest_Inputs,
  DecisionRequest_Trigger,
  type DecisionResponse,
  DecisionResponse_Decision,
  type HandshakeRequest,
  type HandshakeResponse,
  type PublishOutcomeRequest,
  PublishOutcomeRequest_Outcome,
  type PublishOutcomeResponse,
} from "./_generated/sidecar_adapter.js";

const SERVICE = "/spendguard.sidecar_adapter.v1.SidecarAdapter";
const HANDSHAKE_METHOD = `${SERVICE}/Handshake`;
const DECISION_METHOD = `${SERVICE}/RequestDecision`;
const CONFIRM_METHOD = `${SERVICE}/ConfirmPublishOutcome`;

/** Default per-call deadline. A slow/hung sidecar fails CLOSED, never hangs the agent forever. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** protocol_version 1 for this spec (adapter.proto:209). */
const PROTOCOL_VERSION = 1;

/** Static, credential-FREE runtime descriptor sent on the mandatory handshake. NO secret here. */
const HANDSHAKE_REQUEST: HandshakeRequest = {
  sdkVersion: "agent-os/0",
  runtimeKind: "agent-os",
  runtimeVersion: "0",
  tenantIdAssertion: "",
  protocolVersion: PROTOCOL_VERSION,
};

/** Exported service descriptor name so callers/tests share one source of truth for the gRPC path. */
export const DECISION_SIDECAR_ADAPTER_SERVICE = SERVICE;

export interface DecisionLedgerTransportOpts {
  /**
   * Unix Domain Socket path to the SpendGuard sidecar adapter (e.g. /var/run/spendguard/adapter.sock).
   * A `unix://<udsPath>` channel is built; SO_PEERCRED is enforced server-side (config.rs:114-120).
   */
  readonly udsPath: string;
  /** Per-call deadline; on expiry the call REJECTS (fail-closed). Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * Tenant the workload asserts at handshake (HandshakeRequest.tenant_id_assertion, adapter.proto:206).
   * The sidecar fails closed with PERMISSION_DENIED unless this matches its configured tenant. A tenant
   * identifier, NOT a credential — credential-blindness is preserved. Empty (default) asserts no tenant
   * and is rejected by a tenant-scoped sidecar; a real deployment passes the workload's tenant.
   */
  readonly tenantIdAssertion?: string;
}

/**
 * Build a `LedgerTransport` that speaks real grpc-js to SpendGuard's IMPLEMENTED gating flow
 * (Handshake -> RequestDecision -> ConfirmPublishOutcome) over the UDS. Every transport failure
 * REJECTS (fail-closed); a served CONTINUE/STOP maps onto the vendor-neutral port shape and everything
 * else throws. The adapter's catch converts a reject into a deny.
 */
export function createDecisionLedgerTransport(opts: DecisionLedgerTransportOpts): LedgerTransport {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const insecure: ChannelCredentials = credentials.createInsecure();
  const client = new Client(`unix://${opts.udsPath}`, insecure);
  const handshakeRequest: HandshakeRequest = {
    ...HANDSHAKE_REQUEST,
    tenantIdAssertion: opts.tenantIdAssertion ?? "",
  };

  function unary<Resp>(
    method: string,
    deserialize: (bytes: Buffer) => Resp,
    requestBytes: Buffer,
  ): Promise<Resp> {
    const deadline = new Date(Date.now() + timeoutMs);
    return new Promise<Resp>((resolve, reject) => {
      try {
        client.makeUnaryRequest(
          method,
          (b: Buffer) => b,
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

  // The handshake is mandatory before any other RPC and is established ONCE, then reused. We memoize
  // the in-flight promise so concurrent first-reserves share a single handshake (and a failed
  // handshake rejects every caller — fail-closed, never a falsy session).
  let handshake: Promise<string> | undefined;
  function sessionId(): Promise<string> {
    if (handshake === undefined) {
      handshake = unary(
        HANDSHAKE_METHOD,
        decodeHandshakeResponse,
        encodeHandshakeRequest(handshakeRequest),
      ).then((resp) => {
        if (resp.sessionId.length === 0) {
          // A handshake with no session id is unusable — fail CLOSED, and let the next call retry.
          handshake = undefined;
          throw new Error("Handshake: empty session_id (fail-closed)");
        }
        return resp.sessionId;
      });
      // A rejected handshake must not poison the transport forever — clear so the next call retries.
      handshake.catch(() => {
        handshake = undefined;
      });
    }
    return handshake;
  }

  return {
    async reserve(
      req: LedgerReserveReq,
    ): Promise<{ reservationId: string } | { overBudget: true }> {
      const session = await sessionId();
      const projected = atomicToWire(req.estimated_amount_atomic);
      const wire = encodeDecisionRequest(
        {
          sessionId: session,
          trigger: DecisionRequest_Trigger.LLM_CALL_PRE,
          trace: undefined,
          ids: undefined,
          route: req.route,
          inputs: {
            projectedClaims: [],
            projectedP50Atomic: projected,
            projectedP90Atomic: projected,
            projectedP95Atomic: projected,
            projectedP99Atomic: projected,
            projectedUnit: undefined,
          },
        },
        randomUUID(),
      );
      const resp = await unary(DECISION_METHOD, decodeDecisionResponse, wire);
      if (resp.decision === DecisionResponse_Decision.CONTINUE) {
        if (resp.decisionId.length === 0) {
          // CONTINUE with no decision_id yields no usable reservation handle — fail CLOSED.
          throw new Error("RequestDecision: CONTINUE with empty decision_id (fail-closed)");
        }
        return { reservationId: resp.decisionId };
      }
      if (
        resp.decision === DecisionResponse_Decision.STOP ||
        resp.decision === DecisionResponse_Decision.STOP_RUN_PROJECTION
      ) {
        // Per-call / run budget hard-cap: a runaway agent cannot bankrupt a tenant (port.ts:7-9).
        return { overBudget: true };
      }
      // DEGRADE / SKIP / REQUIRE_APPROVAL / UNSPECIFIED / unknown enum -> deny-by-default (proto:448).
      throw new Error(`RequestDecision: non-CONTINUE/STOP decision=${resp.decision} (fail-closed)`);
    },

    async commit(req: LedgerCommitReq): Promise<{ overrun: boolean }> {
      const session = await sessionId();
      const wire = encodeConfirmPublishOutcomeRequest({
        sessionId: session,
        decisionId: req.reservation_id,
        effectHash: new Uint8Array(0),
        outcome: PublishOutcomeRequest_Outcome.APPLIED,
        adapterError: "",
      });
      const resp = await unary(CONFIRM_METHOD, decodePublishOutcomeResponse, wire);
      if (resp.error !== undefined) {
        // A populated outcome error means the settle was rejected — fail CLOSED.
        throw new Error(`ConfirmPublishOutcome: error code=${resp.error.code} (fail-closed)`);
      }
      // The decision boundary already reserved + committed the effect; a clean confirm is no overrun.
      return { overrun: false };
    },
  };
}

/**
 * Atomic amounts are proto3 strings on the wire. The port carries a non-negative integer; render it
 * as base-10. A non-finite/negative value is a caller bug → throw (fail-closed; never send a bogus
 * amount).
 */
function atomicToWire(amount: number): string {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`atomic amount must be a non-negative integer, got ${amount} (fail-closed)`);
  }
  return String(amount);
}

// --- minimal proto3 wire codecs (the S5 stub is types-only; mirrors transport.ts) -------------------

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

function encodeHandshakeRequest(req: HandshakeRequest): Buffer {
  const out: number[] = [];
  writeString(out, 1, req.sdkVersion);
  writeString(out, 2, req.runtimeKind);
  writeString(out, 3, req.runtimeVersion);
  // tenant_id_assertion (5): a TENANT IDENTITY assertion (NOT a credential — no secret); the sidecar
  // fails closed (PERMISSION_DENIED) unless it matches its configured tenant. proto3-omit when empty.
  if (req.tenantIdAssertion.length > 0) writeString(out, 5, req.tenantIdAssertion);
  writeUint32(out, 7, req.protocolVersion);
  return Buffer.from(out);
}

function encodeDecisionRequestInputs(inputs: DecisionRequest["inputs"]): Buffer {
  const out: number[] = [];
  if (inputs === undefined) return Buffer.from(out);
  // projected_claims (1) intentionally omitted — the credential-blind transport sends the projection
  // only via the p* risk-band fields (a single estimate, no per-budget claim breakdown).
  writeString(out, 2, inputs.projectedP50Atomic);
  writeString(out, 3, inputs.projectedP90Atomic);
  writeString(out, 4, inputs.projectedP95Atomic);
  writeString(out, 5, inputs.projectedP99Atomic);
  return Buffer.from(out);
}

function encodeDecisionRequest(req: DecisionRequest, idempotencyKey: string): Buffer {
  const out: number[] = [];
  writeString(out, 1, req.sessionId);
  writeEnum(out, 2, req.trigger);
  // trace (3) / ids (4) intentionally omitted — opaque, never a credential.
  writeString(out, 5, req.route);
  const inputs = encodeDecisionRequestInputs(req.inputs);
  if (inputs.length > 0) writeLenDelim(out, 6, inputs);
  // idempotency (9): the sidecar REQUIRES a non-empty Idempotency.key (adapter_uds.rs request_decision
  // validation) — same key + same request fingerprint collapses to one decision. Idempotency.key = field 1.
  // A correlation token, NOT a credential.
  const idem: number[] = [];
  writeString(idem, 1, idempotencyKey);
  writeLenDelim(out, 9, Buffer.from(idem));
  return Buffer.from(out);
}

function encodeConfirmPublishOutcomeRequest(req: PublishOutcomeRequest): Buffer {
  const out: number[] = [];
  writeString(out, 1, req.sessionId);
  writeString(out, 2, req.decisionId);
  // effect_hash (3) empty; outcome (4) APPLIED.
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

function decodeHandshakeResponse(bytes: Buffer): HandshakeResponse {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  const out: HandshakeResponse = { sidecarVersion: "", protocolVersion: 0, sessionId: "" };
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) out.sidecarVersion = dec.decode(readLenDelim(r));
    else if (field === 6 && wireType === 0) out.protocolVersion = readVarint(r);
    else if (field === 7 && wireType === 2) out.sessionId = dec.decode(readLenDelim(r));
    else skipField(r, wireType);
  }
  return out;
}

function decodeDecisionResponse(bytes: Buffer): DecisionResponse {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  const out: DecisionResponse = {
    decisionId: "",
    auditDecisionEventId: "",
    decision: 0,
    reasonCodes: [],
    terminal: false,
    error: undefined,
  };
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) out.decisionId = dec.decode(readLenDelim(r));
    else if (field === 3 && wireType === 0) out.decision = readVarint(r);
    else skipField(r, wireType);
  }
  return out;
}

function decodePublishOutcomeResponse(bytes: Buffer): PublishOutcomeResponse {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  const out: PublishOutcomeResponse = {
    auditOutcomeEventId: "",
    recordedAt: undefined,
    error: undefined,
  };
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) out.auditOutcomeEventId = dec.decode(readLenDelim(r));
    else if (field === 3 && wireType === 2) {
      // A PRESENT error message means the settle was rejected — surface a non-undefined error so the
      // commit path fails CLOSED. We only need its code.
      out.error = { code: decodeErrorCode(readLenDelim(r)), message: "", details: {} };
    } else skipField(r, wireType);
  }
  return out;
}

function decodeErrorCode(bytes: Uint8Array): number {
  const r: Reader = { buf: bytes, pos: 0 };
  let code = 0;
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 0) code = readVarint(r);
    else skipField(r, wireType);
  }
  return code;
}

// --- test-only codec exports (the in-process fake UDS server reuses these wire codecs) ---------------
// Exported so decision-transport.test.ts's fake `SidecarAdapter` server speaks the SAME wire format
// the transport speaks, proving a real round-trip rather than a mocked client.

/** @internal test-only: decode a `DecisionRequest` from the wire (fake server side). */
export function decodeDecisionRequestForTest(bytes: Buffer): DecisionRequest {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  const out: DecisionRequest = {
    sessionId: "",
    trigger: 0,
    trace: undefined,
    ids: undefined,
    route: "",
    inputs: undefined,
  };
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) out.sessionId = dec.decode(readLenDelim(r));
    else if (field === 2 && wireType === 0) out.trigger = readVarint(r);
    else if (field === 5 && wireType === 2) out.route = dec.decode(readLenDelim(r));
    else if (field === 6 && wireType === 2)
      out.inputs = decodeDecisionRequestInputsForTest(readLenDelim(r));
    else skipField(r, wireType);
  }
  return out;
}

/**
 * TEST-ONLY: extract HandshakeRequest.tenant_id_assertion (field 5) from the wire bytes. Guards the
 * live-discovered bug where the encoder silently dropped field 5 (the fake never checked it).
 */
export function decodeHandshakeTenantAssertionForTest(bytes: Buffer): string {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  let assertion = "";
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 5 && wireType === 2) assertion = dec.decode(readLenDelim(r));
    else skipField(r, wireType);
  }
  return assertion;
}

/**
 * TEST-ONLY: extract DecisionRequest.idempotency.key (field 9 -> nested Idempotency.key field 1) from
 * the wire bytes. Guards the live-discovered bug where the encoder omitted the required idempotency key.
 */
export function decodeDecisionIdempotencyKeyForTest(bytes: Buffer): string {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  let key = "";
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 9 && wireType === 2) {
      const inner = readLenDelim(r);
      const ir: Reader = { buf: inner, pos: 0 };
      while (ir.pos < inner.length) {
        const itag = readVarint(ir);
        const ifield = Math.floor(itag / 8);
        const iwt = itag & 7;
        if (ifield === 1 && iwt === 2) key = dec.decode(readLenDelim(ir));
        else skipField(ir, iwt);
      }
    } else skipField(r, wireType);
  }
  return key;
}

function decodeDecisionRequestInputsForTest(bytes: Uint8Array): DecisionRequest_Inputs {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  const out: DecisionRequest_Inputs = {
    projectedClaims: [],
    projectedP50Atomic: "",
    projectedP90Atomic: "",
    projectedP95Atomic: "",
    projectedP99Atomic: "",
    projectedUnit: undefined,
  };
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 2 && wireType === 2) out.projectedP50Atomic = dec.decode(readLenDelim(r));
    else if (field === 3 && wireType === 2) out.projectedP90Atomic = dec.decode(readLenDelim(r));
    else if (field === 4 && wireType === 2) out.projectedP95Atomic = dec.decode(readLenDelim(r));
    else if (field === 5 && wireType === 2) out.projectedP99Atomic = dec.decode(readLenDelim(r));
    else skipField(r, wireType);
  }
  return out;
}

/** @internal test-only: decode a `PublishOutcomeRequest` from the wire (fake server side). */
export function decodePublishOutcomeRequestForTest(bytes: Buffer): PublishOutcomeRequest {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  const out: PublishOutcomeRequest = {
    sessionId: "",
    decisionId: "",
    effectHash: new Uint8Array(0),
    outcome: 0,
    adapterError: "",
  };
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) out.sessionId = dec.decode(readLenDelim(r));
    else if (field === 2 && wireType === 2) out.decisionId = dec.decode(readLenDelim(r));
    else if (field === 4 && wireType === 0) out.outcome = readVarint(r);
    else skipField(r, wireType);
  }
  return out;
}

/** @internal test-only: encode a `HandshakeResponse` to the wire (fake server side). */
export function encodeHandshakeResponseForTest(resp: Partial<HandshakeResponse>): Buffer {
  const out: number[] = [];
  writeString(out, 1, resp.sidecarVersion ?? "");
  writeUint32(out, 6, resp.protocolVersion ?? 0);
  writeString(out, 7, resp.sessionId ?? "");
  return Buffer.from(out);
}

/** @internal test-only: encode a `DecisionResponse` to the wire (fake server side). */
export function encodeDecisionResponseForTest(resp: Partial<DecisionResponse>): Buffer {
  const out: number[] = [];
  writeString(out, 1, resp.decisionId ?? "");
  writeEnum(out, 3, resp.decision ?? 0);
  return Buffer.from(out);
}

/** @internal test-only: encode a `PublishOutcomeResponse` to the wire (fake server side). */
export function encodePublishOutcomeResponseForTest(resp: Partial<PublishOutcomeResponse>): Buffer {
  const out: number[] = [];
  writeString(out, 1, resp.auditOutcomeEventId ?? "");
  if (resp.error !== undefined) {
    const inner: number[] = [];
    writeEnum(inner, 1, resp.error.code);
    writeString(inner, 2, resp.error.message);
    writeLenDelim(out, 3, Buffer.from(inner));
  }
  return Buffer.from(out);
}
