/**
 * RED-first unit tests for the hand-written OpenShell WatchSandbox proto3 wire codecs (slice OS-S2b).
 *
 * NO gateway, NO network: encode/decode are asserted byte-for-byte against an INDEPENDENT, hand-built
 * wire fixture (NOT a round-trip against the production encoder), mirroring the ExecSandbox codec lock
 * (openshell.subset.exec.test.ts) and the lifecycle codec lock (openshell.subset.lifecycle.test.ts).
 * The codecs mirror the REAL proto v0.0.66 1:1 (/tmp/openshell-src/proto/openshell.proto) — exact
 * field numbers:
 *   WatchSandboxRequest { id=1 string, follow_status=2 bool, stop_on_terminal=7 bool }
 *     (we ONLY encode those 3; follow_logs=3 / follow_events=4 / log_tail_lines=5 / event_tail=6 /
 *      log_since_ms=8 / log_sources=9 / log_min_level=10 are OUT OF SCOPE and never emitted)
 *   SandboxStreamEvent  { oneof payload { Sandbox sandbox=1; SandboxLogLine log=2; PlatformEvent
 *                         event=3; SandboxStreamWarning warning=4; DraftPolicyUpdate
 *                         draft_policy_update=5 } }  (we ONLY decode sandbox=1, reusing the OS-S2a
 *                         Sandbox/ObjectMeta/SandboxStatus decode; every other variant + unknown field
 *                         is SKIPPED -> {sandbox: undefined})
 *
 * A dropped/mis-tagged field or a fabricated proto3 zero is a RED test. The decoder must SKIP unknown
 * fields + non-sandbox oneof variants (forward-compatible) and read only the `sandbox` snapshot.
 */
import { describe, expect, it } from "vitest";
import {
  WATCH_SANDBOX_METHOD,
  decodeSandboxStreamEvent,
  encodeWatchSandboxRequest,
} from "./openshell.subset.codec.js";

// --- a tiny, INDEPENDENT proto3 encoder used ONLY to build known fixtures (not the production path) ---

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

function pushBool(out: number[], field: number, value: boolean): void {
  pushTag(out, field, 0); // bool is a varint
  pushVarint(out, value ? 1 : 0);
}

const OS_ID = "sbxid-7f3c9a2e-stable-gateway-id";

/** Build a SandboxStreamEvent wire carrying a Sandbox(status.phase) at oneof field 1. */
function sandboxStreamEventBytes(phase: number): Uint8Array {
  // SandboxStatus { phase=6 } (enum -> varint).
  const status: number[] = [];
  pushTag(status, 6, 0);
  pushVarint(status, phase);
  // Sandbox { status=3 } (metadata=1 is omitted here — readiness only needs status.phase).
  const sandbox: number[] = [];
  pushLenDelim(sandbox, 3, Uint8Array.from(status));
  // SandboxStreamEvent { sandbox=1 }.
  const event: number[] = [];
  pushLenDelim(event, 1, Uint8Array.from(sandbox));
  return Uint8Array.from(event);
}

describe("WATCH_SANDBOX_METHOD (wire method id)", () => {
  it("is the fully-qualified OpenShell WatchSandbox method id", () => {
    expect(WATCH_SANDBOX_METHOD).toBe("/openshell.v1.OpenShell/WatchSandbox");
  });
});

describe("encodeWatchSandboxRequest (OS-S2b — id=1, follow_status=2, stop_on_terminal=7)", () => {
  it("encodes id (1) + follow_status=true (2) + stop_on_terminal=true (7) (the adapter's request)", () => {
    const actual = encodeWatchSandboxRequest({
      id: OS_ID,
      followStatus: true,
      stopOnTerminal: true,
    });
    const want: number[] = [];
    pushString(want, 1, OS_ID); // id = 1
    pushBool(want, 2, true); // follow_status = 2
    pushBool(want, 7, true); // stop_on_terminal = 7
    expect(Array.from(actual)).toEqual(want);
  });

  it("omits an empty id (proto3 zero) and omits the bools when false/absent (proto3 zero)", () => {
    // All zero/absent => an EMPTY message on the wire (proto3 omits zero scalars).
    expect(Array.from(encodeWatchSandboxRequest({ id: "" }))).toEqual([]);
    expect(
      Array.from(encodeWatchSandboxRequest({ id: "", followStatus: false, stopOnTerminal: false })),
    ).toEqual([]);
    // id only, bools false/absent => only field 1.
    const idOnly: number[] = [];
    pushString(idOnly, 1, OS_ID);
    expect(Array.from(encodeWatchSandboxRequest({ id: OS_ID }))).toEqual(idOnly);
  });

  it("NEVER emits the out-of-scope follow_logs/follow_events/tail fields", () => {
    const actual = encodeWatchSandboxRequest({
      id: OS_ID,
      followStatus: true,
      stopOnTerminal: true,
    });
    // The only field tags present are 1 (len-delim), 2 (varint), 7 (varint). Decode the top-level tags
    // and assert no field 3/4/5/6 leaked in.
    const r = { buf: actual, pos: 0 };
    const seen: number[] = [];
    while (r.pos < actual.length) {
      let tag = 0;
      let shift = 1;
      for (;;) {
        const b = actual[r.pos++] ?? 0;
        tag += (b & 0x7f) * shift;
        if ((b & 0x80) === 0) break;
        shift *= 128;
      }
      const field = Math.floor(tag / 8);
      const wt = tag & 0x7;
      seen.push(field);
      if (wt === 2) {
        let len = 0;
        let s = 1;
        for (;;) {
          const b = actual[r.pos++] ?? 0;
          len += (b & 0x7f) * s;
          if ((b & 0x80) === 0) break;
          s *= 128;
        }
        r.pos += len;
      } else if (wt === 0) {
        while ((actual[r.pos++] ?? 0) & 0x80) {
          /* consume varint */
        }
      }
    }
    expect(seen).toEqual([1, 2, 7]);
  });
});

describe("decodeSandboxStreamEvent (OS-S2b — oneof sandbox=1 reuses the Sandbox decode)", () => {
  it("decodes a Sandbox(status.phase=READY) snapshot at oneof field 1", () => {
    const decoded = decodeSandboxStreamEvent(sandboxStreamEventBytes(2)); // READY = 2
    expect(decoded.sandbox?.status?.phase).toBe(2);
  });

  it("decodes a Sandbox(status.phase=PROVISIONING) snapshot at oneof field 1", () => {
    const decoded = decodeSandboxStreamEvent(sandboxStreamEventBytes(1)); // PROVISIONING = 1
    expect(decoded.sandbox?.status?.phase).toBe(1);
  });

  it("SKIPS a log variant (field 2) -> {sandbox: undefined} (no readiness signal, never READY)", () => {
    // SandboxLogLine log=2 — a non-sandbox oneof variant we deliberately do not decode.
    const log: number[] = [];
    pushString(log, 1, "some log line content"); // arbitrary inner field
    const event: number[] = [];
    pushLenDelim(event, 2, Uint8Array.from(log)); // payload.log = 2
    const decoded = decodeSandboxStreamEvent(Uint8Array.from(event));
    expect(decoded.sandbox).toBeUndefined();
  });

  it("SKIPS a platform-event/warning/draft-policy variant (fields 3/4/5) -> {sandbox: undefined}", () => {
    for (const variantField of [3, 4, 5]) {
      const inner: number[] = [];
      pushString(inner, 1, "ignored");
      const event: number[] = [];
      pushLenDelim(event, variantField, Uint8Array.from(inner));
      const decoded = decodeSandboxStreamEvent(Uint8Array.from(event));
      expect(decoded.sandbox).toBeUndefined();
    }
  });

  it("SKIPS an unknown future field (forward-compatible) -> {sandbox: undefined}", () => {
    // A field number we have never seen (e.g. 99, varint) must be skipped, not derail the decode.
    const event: number[] = [];
    pushTag(event, 99, 0);
    pushVarint(event, 12345);
    const decoded = decodeSandboxStreamEvent(Uint8Array.from(event));
    expect(decoded.sandbox).toBeUndefined();
  });

  it("an EMPTY SandboxStreamEvent decodes to {sandbox: undefined} (no readiness signal)", () => {
    expect(decodeSandboxStreamEvent(new Uint8Array()).sandbox).toBeUndefined();
  });

  it("a log variant FOLLOWED by a sandbox variant decodes the sandbox (last-set oneof wins)", () => {
    // proto3 oneof: a later sandbox field overrides an earlier non-sandbox variant.
    const log: number[] = [];
    pushString(log, 1, "log");
    const status: number[] = [];
    pushTag(status, 6, 0);
    pushVarint(status, 2); // READY
    const sandbox: number[] = [];
    pushLenDelim(sandbox, 3, Uint8Array.from(status));
    const event: number[] = [];
    pushLenDelim(event, 2, Uint8Array.from(log)); // log first
    pushLenDelim(event, 1, Uint8Array.from(sandbox)); // sandbox last
    const decoded = decodeSandboxStreamEvent(Uint8Array.from(event));
    expect(decoded.sandbox?.status?.phase).toBe(2);
  });
});
