/**
 * RED-first tests for the RequestDecision-based LedgerTransport (slice P2R-R11-S8).
 *
 * R11-S7 ground truth: the demo sidecar's session RPCs (ReserveSession / CommitSessionDelta) are
 * `Err(Status::unimplemented)` (services/sidecar/src/server/adapter_uds.rs:142-173). The IMPLEMENTED
 * gating flow is Handshake (:73) -> RequestDecision (:82) -> ConfirmPublishOutcome (:91). So this
 * transport maps the vendor-neutral `LedgerTransport` seam (src/cost/adapters/spendguard/adapter.ts:
 * 65-68) onto THOSE RPCs:
 *   - reserve -> Handshake (lazy, once; obtains session_id) -> RequestDecision(LLM_CALL_PRE):
 *       CONTINUE                       -> {reservationId: decision_id}
 *       STOP / STOP_RUN_PROJECTION     -> {overBudget:true}  (budget/run hard-cap)
 *       any other / unknown / empty    -> THROW (deny-by-default; proto:448 unknown enum fail-closed)
 *   - commit -> ConfirmPublishOutcome(decision_id=reservation_id): a clean response -> {overrun:false}.
 *
 * These run against an IN-PROCESS fake `SidecarAdapter` gRPC server bound to a temp Unix Domain Socket
 * (NO Docker, NO TCP, no real SpendGuard). Every transport failure (connection refused, deadline,
 * empty/unexpected response) maps to a REJECT (fail-closed); the adapter's catch turns a reject into
 * denyReserve/denyCommit, so deny-by-default holds even though SpendGuard's predictor fails OPEN.
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
import {
  type DecisionRequest,
  type DecisionResponse,
  DecisionResponse_Decision,
  type HandshakeResponse,
  type PublishOutcomeRequest,
  type PublishOutcomeResponse,
} from "./_generated/sidecar_adapter.js";
import {
  DECISION_SIDECAR_ADAPTER_SERVICE,
  createDecisionLedgerTransport,
  decodeDecisionIdempotencyKeyForTest,
  decodeDecisionRequestForTest,
  decodeFirstBudgetClaimForTest,
  decodeHandshakeTenantAssertionForTest,
  decodePublishOutcomeRequestForTest,
  encodeDecisionResponseForTest,
  encodeHandshakeResponseForTest,
  encodePublishOutcomeResponseForTest,
} from "./decision-transport.js";

const SERVICE_PATH = "/spendguard.sidecar_adapter.v1.SidecarAdapter";

type Handlers = {
  handshake?: () => Partial<HandshakeResponse>;
  decision?: (req: DecisionRequest) => Partial<DecisionResponse>;
  confirm?: (req: PublishOutcomeRequest) => Partial<PublishOutcomeResponse>;
  /** When true, RequestDecision never replies — only the client deadline can settle the call. */
  hangDecision?: boolean;
  /** Raw-byte captures so a test can assert wire fields the decoded shapes drop (tenant assertion / idempotency). */
  onHandshakeRaw?: (bytes: Buffer) => void;
  onDecisionRaw?: (bytes: Buffer) => void;
};

const DEFAULT_HANDSHAKE: Partial<HandshakeResponse> = {
  sidecarVersion: "fake-1",
  sessionId: "sess-1",
};

/** Bind an in-process fake `SidecarAdapter` to a fresh temp UDS; resolves the `unix://` path. */
async function startFakeSidecar(handlers: Handlers): Promise<{ udsPath: string; close(): void }> {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-spendguard-decision-uds-"));
  const udsPath = join(dir, "adapter.sock");
  const server = new Server();

  const impl: UntypedServiceImplementation = {
    Handshake: (call: ServerUnaryCall<Buffer, Buffer>, cb: sendUnaryData<Buffer>) => {
      handlers.onHandshakeRaw?.(call.request);
      const out = handlers.handshake?.() ?? DEFAULT_HANDSHAKE;
      cb(null, encodeHandshakeResponseForTest(out));
    },
    RequestDecision: (call: ServerUnaryCall<Buffer, Buffer>, cb: sendUnaryData<Buffer>) => {
      if (handlers.hangDecision === true) return; // black hole — never call cb.
      handlers.onDecisionRaw?.(call.request);
      const req = decodeDecisionRequestForTest(call.request);
      const out = handlers.decision?.(req) ?? { decisionId: "", decision: 0 };
      cb(null, encodeDecisionResponseForTest(out));
    },
    ConfirmPublishOutcome: (call: ServerUnaryCall<Buffer, Buffer>, cb: sendUnaryData<Buffer>) => {
      const req = decodePublishOutcomeRequestForTest(call.request);
      const out = handlers.confirm?.(req) ?? { auditOutcomeEventId: "evt" };
      cb(null, encodePublishOutcomeResponseForTest(out));
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

  server.addService(
    {
      Handshake: methodDef("Handshake"),
      RequestDecision: methodDef("RequestDecision"),
      ConfirmPublishOutcome: methodDef("ConfirmPublishOutcome"),
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
void DECISION_SIDECAR_ADAPTER_SERVICE;

let fake: { udsPath: string; close(): void } | undefined;

afterEach(() => {
  fake?.close();
  fake = undefined;
});

const CONTINUE = DecisionResponse_Decision.CONTINUE;
const STOP = DecisionResponse_Decision.STOP;
const STOP_RUN_PROJECTION = DecisionResponse_Decision.STOP_RUN_PROJECTION;

// A reserve now REQUIRES a budget projection (the real sidecar rejects an empty projected_claims set);
// these are cost-accounting identifiers, never credentials. Tests that exercise reserve supply this.
const TEST_CLAIM = {
  budgetId: "44444444-4444-4444-8444-444444444444",
  unitId: "66666666-6666-4666-8666-666666666666",
  windowInstanceId: "55555555-5555-4555-8555-555555555555",
} as const;

describe("createDecisionLedgerTransport (R11-S8) over a real UDS", () => {
  it("reserve: a CONTINUE decision maps to {reservationId: decision_id}", async () => {
    fake = await startFakeSidecar({
      decision: () => ({ decisionId: "dec-123", decision: CONTINUE }),
    });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      budgetClaim: TEST_CLAIM,
    });

    const res = await transport.reserve({
      tenant_id: "tenant-a",
      estimated_amount_atomic: 100,
      route: "openai/realtime",
    });

    expect(res).toEqual({ reservationId: "dec-123" });
  });

  it("reserve: Handshake runs first and its session_id is threaded into RequestDecision", async () => {
    let seen: DecisionRequest | undefined;
    let handshakes = 0;
    fake = await startFakeSidecar({
      handshake: () => {
        handshakes += 1;
        return { sidecarVersion: "fake-1", sessionId: "sess-xyz" };
      },
      decision: (req) => {
        seen = req;
        return { decisionId: "dec-x", decision: CONTINUE };
      },
    });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      budgetClaim: TEST_CLAIM,
    });

    await transport.reserve({ tenant_id: "t", estimated_amount_atomic: 5, route: "r1" });
    await transport.reserve({ tenant_id: "t", estimated_amount_atomic: 7, route: "r2" });

    expect(handshakes).toBe(1); // handshake is established ONCE, then reused.
    expect(seen?.sessionId).toBe("sess-xyz");
    expect(seen?.trigger).toBe(3 /* LLM_CALL_PRE */);
    expect(seen?.route).toBe("r2");
  });

  it("reserve: carries ONLY cost projection + route + session id (credential-blind)", async () => {
    let seen: DecisionRequest | undefined;
    fake = await startFakeSidecar({
      decision: (req) => {
        seen = req;
        return { decisionId: "dec-x", decision: CONTINUE };
      },
    });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      budgetClaim: TEST_CLAIM,
    });

    await transport.reserve({
      tenant_id: "tenant-a",
      estimated_amount_atomic: 4242,
      route: "openai/realtime",
    });

    // The projected cost is mapped into the risk-band p* fields as a base-10 atomic string.
    expect(seen?.route).toBe("openai/realtime");
    expect(seen?.inputs?.projectedP95Atomic).toBe("4242");
    // No credential anywhere on the wire request (no field carries one by construction).
    expect(JSON.stringify(seen)).not.toMatch(
      /secret|token|password|bearer|credential|api[_-]?key/i,
    );
  });

  // --- live-discovered regressions (R11-S8 fix): the fake never checked these, so the encoder silently
  // dropped them and only the REAL sidecar rejected (PERMISSION_DENIED / INVALID_ARGUMENT). Pin them here.
  it("handshake ENCODES the configured tenant_id_assertion on the wire (field 5)", async () => {
    let rawHandshake: Buffer | undefined;
    fake = await startFakeSidecar({
      onHandshakeRaw: (b) => {
        rawHandshake = b;
      },
      decision: () => ({ decisionId: "d", decision: CONTINUE }),
    });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      tenantIdAssertion: "00000000-0000-4000-8000-000000000001",
      budgetClaim: TEST_CLAIM,
    });
    await transport.reserve({ tenant_id: "t", estimated_amount_atomic: 5, route: "r" });
    expect(rawHandshake).toBeDefined();
    expect(decodeHandshakeTenantAssertionForTest(rawHandshake as Buffer)).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("RequestDecision ENCODES a non-empty idempotency.key on the wire (field 9 -> key)", async () => {
    let rawDecision: Buffer | undefined;
    fake = await startFakeSidecar({
      onDecisionRaw: (b) => {
        rawDecision = b;
      },
      decision: () => ({ decisionId: "d", decision: CONTINUE }),
    });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      budgetClaim: TEST_CLAIM,
    });
    await transport.reserve({ tenant_id: "t", estimated_amount_atomic: 5, route: "r" });
    expect(rawDecision).toBeDefined();
    expect(decodeDecisionIdempotencyKeyForTest(rawDecision as Buffer).length).toBeGreaterThan(0);
  });

  // --- R11-S10: projected BudgetClaim (live-discovered 3rd gate — the real sidecar rejects empty claims).
  it("reserve ENCODES the configured projected BudgetClaim on the wire (budget/unit/amount/direction/window)", async () => {
    let rawDecision: Buffer | undefined;
    fake = await startFakeSidecar({
      onDecisionRaw: (b) => {
        rawDecision = b;
      },
      decision: () => ({ decisionId: "d", decision: CONTINUE }),
    });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      budgetClaim: TEST_CLAIM,
    });
    await transport.reserve({ tenant_id: "t", estimated_amount_atomic: 42, route: "r" });
    expect(rawDecision).toBeDefined();
    const claim = decodeFirstBudgetClaimForTest(rawDecision as Buffer);
    expect(claim).toBeDefined();
    expect(claim).toMatchObject({
      budgetId: TEST_CLAIM.budgetId,
      unitId: TEST_CLAIM.unitId,
      windowInstanceId: TEST_CLAIM.windowInstanceId,
      amountAtomic: "42", // token unit scale=0 -> amount_atomic == estimatedTokens
      direction: 1, // DEBIT
    });
  });

  it("reserve WITHOUT a budgetClaim fails CLOSED (no empty/bogus claim is sent)", async () => {
    fake = await startFakeSidecar({ decision: () => ({ decisionId: "d", decision: CONTINUE }) });
    const transport = createDecisionLedgerTransport({ udsPath: fake.udsPath }); // no budgetClaim
    await expect(
      transport.reserve({ tenant_id: "t", estimated_amount_atomic: 5, route: "r" }),
    ).rejects.toThrow(/budgetClaim|fail-closed/i);
  });

  it("reserve: a STOP decision (per-call budget) maps to {overBudget:true}", async () => {
    fake = await startFakeSidecar({
      decision: () => ({ decisionId: "dec-stop", decision: STOP }),
    });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      budgetClaim: TEST_CLAIM,
    });

    const res = await transport.reserve({
      tenant_id: "tenant-a",
      estimated_amount_atomic: 999999,
      route: "openai/realtime",
    });

    expect(res).toEqual({ overBudget: true });
  });

  it("reserve: a STOP_RUN_PROJECTION decision (run hard-cap) maps to {overBudget:true}", async () => {
    fake = await startFakeSidecar({
      decision: () => ({ decisionId: "dec-stop-run", decision: STOP_RUN_PROJECTION }),
    });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      budgetClaim: TEST_CLAIM,
    });

    const res = await transport.reserve({
      tenant_id: "tenant-a",
      estimated_amount_atomic: 999999,
      route: "openai/realtime",
    });

    expect(res).toEqual({ overBudget: true });
  });

  it("commit: ConfirmPublishOutcome on a reservation maps to {overrun:false}", async () => {
    let seen: PublishOutcomeRequest | undefined;
    fake = await startFakeSidecar({
      confirm: (req) => {
        seen = req;
        return { auditOutcomeEventId: "evt-1" };
      },
    });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      budgetClaim: TEST_CLAIM,
    });

    const res = await transport.commit({
      tenant_id: "tenant-a",
      reservation_id: "dec-123",
      amount_atomic_delta: 50,
    });

    expect(res).toEqual({ overrun: false });
    expect(seen?.decisionId).toBe("dec-123"); // decision_id == the reservation id we handed back.
  });

  it("fail-closed: a DEGRADE decision REJECTS (deny-by-default, never a falsy allow)", async () => {
    fake = await startFakeSidecar({
      decision: () => ({ decisionId: "dec-deg", decision: DecisionResponse_Decision.DEGRADE }),
    });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      budgetClaim: TEST_CLAIM,
    });

    await expect(
      transport.reserve({ tenant_id: "t", estimated_amount_atomic: 1, route: "r" }),
    ).rejects.toThrow();
  });

  it("fail-closed: an UNSPECIFIED / unknown decision enum REJECTS (proto:448 fail-closed)", async () => {
    fake = await startFakeSidecar({
      decision: () => ({ decisionId: "dec-u", decision: 0 /* DECISION_UNSPECIFIED */ }),
    });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      budgetClaim: TEST_CLAIM,
    });

    await expect(
      transport.reserve({ tenant_id: "t", estimated_amount_atomic: 1, route: "r" }),
    ).rejects.toThrow();
  });

  it("fail-closed: a CONTINUE with an EMPTY decision_id REJECTS (no usable reservation)", async () => {
    fake = await startFakeSidecar({
      decision: () => ({ decisionId: "", decision: CONTINUE }),
    });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      budgetClaim: TEST_CLAIM,
    });

    await expect(
      transport.reserve({ tenant_id: "t", estimated_amount_atomic: 1, route: "r" }),
    ).rejects.toThrow();
  });

  it("fail-closed: reserve REJECTS when the sidecar is not running (connection refused)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-os-spendguard-decision-dead-"));
    const dead = join(dir, "nope.sock");
    const transport = createDecisionLedgerTransport({ udsPath: dead, timeoutMs: 300 });

    await expect(
      transport.reserve({ tenant_id: "t", estimated_amount_atomic: 1, route: "r" }),
    ).rejects.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fail-closed: reserve REJECTS when the decision deadline expires (server never replies)", async () => {
    fake = await startFakeSidecar({ hangDecision: true });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      timeoutMs: 100,
      budgetClaim: TEST_CLAIM,
    });

    await expect(
      transport.reserve({ tenant_id: "t", estimated_amount_atomic: 1, route: "r" }),
    ).rejects.toThrow();
  });

  it("fail-closed: commit REJECTS when ConfirmPublishOutcome returns an error", async () => {
    fake = await startFakeSidecar({
      confirm: () => ({
        auditOutcomeEventId: "",
        error: { code: 11 /* AUDIT_INVARIANT_VIOLATED */, message: "bad", details: {} },
      }),
    });
    const transport = createDecisionLedgerTransport({
      udsPath: fake.udsPath,
      budgetClaim: TEST_CLAIM,
    });

    await expect(
      transport.commit({ tenant_id: "t", reservation_id: "dec-1", amount_atomic_delta: 1 }),
    ).rejects.toThrow();
  });
});
