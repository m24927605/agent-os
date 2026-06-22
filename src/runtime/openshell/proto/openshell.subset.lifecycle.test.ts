/**
 * RED-first unit tests for the hand-written OpenShell lifecycle proto3 wire codecs (slice OS-S2a).
 *
 * NO gateway, NO network: encode/decode are asserted byte-for-byte against an INDEPENDENT, hand-built
 * wire fixture (NOT a round-trip against the production encoder), mirroring the ExecSandbox codec lock
 * (openshell.subset.exec.test.ts) and the ingest `ListEntries` lock. The codecs mirror the REAL proto
 * v0.0.66 1:1 (/tmp/openshell-src/proto/openshell.proto + datamodel.proto) — exact field numbers:
 *   CreateSandboxRequest { spec=1 SandboxSpec, name=2 string, labels=3 map<string,string> }
 *   SandboxSpec          { template=6 SandboxTemplate }            (only `template` is encoded)
 *   SandboxTemplate      { image=1 string }
 *   SandboxResponse      { sandbox=1 Sandbox }
 *   Sandbox              { metadata=1 ObjectMeta, spec=2 SandboxSpec, status=3 SandboxStatus }
 *   ObjectMeta           { id=1 string, name=2 string }            (datamodel.proto)
 *   SandboxStatus        { phase=6 SandboxPhase }                  (NOTE: phase is field 6, NOT 1)
 *   SandboxPhase enum    { PROVISIONING=1, READY=2, ERROR=3 }
 *   GetSandboxRequest    { name=1 string }
 *   DeleteSandboxRequest { name=1 string }
 *   DeleteSandboxResponse{ deleted=1 bool }
 *
 * A dropped/mis-tagged field or a fabricated proto3 zero is a RED test. The decoders must SKIP unknown
 * fields (forward-compatible) and read only the nested fields we consume.
 */
import { describe, expect, it } from "vitest";
import {
  CREATE_SANDBOX_METHOD,
  DELETE_SANDBOX_METHOD,
  GET_SANDBOX_METHOD,
  decodeDeleteSandboxResponse,
  decodeSandboxResponse,
  encodeCreateSandboxRequest,
  encodeDeleteSandboxRequest,
  encodeGetSandboxRequest,
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

const DIGEST = "sha256:c116946b3f9e84791630f21f115ac35c9c9f669af70ec0eef3035d79833a9550";

describe("lifecycle method id constants (wire method ids)", () => {
  it("are the fully-qualified OpenShell lifecycle method ids", () => {
    expect(CREATE_SANDBOX_METHOD).toBe("/openshell.v1.OpenShell/CreateSandbox");
    expect(GET_SANDBOX_METHOD).toBe("/openshell.v1.OpenShell/GetSandbox");
    expect(DELETE_SANDBOX_METHOD).toBe("/openshell.v1.OpenShell/DeleteSandbox");
  });
});

describe("encodeCreateSandboxRequest (OS-S2a — nested spec{template{image}}, name=2, labels=3)", () => {
  it("encodes spec.template.image as field6→field1 (only the template is encoded)", () => {
    const actual = encodeCreateSandboxRequest({ spec: { template: { image: DIGEST } } });

    // Independent fixture: SandboxTemplate{ image=1 } -> SandboxSpec{ template=6 } -> Create{ spec=1 }.
    const template: number[] = [];
    pushString(template, 1, DIGEST); // SandboxTemplate.image = 1
    const spec: number[] = [];
    pushLenDelim(spec, 6, Uint8Array.from(template)); // SandboxSpec.template = 6
    const want: number[] = [];
    pushLenDelim(want, 1, Uint8Array.from(spec)); // CreateSandboxRequest.spec = 1

    expect(Array.from(actual)).toEqual(want);
  });

  it("encodes name (2) when present; omits it as the proto3 zero when empty/absent", () => {
    const withName = encodeCreateSandboxRequest({
      spec: { template: { image: DIGEST } },
      name: "agentos-nc-live",
    });
    const template: number[] = [];
    pushString(template, 1, DIGEST);
    const spec: number[] = [];
    pushLenDelim(spec, 6, Uint8Array.from(template));
    const wantWith: number[] = [];
    pushLenDelim(wantWith, 1, Uint8Array.from(spec));
    pushString(wantWith, 2, "agentos-nc-live"); // name = 2
    expect(Array.from(withName)).toEqual(wantWith);

    // Empty name => omitted (proto3 zero).
    const empty = encodeCreateSandboxRequest({ spec: { template: { image: DIGEST } }, name: "" });
    const wantEmpty: number[] = [];
    pushLenDelim(wantEmpty, 1, Uint8Array.from(spec));
    expect(Array.from(empty)).toEqual(wantEmpty);
  });

  it("encodes labels (3) as one map-entry submessage per key, in insertion order", () => {
    const actual = encodeCreateSandboxRequest({
      spec: { template: { image: DIGEST } },
      labels: { team: "os", env: "live" },
    });
    const template: number[] = [];
    pushString(template, 1, DIGEST);
    const spec: number[] = [];
    pushLenDelim(spec, 6, Uint8Array.from(template));
    const want: number[] = [];
    pushLenDelim(want, 1, Uint8Array.from(spec));
    pushLenDelim(want, 3, mapEntryBytes("team", "os")); // labels = 3
    pushLenDelim(want, 3, mapEntryBytes("env", "live"));
    expect(Array.from(actual)).toEqual(want);
  });
});

describe("encodeGetSandboxRequest / encodeDeleteSandboxRequest (name=1)", () => {
  it("encodes the canonical name at field 1", () => {
    const want: number[] = [];
    pushString(want, 1, "agentos-nc-live");
    expect(Array.from(encodeGetSandboxRequest({ name: "agentos-nc-live" }))).toEqual(want);
    expect(Array.from(encodeDeleteSandboxRequest({ name: "agentos-nc-live" }))).toEqual(want);
  });

  it("omits an empty name (proto3 zero)", () => {
    expect(Array.from(encodeGetSandboxRequest({ name: "" }))).toEqual([]);
    expect(Array.from(encodeDeleteSandboxRequest({ name: "" }))).toEqual([]);
  });
});

describe("decodeSandboxResponse (OS-S2a — nested sandbox{metadata{id,name},status{phase}})", () => {
  it("decodes metadata.id (1) + metadata.name (2) and status.phase (field 6)", () => {
    // ObjectMeta { id=1, name=2 }
    const meta: number[] = [];
    pushString(meta, 1, "11111111-2222-3333-4444-555555555555"); // id = 1
    pushString(meta, 2, "agentos-nc-live"); // name = 2
    // SandboxStatus { phase=6 } — PROVISIONING = 1.
    const status: number[] = [];
    pushTag(status, 6, 0); // phase = 6 (varint enum)
    pushVarint(status, 1); // SANDBOX_PHASE_PROVISIONING
    // Sandbox { metadata=1, status=3 }
    const sandbox: number[] = [];
    pushLenDelim(sandbox, 1, Uint8Array.from(meta)); // metadata = 1
    pushLenDelim(sandbox, 3, Uint8Array.from(status)); // status = 3
    // SandboxResponse { sandbox=1 }
    const resp: number[] = [];
    pushLenDelim(resp, 1, Uint8Array.from(sandbox)); // sandbox = 1

    const decoded = decodeSandboxResponse(Uint8Array.from(resp));
    expect(decoded.sandbox?.metadata?.id).toBe("11111111-2222-3333-4444-555555555555");
    expect(decoded.sandbox?.metadata?.name).toBe("agentos-nc-live");
    expect(decoded.sandbox?.status?.phase).toBe(1);
  });

  it("decodes a READY (2) phase from status.phase field 6", () => {
    const status: number[] = [];
    pushTag(status, 6, 0);
    pushVarint(status, 2); // SANDBOX_PHASE_READY
    const sandbox: number[] = [];
    pushLenDelim(sandbox, 3, Uint8Array.from(status));
    const resp: number[] = [];
    pushLenDelim(resp, 1, Uint8Array.from(sandbox));

    const decoded = decodeSandboxResponse(Uint8Array.from(resp));
    expect(decoded.sandbox?.status?.phase).toBe(2);
  });

  it("SKIPS unknown fields (forward-compatible): an unexpected Sandbox.spec (2) is ignored", () => {
    const meta: number[] = [];
    pushString(meta, 2, "n"); // name = 2
    const status: number[] = [];
    pushTag(status, 6, 0);
    pushVarint(status, 2);
    // An unknown-to-us Sandbox.spec (field 2) the gateway may echo — must be skipped, not derail decode.
    const spec: number[] = [];
    pushString(spec, 1, "ignored-log-level");
    const sandbox: number[] = [];
    pushLenDelim(sandbox, 1, Uint8Array.from(meta));
    pushLenDelim(sandbox, 2, Uint8Array.from(spec)); // spec = 2 (consumed by neither id nor status)
    pushLenDelim(sandbox, 3, Uint8Array.from(status));
    const resp: number[] = [];
    pushLenDelim(resp, 1, Uint8Array.from(sandbox));

    const decoded = decodeSandboxResponse(Uint8Array.from(resp));
    expect(decoded.sandbox?.metadata?.name).toBe("n");
    expect(decoded.sandbox?.status?.phase).toBe(2);
  });

  it("an EMPTY SandboxResponse decodes to an absent sandbox (deny-by-default upstream)", () => {
    const decoded = decodeSandboxResponse(new Uint8Array());
    expect(decoded.sandbox).toBeUndefined();
  });
});

describe("decodeDeleteSandboxResponse (deleted=1 bool)", () => {
  it("decodes deleted=true", () => {
    const out: number[] = [];
    pushTag(out, 1, 0); // deleted = 1 (varint bool)
    pushVarint(out, 1);
    expect(decodeDeleteSandboxResponse(Uint8Array.from(out)).deleted).toBe(true);
  });

  it("decodes an absent deleted as false (proto3 zero)", () => {
    expect(decodeDeleteSandboxResponse(new Uint8Array()).deleted).toBe(false);
  });
});
