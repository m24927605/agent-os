/**
 * RED-first tests for the real SidecarAdapter LedgerTransport (slice P2R-R11-S6).
 *
 * These run against an IN-PROCESS fake `SidecarAdapter` gRPC server bound to a temp Unix Domain
 * Socket (`server.bindAsync('unix://<tmp>.sock', ...)`) — NO Docker, NO TCP, no real SpendGuard. They
 * exercise the ONE job of `createSidecarLedgerTransport`: speak real grpc-js over the UDS to
 * SpendGuard's `ReserveSession` / `CommitSessionDelta` RPCs, and map the served oneof onto the
 * adapter's `{reservationId}|{overBudget}` / `{overrun}` shape — while mapping EVERY transport failure
 * (connection refused, deadline, peercred reject, empty/unexpected oneof) to a REJECT (fail-closed).
 *
 * The transport NEVER resolves a falsy success: the adapter's catch turns a reject into
 * denyReserve/denyCommit (adapter.ts:100-107 / :142-143), so the deny-by-default law (AGENTS.md) holds
 * even though SpendGuard's own predictor fails OPEN.
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
import type {
  CommitSessionDeltaOutcome,
  CommitSessionDeltaRequest,
  ReserveSessionOutcome,
  ReserveSessionRequest,
} from "./_generated/sidecar_adapter.js";
import { createSidecarLedgerTransport } from "./transport.js";
import {
  SIDECAR_ADAPTER_SERVICE,
  decodeCommitSessionDeltaRequestForTest,
  decodeReserveSessionRequestForTest,
  encodeCommitSessionDeltaOutcomeForTest,
  encodeReserveSessionOutcomeForTest,
} from "./transport.js";

const SERVICE_PATH = "/spendguard.sidecar_adapter.v1.SidecarAdapter";

type Handlers = {
  reserve?: (req: ReserveSessionRequest) => ReserveSessionOutcome;
  commit?: (req: CommitSessionDeltaRequest) => CommitSessionDeltaOutcome;
  /** When true, ReserveSession never replies — only the client deadline can settle the call. */
  hangReserve?: boolean;
};

/** Bind an in-process fake `SidecarAdapter` to a fresh temp UDS; resolves the `unix://` path. */
async function startFakeSidecar(handlers: Handlers): Promise<{ udsPath: string; close(): void }> {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-spendguard-uds-"));
  const udsPath = join(dir, "adapter.sock");
  const server = new Server();

  const impl: UntypedServiceImplementation = {
    ReserveSession: (call: ServerUnaryCall<Buffer, Buffer>, cb: sendUnaryData<Buffer>) => {
      if (handlers.hangReserve === true) return; // black hole — never call cb.
      const req = decodeReserveSessionRequestForTest(call.request);
      const out = handlers.reserve?.(req) ?? { outcome: undefined };
      cb(null, encodeReserveSessionOutcomeForTest(out));
    },
    CommitSessionDelta: (call: ServerUnaryCall<Buffer, Buffer>, cb: sendUnaryData<Buffer>) => {
      const req = decodeCommitSessionDeltaRequestForTest(call.request);
      const out = handlers.commit?.(req) ?? { outcome: undefined };
      cb(null, encodeCommitSessionDeltaOutcomeForTest(out));
    },
  };

  server.addService(
    {
      ReserveSession: {
        path: `${SERVICE_PATH}/ReserveSession`,
        requestStream: false,
        responseStream: false,
        requestSerialize: (b: Buffer) => b,
        requestDeserialize: (b: Buffer) => b,
        responseSerialize: (b: Buffer) => b,
        responseDeserialize: (b: Buffer) => b,
      },
      CommitSessionDelta: {
        path: `${SERVICE_PATH}/CommitSessionDelta`,
        requestStream: false,
        responseStream: false,
        requestSerialize: (b: Buffer) => b,
        requestDeserialize: (b: Buffer) => b,
        responseSerialize: (b: Buffer) => b,
        responseDeserialize: (b: Buffer) => b,
      },
    },
    impl,
  );

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
void SIDECAR_ADAPTER_SERVICE;

let fake: { udsPath: string; close(): void } | undefined;

afterEach(() => {
  fake?.close();
  fake = undefined;
});

describe("createSidecarLedgerTransport (R11-S6) over a real UDS", () => {
  it("reserve: maps an accepted outcome to {reservationId}", async () => {
    fake = await startFakeSidecar({
      reserve: () => ({
        outcome: {
          $case: "accepted",
          accepted: {
            sessionReservationId: "resv-123",
            ledgerTransactionId: "ltx-1",
            auditSessionEventId: "evt-1",
            ttlExpiresAt: undefined,
            reservedAmountAtomic: "100",
            remainingAmountAtomic: "900",
          },
        },
      }),
    });
    const transport = createSidecarLedgerTransport({ udsPath: fake.udsPath });

    const res = await transport.reserve({
      tenant_id: "tenant-a",
      estimated_amount_atomic: 100,
      route: "openai/realtime",
    });

    expect(res).toEqual({ reservationId: "resv-123" });
  });

  it("reserve: carries ONLY tenant + amount + route on the wire (credential-blind)", async () => {
    let seen: ReserveSessionRequest | undefined;
    fake = await startFakeSidecar({
      reserve: (req) => {
        seen = req;
        return {
          outcome: {
            $case: "accepted",
            accepted: {
              sessionReservationId: "resv-x",
              ledgerTransactionId: "",
              auditSessionEventId: "",
              ttlExpiresAt: undefined,
              reservedAmountAtomic: "5",
              remainingAmountAtomic: "0",
            },
          },
        };
      },
    });
    const transport = createSidecarLedgerTransport({ udsPath: fake.udsPath });

    await transport.reserve({
      tenant_id: "tenant-a",
      estimated_amount_atomic: 5,
      route: "openai/realtime",
    });

    expect(seen?.tenantId).toBe("tenant-a");
    expect(seen?.estimatedAmountAtomic).toBe("5");
    expect(seen?.route).toBe("openai/realtime");
  });

  it("reserve: a denied outcome (over-budget hard-cap) maps to {overBudget:true}", async () => {
    fake = await startFakeSidecar({
      reserve: () => ({
        outcome: {
          $case: "denied",
          denied: {
            auditSessionEventId: "evt-2",
            reasonCodes: ["BUDGET_EXHAUSTED"],
            matchedRuleIds: [],
            error: undefined,
          },
        },
      }),
    });
    const transport = createSidecarLedgerTransport({ udsPath: fake.udsPath });

    const res = await transport.reserve({
      tenant_id: "tenant-a",
      estimated_amount_atomic: 999999,
      route: "openai/realtime",
    });

    expect(res).toEqual({ overBudget: true });
  });

  it("commit: maps an accepted delta to {overrun:false}", async () => {
    fake = await startFakeSidecar({
      commit: () => ({
        outcome: {
          $case: "accepted",
          accepted: {
            sessionReservationId: "resv-123",
            streamingCommitId: "sc-1",
            ledgerTransactionId: "ltx-2",
            auditSessionEventId: "evt-3",
            committedDeltaAtomic: "50",
            cumulativeCommittedAtomic: "50",
            remainingAmountAtomic: "50",
            recordedAt: undefined,
          },
        },
      }),
    });
    const transport = createSidecarLedgerTransport({ udsPath: fake.udsPath });

    const res = await transport.commit({
      tenant_id: "tenant-a",
      reservation_id: "resv-123",
      amount_atomic_delta: 50,
    });

    expect(res).toEqual({ overrun: false });
  });

  it("commit: an OVERRUN_RESERVATION error outcome maps to {overrun:true} (real spend recorded)", async () => {
    fake = await startFakeSidecar({
      commit: () => ({
        outcome: {
          $case: "error",
          error: {
            code: 15 /* OVERRUN_RESERVATION */,
            message: "delta exceeds remaining",
            details: {},
          },
        },
      }),
    });
    const transport = createSidecarLedgerTransport({ udsPath: fake.udsPath });

    const res = await transport.commit({
      tenant_id: "tenant-a",
      reservation_id: "resv-123",
      amount_atomic_delta: 1_000_000,
    });

    expect(res).toEqual({ overrun: true });
  });

  it("fail-closed: reserve REJECTS when the sidecar is not running (connection refused)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-os-spendguard-dead-"));
    const dead = join(dir, "nope.sock");
    const transport = createSidecarLedgerTransport({ udsPath: dead, timeoutMs: 300 });

    await expect(
      transport.reserve({
        tenant_id: "tenant-a",
        estimated_amount_atomic: 1,
        route: "r",
      }),
    ).rejects.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fail-closed: reserve REJECTS when the deadline expires (server never replies)", async () => {
    // The fake's ReserveSession is a black hole — it never calls cb. ONLY the client-side deadline
    // can settle the call, and it MUST reject (DEADLINE_EXCEEDED), never resolve a falsy success.
    fake = await startFakeSidecar({ hangReserve: true });
    const transport = createSidecarLedgerTransport({ udsPath: fake.udsPath, timeoutMs: 100 });

    await expect(
      transport.reserve({ tenant_id: "t", estimated_amount_atomic: 1, route: "r" }),
    ).rejects.toThrow();
  });

  it("fail-closed: an empty/unexpected reserve oneof REJECTS (never a falsy success)", async () => {
    fake = await startFakeSidecar({
      reserve: () => ({ outcome: undefined }),
    });
    const transport = createSidecarLedgerTransport({ udsPath: fake.udsPath });

    await expect(
      transport.reserve({ tenant_id: "t", estimated_amount_atomic: 1, route: "r" }),
    ).rejects.toThrow();
  });

  it("fail-closed: an empty/unexpected commit oneof REJECTS (never a falsy success)", async () => {
    fake = await startFakeSidecar({
      commit: () => ({ outcome: undefined }),
    });
    const transport = createSidecarLedgerTransport({ udsPath: fake.udsPath });

    await expect(
      transport.commit({ tenant_id: "t", reservation_id: "r", amount_atomic_delta: 1 }),
    ).rejects.toThrow();
  });
});
