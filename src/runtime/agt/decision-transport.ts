/**
 * The AGT decision transport — grpc-js over a Unix Domain Socket (SLICE-R9b-2a).
 *
 * This is the SINGLE chokepoint where the runtime RPC vendor (@grpc/grpc-js) AND the AGT generated
 * stub are named for the policy path. It lives under src/runtime/agt/ (a runtime vendor zone, NOT
 * core), so the `no-vendor-in-core` boundary (.dependency-cruiser.cjs) stays intact: the
 * SecondaryPolicyAdapter (src/policy/dedup.ts) keeps seeing only the injected, vendor-neutral port,
 * and no core module imports grpc-js or the stub.
 *
 * Responsibility (and ONLY this): bridge an `AgtDecisionTransport` port to OUR `AgtDecision.Evaluate`
 * gRPC contract over `unix://<udsPath>`. Mirrors src/runtime/spendguard/decision-transport.ts:
 *   - the channel is LAZY: `new Client(...)` does NOT connect; the first `evaluate` triggers it.
 *   - a PER-CALL deadline (default 750ms, hard cap 2000ms, env AGT_TIMEOUT_MS) — a slow/hung sidecar
 *     fails CLOSED, never hangs the agent forever.
 *   - FAIL-CLOSED (AGENTS.md deny-by-default): a gRPC status error (connection refused,
 *     DEADLINE_EXCEEDED), an empty/missing response, OR a malformed/undecodable response ALL surface
 *     as a REJECT. There is NO path that resolves a falsy success; the AGT endpoint adapter's
 *     `evaluate` lets the reject propagate, so evaluateSecondaries synthesises a deny (configured-down
 *     -> deny).
 *
 * CREDENTIAL-BLIND: the AgtEvaluateRequest carries ONLY the neutral governance fields + the
 * already-best-effort-redacted GovernanceProjection (R9b-1). NO field carries a raw arg/env/stdin/
 * credential by construction (the proto has none); this transport adds none.
 *
 * The generated stub is types-only (no codec), so — mirroring spendguard/decision-transport.ts — this
 * module hand-writes the minimal proto3 wire codecs for the two messages it speaks. The in-process
 * fake UDS server in decision-transport.test.ts exercises a real round-trip; a live e2e against a real
 * Python AGT sidecar is R9c (gated, BLOCKED until the operator supplies the engine).
 */
import { type ChannelCredentials, Client, type ServiceError, credentials } from "@grpc/grpc-js";
import type { AgtEvaluateRequest, AgtEvaluateResponse } from "./_generated/agt_decision.js";

const SERVICE = "/agentos.agt.decision.v1.AgtDecision";
const EVALUATE_METHOD = `${SERVICE}/Evaluate`;

/** Default per-call deadline (R9 brainstorm: ~750ms). A slow/hung sidecar fails CLOSED. */
const DEFAULT_TIMEOUT_MS = 750;

/** Hard cap on the per-call deadline (R9 brainstorm: 2000ms). Never exceed it, however configured. */
const MAX_TIMEOUT_MS = 2_000;

/** Exported service descriptor name so callers/tests share one source of truth for the gRPC path. */
export const AGT_DECISION_SERVICE = SERVICE;

/**
 * Vendor-neutral transport port the AGT endpoint adapter consumes. A fake `{ evaluate }` can be
 * injected in tests — the adapter never names grpc-js. A throw/reject is fail-closed (down -> deny).
 */
export interface AgtDecisionTransport {
  evaluate(req: AgtEvaluateRequest): Promise<AgtEvaluateResponse>;
}

export interface AgtDecisionTransportOpts {
  /** Unix Domain Socket path to the AGT sidecar (e.g. /var/run/agt/decision.sock). */
  readonly udsPath: string;
  /**
   * Per-call deadline; on expiry the call REJECTS (fail-closed). Defaults to {@link DEFAULT_TIMEOUT_MS}
   * (750ms), hard-capped at {@link MAX_TIMEOUT_MS} (2000ms). The env `AGT_TIMEOUT_MS` overrides the
   * default when this is absent; an explicit `deadlineMs` wins over the env. All paths are clamped to
   * the hard cap.
   */
  readonly deadlineMs?: number;
}

/** Resolve the effective per-call deadline: explicit opt > AGT_TIMEOUT_MS env > default, clamped to cap. */
function resolveDeadlineMs(deadlineMs?: number): number {
  const envRaw = process.env.AGT_TIMEOUT_MS;
  const envMs = envRaw !== undefined ? Number.parseInt(envRaw, 10) : Number.NaN;
  const chosen =
    typeof deadlineMs === "number" && Number.isFinite(deadlineMs) && deadlineMs > 0
      ? deadlineMs
      : Number.isFinite(envMs) && envMs > 0
        ? envMs
        : DEFAULT_TIMEOUT_MS;
  return Math.min(chosen, MAX_TIMEOUT_MS);
}

/**
 * Build an `AgtDecisionTransport` that speaks real grpc-js to OUR `AgtDecision.Evaluate` over the UDS.
 * Construction is LAZY (no connect). Every transport failure REJECTS (fail-closed); a served response
 * decodes to an `AgtEvaluateResponse`. The endpoint adapter maps that response (or the reject) to a
 * decision — only an unambiguous { allowed:true, action:"allow" } maps to allow.
 */
export function createAgtDecisionTransport(opts: AgtDecisionTransportOpts): AgtDecisionTransport {
  const timeoutMs = resolveDeadlineMs(opts.deadlineMs);
  const insecure: ChannelCredentials = credentials.createInsecure();
  // LAZY: constructing the Client does NOT open the connection — the first RPC triggers it.
  const client = new Client(`unix://${opts.udsPath}`, insecure);

  return {
    evaluate(req: AgtEvaluateRequest): Promise<AgtEvaluateResponse> {
      const requestBytes = encodeAgtEvaluateRequest(req);
      const deadline = new Date(Date.now() + timeoutMs);
      return new Promise<AgtEvaluateResponse>((resolve, reject) => {
        try {
          client.makeUnaryRequest(
            EVALUATE_METHOD,
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
                reject(new Error(`${EVALUATE_METHOD}: missing RPC response (fail-closed)`));
                return;
              }
              try {
                resolve(decodeAgtEvaluateResponse(value));
              } catch (decodeErr) {
                reject(decodeErr instanceof Error ? decodeErr : new Error(String(decodeErr)));
              }
            },
          );
        } catch (syncErr) {
          reject(syncErr instanceof Error ? syncErr : new Error(String(syncErr)));
        }
      });
    },
  };
}

// --- minimal proto3 wire codecs (the generated stub is types-only; mirrors spendguard transports) ---

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

function writeBool(out: number[], field: number, value: boolean): void {
  if (!value) return;
  writeTag(out, field, 0);
  writeVarint(out, 1);
}

/** Encode the credential-blind GovernanceProjection (proto field numbers from agt_decision.subset.proto). */
function encodeGovernanceProjection(p: AgtEvaluateRequest["governanceProjection"]): Buffer {
  const out: number[] = [];
  if (p === undefined) return Buffer.from(out);
  writeUint32(out, 1, p.version);
  writeString(out, 2, p.operationClass);
  writeString(out, 3, p.argv0);
  writeUint32(out, 4, p.argc);
  for (const t of p.argvRedacted) writeString(out, 5, t);
  writeBool(out, 6, p.truncated);
  writeBool(out, 7, p.usesShellInterpreter);
  for (const h of p.networkHosts) writeString(out, 8, h);
  for (const f of p.destructiveFlags) writeString(out, 9, f);
  return Buffer.from(out);
}

function encodeAgtEvaluateRequest(req: AgtEvaluateRequest): Buffer {
  const out: number[] = [];
  writeString(out, 1, req.requestId);
  writeString(out, 2, req.tenantId);
  writeString(out, 3, req.projectId);
  writeString(out, 4, req.taskId);
  writeString(out, 5, req.actorId);
  writeString(out, 6, req.action);
  writeString(out, 7, req.resource);
  if (req.governanceProjection !== undefined) {
    writeLenDelim(out, 8, encodeGovernanceProjection(req.governanceProjection));
  }
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

function decodeAgtEvaluateResponse(bytes: Buffer): AgtEvaluateResponse {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  const out: AgtEvaluateResponse = { allowed: false, action: "", matchedRule: "", reason: "" };
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 0) out.allowed = readVarint(r) !== 0;
    else if (field === 2 && wireType === 2) out.action = dec.decode(readLenDelim(r));
    else if (field === 3 && wireType === 2) out.matchedRule = dec.decode(readLenDelim(r));
    else if (field === 4 && wireType === 2) out.reason = dec.decode(readLenDelim(r));
    else skipField(r, wireType);
  }
  return out;
}

// --- test-only codec exports (the in-process fake UDS server reuses these wire codecs) ---------------
// Exported so decision-transport.test.ts's fake `AgtDecision` server speaks the SAME wire format the
// transport speaks, proving a real round-trip rather than a mocked client.

/** @internal test-only: decode an `AgtEvaluateRequest` from the wire (fake server side). */
export function decodeAgtEvaluateRequestForTest(bytes: Buffer): AgtEvaluateRequest {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  const out: AgtEvaluateRequest = {
    requestId: "",
    tenantId: "",
    projectId: "",
    taskId: "",
    actorId: "",
    action: "",
    resource: "",
    governanceProjection: undefined,
  };
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) out.requestId = dec.decode(readLenDelim(r));
    else if (field === 2 && wireType === 2) out.tenantId = dec.decode(readLenDelim(r));
    else if (field === 3 && wireType === 2) out.projectId = dec.decode(readLenDelim(r));
    else if (field === 4 && wireType === 2) out.taskId = dec.decode(readLenDelim(r));
    else if (field === 5 && wireType === 2) out.actorId = dec.decode(readLenDelim(r));
    else if (field === 6 && wireType === 2) out.action = dec.decode(readLenDelim(r));
    else if (field === 7 && wireType === 2) out.resource = dec.decode(readLenDelim(r));
    else if (field === 8 && wireType === 2)
      out.governanceProjection = decodeGovernanceProjectionForTest(readLenDelim(r));
    else skipField(r, wireType);
  }
  return out;
}

function decodeGovernanceProjectionForTest(
  bytes: Uint8Array,
): NonNullable<AgtEvaluateRequest["governanceProjection"]> {
  const r: Reader = { buf: bytes, pos: 0 };
  const dec = new TextDecoder();
  const argvRedacted: string[] = [];
  const networkHosts: string[] = [];
  const destructiveFlags: string[] = [];
  const out = {
    version: 0,
    operationClass: "",
    argv0: "",
    argc: 0,
    argvRedacted,
    truncated: false,
    usesShellInterpreter: false,
    networkHosts,
    destructiveFlags,
  };
  while (r.pos < bytes.length) {
    const tag = readVarint(r);
    const field = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (field === 1 && wireType === 0) out.version = readVarint(r);
    else if (field === 2 && wireType === 2) out.operationClass = dec.decode(readLenDelim(r));
    else if (field === 3 && wireType === 2) out.argv0 = dec.decode(readLenDelim(r));
    else if (field === 4 && wireType === 0) out.argc = readVarint(r);
    else if (field === 5 && wireType === 2) argvRedacted.push(dec.decode(readLenDelim(r)));
    else if (field === 6 && wireType === 0) out.truncated = readVarint(r) !== 0;
    else if (field === 7 && wireType === 0) out.usesShellInterpreter = readVarint(r) !== 0;
    else if (field === 8 && wireType === 2) networkHosts.push(dec.decode(readLenDelim(r)));
    else if (field === 9 && wireType === 2) destructiveFlags.push(dec.decode(readLenDelim(r)));
    else skipField(r, wireType);
  }
  return out;
}

/** @internal test-only: encode an `AgtEvaluateResponse` to the wire (fake server side). */
export function encodeAgtEvaluateResponseForTest(resp: Partial<AgtEvaluateResponse>): Buffer {
  const out: number[] = [];
  writeBool(out, 1, resp.allowed ?? false);
  writeString(out, 2, resp.action ?? "");
  writeString(out, 3, resp.matchedRule ?? "");
  writeString(out, 4, resp.reason ?? "");
  return Buffer.from(out);
}
