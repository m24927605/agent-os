/**
 * SLICE-R9b-2a — createAgtDecisionTransport unit tests (RED-first).
 *
 * The transport speaks real grpc-js to OUR AGT `AgtDecision.Evaluate` contract over a Unix Domain
 * Socket. These tests run against an IN-PROCESS fake `AgtDecision` gRPC server bound to a temp UDS —
 * NO Docker, NO TCP, no real Python sidecar. Pinned facts:
 *   - LAZY: construction does NOT connect (a transport built against a dead/never-bound socket throws
 *     only when a call is made, not at construction).
 *   - ROUND-TRIP: a served { allowed:true, action:"allow" } decodes back through the hand-written
 *     proto3 wire codecs.
 *   - CREDENTIAL-BLIND ON THE WIRE: the AgtEvaluateRequest the server receives carries the neutral
 *     fields + the projection, and no credential-shaped field.
 *   - DEADLINE: a server that never replies -> the per-call deadline REJECTS (fail-closed), never hangs.
 *   - MALFORMED / unreachable -> REJECT (fail-closed).
 *
 * Every ephemeral server is force-shut + its temp dir removed in afterEach (no orphan sockets).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Server,
  ServerCredentials,
  type ServerUnaryCall,
  type UntypedServiceImplementation,
  type sendUnaryData,
} from "@grpc/grpc-js";
import { afterEach, describe, expect, it } from "vitest";
import type { AgtEvaluateRequest, AgtEvaluateResponse } from "./_generated/agt_decision.js";
import {
  AGT_DECISION_SERVICE,
  createAgtDecisionTransport,
  decodeAgtEvaluateRequestForTest,
  encodeAgtEvaluateResponseForTest,
} from "./decision-transport.js";

const SERVICE_PATH = "/agentos.agt.decision.v1.AgtDecision";

type Handlers = {
  evaluate?: (req: AgtEvaluateRequest) => Partial<AgtEvaluateResponse>;
  /** When true, Evaluate never replies — only the client deadline can settle the call. */
  hang?: boolean;
  /** When true, reply with raw garbage bytes (a malformed response on the wire). */
  garbage?: boolean;
  onEvaluateRaw?: (bytes: Buffer) => void;
};

async function startFakeAgt(handlers: Handlers): Promise<{ udsPath: string; close(): void }> {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-agt-decision-uds-"));
  const udsPath = join(dir, "agt.sock");
  const server = new Server();

  const impl: UntypedServiceImplementation = {
    Evaluate: (call: ServerUnaryCall<Buffer, Buffer>, cb: sendUnaryData<Buffer>) => {
      if (handlers.hang === true) return; // black hole — never call cb.
      handlers.onEvaluateRaw?.(call.request);
      if (handlers.garbage === true) {
        // A length-delimited field with a length that overruns the buffer -> decoder fails closed.
        cb(null, Buffer.from([0x0a, 0xff, 0xff, 0xff, 0x0f]));
        return;
      }
      const req = decodeAgtEvaluateRequestForTest(call.request);
      const out = handlers.evaluate?.(req) ?? { allowed: false, action: "" };
      cb(null, encodeAgtEvaluateResponseForTest(out));
    },
  };

  const methodDef = (name: string) => ({
    path: `${SERVICE_PATH}/${name}`,
    requestStream: false,
    responseStream: false,
    requestSerialize: (b: Buffer) => b,
    requestDeserialize: (b: Buffer) => b,
    responseSerialize: (b: Buffer) => b,
    responseDeserialize: (b: Buffer) => b,
  });

  server.addService({ Evaluate: methodDef("Evaluate") }, impl);

  await new Promise<void>((resolve, reject) => {
    server.bindAsync(`unix://${udsPath}`, ServerCredentials.createInsecure(), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  return {
    udsPath,
    close() {
      server.forceShutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Touch the exported service descriptor so the test fails to import if it is absent (RED proof).
void AGT_DECISION_SERVICE;

let fake: { udsPath: string; close(): void } | undefined;

afterEach(() => {
  fake?.close();
  fake = undefined;
});

const NEUTRAL: AgtEvaluateRequest = {
  requestId: "req-1",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "exec.run",
  resource: "exec/run",
  governanceProjection: {
    version: 1,
    operationClass: "filesystem",
    argv0: "rm",
    argc: 2,
    argvRedacted: ["rm", "-rf"],
    truncated: false,
    usesShellInterpreter: false,
    networkHosts: [],
    destructiveFlags: ["-rf"],
  },
};

describe("createAgtDecisionTransport — lazy construction", () => {
  it("construction does NOT connect (no throw when the socket was never bound)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-os-agt-decision-lazy-"));
    const dead = join(dir, "never.sock");
    // Building the transport must not connect / throw — the channel is lazy.
    expect(() => createAgtDecisionTransport({ udsPath: dead })).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("createAgtDecisionTransport — round-trip over a real UDS", () => {
  it("an allow decision round-trips through the wire codecs", async () => {
    fake = await startFakeAgt({
      evaluate: () => ({ allowed: true, action: "allow", matchedRule: "r-1", reason: "ok" }),
    });
    const transport = createAgtDecisionTransport({ udsPath: fake.udsPath });
    const resp = await transport.evaluate(NEUTRAL);
    expect(resp.allowed).toBe(true);
    expect(resp.action).toBe("allow");
    expect(resp.matchedRule).toBe("r-1");
    expect(resp.reason).toBe("ok");
  });

  it("the server receives the neutral fields + projection and NO credential-shaped field", async () => {
    let seen: AgtEvaluateRequest | undefined;
    fake = await startFakeAgt({
      evaluate: (r) => {
        seen = r;
        return { allowed: true, action: "allow" };
      },
    });
    const transport = createAgtDecisionTransport({ udsPath: fake.udsPath });
    await transport.evaluate(NEUTRAL);
    expect(seen?.requestId).toBe("req-1");
    expect(seen?.tenantId).toBe("tenant-a");
    expect(seen?.action).toBe("exec.run");
    expect(seen?.governanceProjection?.operationClass).toBe("filesystem");
    expect(seen?.governanceProjection?.destructiveFlags).toContain("-rf");
    expect(JSON.stringify(seen)).not.toMatch(/secret|password|bearer|credential|api[_-]?key/i);
  });
});

describe("createAgtDecisionTransport — fail-closed", () => {
  it("REJECTS when the sidecar is not running (connection refused)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-os-agt-decision-dead-"));
    const dead = join(dir, "nope.sock");
    const transport = createAgtDecisionTransport({ udsPath: dead, deadlineMs: 300 });
    await expect(transport.evaluate(NEUTRAL)).rejects.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("REJECTS when the deadline expires (server never replies)", async () => {
    fake = await startFakeAgt({ hang: true });
    const transport = createAgtDecisionTransport({ udsPath: fake.udsPath, deadlineMs: 100 });
    await expect(transport.evaluate(NEUTRAL)).rejects.toThrow();
  });

  it("REJECTS on a malformed response (truncated length-delimited field)", async () => {
    fake = await startFakeAgt({ garbage: true });
    const transport = createAgtDecisionTransport({ udsPath: fake.udsPath, deadlineMs: 500 });
    await expect(transport.evaluate(NEUTRAL)).rejects.toThrow();
  });
});
