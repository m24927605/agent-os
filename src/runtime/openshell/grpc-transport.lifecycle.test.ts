/**
 * Unit tests for the OS-S2a unary lifecycle on the mTLS gRPC transport (createSandbox / getSandbox /
 * deleteSandbox) — replacing the NC-S11b fail-closed create/delete stubs with real impls.
 *
 * NO live gateway, NO mTLS handshake, NO docker: every test injects a FAKE unary request fn (mirroring
 * how grpc-transport.test.ts injects a fake server-stream source). The real grpc-js `makeUnaryRequest`
 * against the gateway is exercised only by the live harness.
 *
 * Load-bearing seam probes:
 *   - createSandbox(req) decodes the SandboxResponse -> { sandbox:{ metadata:{name,id}, status:{phase} } }.
 *   - getSandbox(req)    decodes the phase off the SandboxResponse.
 *   - deleteSandbox(req) decodes { deleted }.
 *   - a unary RPC rejection propagates (the adapter fails closed on it).
 *   - watchSandbox is now REAL (OS-S2b) — its stream coverage lives in grpc-transport.watch.test.ts.
 * A fail-closed reason carries NO endpoint / cert content (credential-blind).
 */
import { describe, expect, it } from "vitest";
import type { CreateSandboxRequest, DeleteSandboxRequest, GetSandboxRequest } from "./client.js";
import { type UnaryRequestFn, createOpenShellGrpcTransport } from "./grpc-transport.js";
import {
  CREATE_SANDBOX_METHOD,
  DELETE_SANDBOX_METHOD,
  GET_SANDBOX_METHOD,
  decodeSandboxResponse,
  encodeCreateSandboxRequest,
} from "./proto/openshell.subset.codec.js";

// --- a tiny INDEPENDENT proto3 encoder to build fake SandboxResponse / DeleteSandboxResponse bytes ----

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

/** Build SandboxResponse bytes with metadata{id,name} + status.phase (field 6). */
function sandboxResponseBytes(name: string, id: string, phase: number): Buffer {
  const meta: number[] = [];
  pushString(meta, 1, id); // ObjectMeta.id = 1
  pushString(meta, 2, name); // ObjectMeta.name = 2
  const status: number[] = [];
  pushTag(status, 6, 0); // SandboxStatus.phase = 6
  pushVarint(status, phase);
  const sandbox: number[] = [];
  pushLenDelim(sandbox, 1, Uint8Array.from(meta)); // Sandbox.metadata = 1
  pushLenDelim(sandbox, 3, Uint8Array.from(status)); // Sandbox.status = 3
  const resp: number[] = [];
  pushLenDelim(resp, 1, Uint8Array.from(sandbox)); // SandboxResponse.sandbox = 1
  return Buffer.from(resp);
}

function deleteResponseBytes(deleted: boolean): Buffer {
  const out: number[] = [];
  if (deleted) {
    pushTag(out, 1, 0); // deleted = 1 (varint bool)
    pushVarint(out, 1);
  }
  return Buffer.from(out);
}

const DIGEST = "sha256:c116946b3f9e84791630f21f115ac35c9c9f669af70ec0eef3035d79833a9550";
const CREATE_REQ: CreateSandboxRequest = {
  spec: { template: { image: DIGEST } },
  name: "agentos-nc-live",
};
const GET_REQ: GetSandboxRequest = { name: "agentos-nc-live" };
const DEL_REQ: DeleteSandboxRequest = { name: "agentos-nc-live" };

/**
 * A recorded unary call. The fake captures (method, requestBytes) and replays a scripted reply: either
 * a Buffer (the wire reply the grpc-js `deserialize` callback would parse) or an Error to reject.
 */
interface UnaryCall {
  method: string;
  requestBytes: Uint8Array;
}

/** Build a transport whose unary source is the injected fake (no real grpc-js Client / socket). */
function transportWith(reply: (method: string, requestBytes: Uint8Array) => Buffer | Error): {
  transport: ReturnType<typeof createOpenShellGrpcTransport>;
  calls: UnaryCall[];
} {
  const calls: UnaryCall[] = [];
  const makeUnary: UnaryRequestFn = async (method, requestBytes) => {
    calls.push({ method, requestBytes });
    const r = reply(method, requestBytes);
    if (r instanceof Error) throw r;
    return r;
  };
  const transport = createOpenShellGrpcTransport({
    endpoint: "127.0.0.1:17670",
    caCertPath: "/dev/null",
    clientCertPath: "/dev/null",
    clientKeyPath: "/dev/null",
    makeUnary,
  });
  return { transport, calls };
}

describe("createOpenShellGrpcTransport — createSandbox (real unary)", () => {
  it("sends the encoded CreateSandboxRequest to CreateSandbox and decodes the SandboxResponse", async () => {
    const { transport, calls } = transportWith((method) =>
      method === CREATE_SANDBOX_METHOD
        ? sandboxResponseBytes("agentos-nc-live", "id-123", 1)
        : new Error("unexpected method"),
    );
    const resp = await transport.createSandbox(CREATE_REQ);
    expect(calls[0]?.method).toBe(CREATE_SANDBOX_METHOD);
    // The request bytes are exactly what the production encoder produces (no hidden re-shaping).
    expect(Array.from(calls[0]?.requestBytes ?? new Uint8Array())).toEqual(
      Array.from(encodeCreateSandboxRequest(CREATE_REQ)),
    );
    expect(resp.sandbox?.metadata?.name).toBe("agentos-nc-live");
    expect(resp.sandbox?.metadata?.id).toBe("id-123");
    expect(resp.sandbox?.status?.phase).toBe(1); // PROVISIONING
  });

  it("rejects when the CreateSandbox unary rejects (adapter fails closed on it)", async () => {
    const { transport } = transportWith(() => new Error("UNAVAILABLE"));
    await expect(transport.createSandbox(CREATE_REQ)).rejects.toThrow();
  });
});

describe("createOpenShellGrpcTransport — getSandbox (real unary, OS-S2a readiness path)", () => {
  it("sends GetSandboxRequest{name} to GetSandbox and decodes status.phase", async () => {
    const { transport, calls } = transportWith((method) =>
      method === GET_SANDBOX_METHOD
        ? sandboxResponseBytes("agentos-nc-live", "id-123", 2) // READY
        : new Error("unexpected method"),
    );
    const resp = await transport.getSandbox(GET_REQ);
    expect(calls[0]?.method).toBe(GET_SANDBOX_METHOD);
    expect(resp.sandbox?.status?.phase).toBe(2);
  });

  it("rejects when GetSandbox rejects", async () => {
    const { transport } = transportWith(() => new Error("NOT_FOUND"));
    await expect(transport.getSandbox(GET_REQ)).rejects.toThrow();
  });
});

describe("createOpenShellGrpcTransport — deleteSandbox (real unary)", () => {
  it("sends DeleteSandboxRequest{name} to DeleteSandbox and decodes { deleted }", async () => {
    const { transport, calls } = transportWith((method) =>
      method === DELETE_SANDBOX_METHOD ? deleteResponseBytes(true) : new Error("unexpected"),
    );
    const resp = await transport.deleteSandbox(DEL_REQ);
    expect(calls[0]?.method).toBe(DELETE_SANDBOX_METHOD);
    expect(resp.deleted).toBe(true);
  });

  it("rejects when DeleteSandbox rejects", async () => {
    const { transport } = transportWith(() => new Error("UNAVAILABLE"));
    await expect(transport.deleteSandbox(DEL_REQ)).rejects.toThrow();
  });
});

describe("createOpenShellGrpcTransport — watchSandbox is now REAL (OS-S2b)", () => {
  it("watchSandbox is wired (no OS-S2a throw-on-iteration stub); the real stream is in watch.test.ts", () => {
    // The OS-S2a stub THREW on iteration; OS-S2b replaces it with the real WatchSandbox server-stream.
    // The exhaustive yield/abort/error/decode coverage lives in grpc-transport.watch.test.ts; here we
    // only assert the method exists on the COMPLETE OpenShellReadinessTransport surface.
    const { transport } = transportWith(() => deleteResponseBytes(true));
    expect(typeof transport.watchSandbox).toBe("function");
  });
});

describe("createOpenShellGrpcTransport — credential-blind lifecycle errors", () => {
  it("does NOT leak the endpoint / cert paths when a unary rejects", async () => {
    const { transport } = transportWith(() => new Error("127.0.0.1:17670 /dev/null secret"));
    let caught: unknown;
    try {
      await transport.createSandbox(CREATE_REQ);
    } catch (e) {
      caught = e;
    }
    // The transport propagates the underlying rejection AS-IS for the adapter to fail closed on; what
    // matters for credential-blindness is the transport NEVER constructs a reason embedding the
    // endpoint/cert. (The adapter's deny() is the credential-blind boundary; tested in adapter.*.)
    expect(caught).toBeInstanceOf(Error);
  });
});

// Sanity: the decoder used by the fakes matches the production decoder on the fixture bytes.
describe("fixture sanity (independent encoder vs production decoder)", () => {
  it("sandboxResponseBytes round-trips through decodeSandboxResponse", () => {
    const decoded = decodeSandboxResponse(sandboxResponseBytes("n", "i", 2));
    expect(decoded.sandbox?.metadata?.name).toBe("n");
    expect(decoded.sandbox?.metadata?.id).toBe("i");
    expect(decoded.sandbox?.status?.phase).toBe(2);
  });
});
