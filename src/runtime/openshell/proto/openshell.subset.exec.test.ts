/**
 * RED-first unit tests for the hand-written `ExecSandbox` proto3 wire codecs (slice SLICE-OS-S1).
 *
 * These run with NO gateway and NO network: they assert encode/decode are byte-correct against an
 * INDEPENDENT, hand-built wire fixture (NOT a round-trip against the production encoder), mirroring the
 * ingest `ListEntries` codec lock. The codecs must mirror the REAL proto v0.0.66 1:1
 * (/tmp/openshell-src/proto/openshell.proto:645-696):
 *   ExecSandboxRequest { sandbox_id=1 string, command=2 repeated string, workdir=3 string,
 *                        environment=4 map<string,string>, timeout_seconds=5 uint32 (varint),
 *                        stdin=6 bytes }   (tty/cols/rows out of scope; never emitted)
 *   ExecSandboxStdout { data=1 bytes }   ExecSandboxStderr { data=1 bytes }
 *   ExecSandboxExit   { exit_code=1 int32 (varint) }
 *   ExecSandboxEvent  { oneof payload { stdout=1 | stderr=2 | exit=3 } } (each a len-delimited submessage)
 *
 * A dropped/mis-tagged field or a fabricated proto3 zero is a RED test. proto3 SEMANTICS the encoder
 * must honour: a zero/empty scalar field is OMITTED on the wire (so an empty stdin / "" workdir / 0
 * timeout produces NO bytes); a repeated string emits one field-2 entry PER element in order; a map
 * entry is a field-4 length-delimited submessage { key=1 string, value=2 string }.
 */
import { describe, expect, it } from "vitest";
import {
  EXEC_SANDBOX_METHOD,
  decodeExecSandboxEvent,
  encodeExecSandboxRequest,
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

/** A map<string,string> entry submessage { key=1 string, value=2 string } (proto3 map encoding). */
function mapEntryBytes(key: string, value: string): Uint8Array {
  const out: number[] = [];
  if (key.length > 0) pushString(out, 1, key);
  if (value.length > 0) pushString(out, 2, value);
  return Uint8Array.from(out);
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("EXEC_SANDBOX_METHOD constant (wire method id)", () => {
  it("is the fully-qualified ExecSandbox method id", () => {
    expect(EXEC_SANDBOX_METHOD).toBe("/openshell.v1.OpenShell/ExecSandbox");
  });
});

describe("encodeExecSandboxRequest (S1 — proto v0.0.66 fields 1..6)", () => {
  it("encodes sandbox_id (1) + command (2, repeated, in order); omits absent optionals", () => {
    const actual = encodeExecSandboxRequest({
      sandboxId: "sbx-1",
      command: ["sh", "-c", "echo hi"],
    });

    // Independent fixture: field 1 (sandbox_id) then one field-2 entry per command element, in order.
    const want: number[] = [];
    pushString(want, 1, "sbx-1");
    pushString(want, 2, "sh");
    pushString(want, 2, "-c");
    pushString(want, 2, "echo hi");

    expect(Array.from(actual)).toEqual(want);
  });

  it("encodes workdir (3), environment (4, map) and stdin (6) when present", () => {
    const actual = encodeExecSandboxRequest({
      sandboxId: "id",
      command: ["pwd"],
      workdir: "/work",
      environment: { FOO: "bar" },
      stdin: Uint8Array.from([1, 2, 3]),
    });

    const want: number[] = [];
    pushString(want, 1, "id");
    pushString(want, 2, "pwd");
    pushString(want, 3, "/work");
    pushLenDelim(want, 4, mapEntryBytes("FOO", "bar")); // map entry submessage
    pushLenDelim(want, 6, Uint8Array.from([1, 2, 3])); // stdin bytes

    expect(Array.from(actual)).toEqual(want);
  });

  it("encodes timeout_seconds (5) as a varint; omits the proto3 zero value", () => {
    const withTimeout = encodeExecSandboxRequest({
      sandboxId: "id",
      command: ["sleep", "1"],
      timeoutSeconds: 30,
    });
    const want: number[] = [];
    pushString(want, 1, "id");
    pushString(want, 2, "sleep");
    pushString(want, 2, "1");
    pushTag(want, 5, 0); // field 5, varint
    pushVarint(want, 30);
    expect(Array.from(withTimeout)).toEqual(want);

    // proto3 zero (timeout 0 = no timeout) is OMITTED on the wire.
    const zero = encodeExecSandboxRequest({
      sandboxId: "id",
      command: ["x"],
      timeoutSeconds: 0,
    });
    const wantZero: number[] = [];
    pushString(wantZero, 1, "id");
    pushString(wantZero, 2, "x");
    expect(Array.from(zero)).toEqual(wantZero);
  });

  it("omits an empty workdir, empty environment map, and empty stdin (proto3 zero-value rule)", () => {
    const actual = encodeExecSandboxRequest({
      sandboxId: "id",
      command: ["x"],
      workdir: "",
      environment: {},
      stdin: new Uint8Array(),
    });
    const want: number[] = [];
    pushString(want, 1, "id");
    pushString(want, 2, "x");
    expect(Array.from(actual)).toEqual(want);
  });
});

describe("decodeExecSandboxEvent (S1 — oneof stdout=1 / stderr=2 / exit=3)", () => {
  it("decodes a stdout event (field 1) -> { stdout: { data } }", () => {
    // ExecSandboxStdout { data=1 bytes } wrapped in ExecSandboxEvent field 1 (len-delimited submessage).
    const stdoutMsg: number[] = [];
    pushLenDelim(stdoutMsg, 1, enc("hello\n")); // data=1
    const event: number[] = [];
    pushLenDelim(event, 1, Uint8Array.from(stdoutMsg)); // stdout=1

    const decoded = decodeExecSandboxEvent(Uint8Array.from(event));
    expect(decoded.stderr).toBeUndefined();
    expect(decoded.exit).toBeUndefined();
    expect(decoded.stdout?.data).toBeInstanceOf(Uint8Array);
    expect(dec(decoded.stdout?.data ?? new Uint8Array())).toBe("hello\n");
  });

  it("decodes a stderr event (field 2) -> { stderr: { data } }", () => {
    const stderrMsg: number[] = [];
    pushLenDelim(stderrMsg, 1, enc("oops"));
    const event: number[] = [];
    pushLenDelim(event, 2, Uint8Array.from(stderrMsg)); // stderr=2

    const decoded = decodeExecSandboxEvent(Uint8Array.from(event));
    expect(decoded.stdout).toBeUndefined();
    expect(decoded.exit).toBeUndefined();
    expect(dec(decoded.stderr?.data ?? new Uint8Array())).toBe("oops");
  });

  it("decodes an exit event (field 3) carrying exit_code=0 (a present-but-zero submessage)", () => {
    // ExecSandboxExit { exit_code=1 int32 } — exit_code 0 is omitted INSIDE the submessage (proto3 zero),
    // but the OUTER exit field is still PRESENT (a zero-length submessage), so the oneof variant is `exit`.
    const exitMsg: number[] = []; // empty: exit_code 0 omitted
    const event: number[] = [];
    pushLenDelim(event, 3, Uint8Array.from(exitMsg)); // exit=3

    const decoded = decodeExecSandboxEvent(Uint8Array.from(event));
    expect(decoded.stdout).toBeUndefined();
    expect(decoded.stderr).toBeUndefined();
    expect(decoded.exit).toBeDefined();
    expect(decoded.exit?.exitCode).toBe(0);
  });

  it("decodes an exit event with a non-zero exit_code (field 1 varint inside the submessage)", () => {
    const exitMsg: number[] = [];
    pushTag(exitMsg, 1, 0); // exit_code=1, varint
    pushVarint(exitMsg, 42);
    const event: number[] = [];
    pushLenDelim(event, 3, Uint8Array.from(exitMsg));

    const decoded = decodeExecSandboxEvent(Uint8Array.from(event));
    expect(decoded.exit?.exitCode).toBe(42);
  });

  it("decodes a negative int32 exit_code (10-byte sign-extended varint, e.g. -1)", () => {
    // proto3 encodes a negative int32 as a 64-bit-sign-extended varint (10 bytes). The decoder must
    // map it back to the negative int32 (a command killed by a signal can report a negative code).
    const exitMsg: number[] = [];
    pushTag(exitMsg, 1, 0);
    // -1 as a 64-bit two's-complement varint = ten 0xFF... bytes: 0xFF x9 then 0x01.
    for (let i = 0; i < 9; i++) exitMsg.push(0xff);
    exitMsg.push(0x01);
    const event: number[] = [];
    pushLenDelim(event, 3, Uint8Array.from(exitMsg));

    const decoded = decodeExecSandboxEvent(Uint8Array.from(event));
    expect(decoded.exit?.exitCode).toBe(-1);
  });
});
