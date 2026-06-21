/**
 * COMPOSITION-ROOT end-to-end proof (slice P2R-R2-S7).
 *
 * This is the wiring sink of R2: the six prior slices — core S1-S4 (AppendTransport port + parser,
 * IngestClient, dedup, capped outbox), contract S5 (proto TS stub), and the concrete RPC adapter S6 —
 * are composed into ONE `CommitAppender<AuditEvent, AppendReceipt>` that REPLACES the P2-I in-memory
 * appender. It exercises `runGovernedToolCall` (P2-I orchestration) against the REAL ingest appender,
 * driven by `createRpcAppendTransport` (S6) over an IN-PROCESS fake `AppendService` stub — no external
 * Go process, no network.
 *
 * The composition root is the ONLY layer allowed to see both the runtime adapter (src/runtime/ingest)
 * and the core ingest appender (src/audit/ingest) at once (design §2). It proves three invariants:
 *   1. HAPPY: a clean call -> `executed`, the effect ran EXACTLY ONCE, and the append (audit) happened
 *      BEFORE the effect (commit-before-effect; mirrored from the P2-I invocation-count spy).
 *   2. FAIL-CLOSED: a transport reject/timeout -> `denied@commit`, the effect ran ZERO times (asserted
 *      against a FakeSandboxAdapter — no sandbox was ever created).
 *   3. REPLACEMENT COMPLETENESS: the pipeline appender is the REAL ingest client, NOT the in-memory
 *      `AppendOnlyLog` (asserted by the receipt carrying the kernel-computed chain fields the in-memory
 *      log never returns for an injected fake, plus a static import-shape assertion).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryCostGate } from "../../cost/index.js";
import { runGovernedToolCall } from "../../orchestration/index.js";
import {
  AppendError_Code,
  type AppendRequest,
  type AppendResponse,
  type AppendService,
} from "../../runtime/_generated/ingest/ingest.js";
import { createRpcAppendTransport } from "../../runtime/ingest/index.js";
import { FakeSandboxAdapter } from "../../runtime/substrate/index.js";
import { createAuditEvent } from "../event.js";
import { createIngestAppender } from "./wire.js";

const ctx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

/** A minimal valid AuditEvent (the appender canonicalizes -> redacts -> sends its bytes). */
function auditEvent() {
  return createAuditEvent({
    requestId: ctx.requestId,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    taskId: ctx.taskId,
    actorId: ctx.actorId,
    action: "tool:invoke",
    resource: "send-prod",
    policyDecision: { effect: "allow", reason: "allowed" },
    result: "success",
  });
}

/**
 * An in-process `AppendService` whose Append is driven by an injected handler. `served` records
 * each request, so a test can assert the order: an append must be recorded BEFORE the effect runs.
 */
function stubService(handler: (req: AppendRequest, callIndex: number) => Promise<AppendResponse>): {
  service: AppendService;
  served: AppendRequest[];
} {
  const served: AppendRequest[] = [];
  return {
    served,
    service: {
      Append(req: AppendRequest): Promise<AppendResponse> {
        const idx = served.push(req) - 1;
        return handler(req, idx);
      },
    },
  };
}

/** A served receipt oneof — the kernel-computed chain fields the in-memory log can't fake. */
function receiptResponse(req: AppendRequest): AppendResponse {
  return {
    result: {
      $case: "receipt",
      receipt: {
        sequence: req.sequence,
        contentHash: "sha256:c0ffee",
        prevHash: "sha256:beef",
        entryHash: "sha256:dead",
      },
    },
  };
}

/** Build pipeline deps wired to the REAL ingest appender over the given in-process service. */
function makeDeps(service: AppendService, fake: FakeSandboxAdapter, order: string[]) {
  const transport = createRpcAppendTransport({ endpoint: "passthrough:fake", client: service });
  const appender = createIngestAppender({ transport, sourceId: "tenant-a:proj-1" });
  return {
    screen: () => ({ ok: true as const }),
    authorize: () => ({ effect: "allow" as const, reason: "allowed" }),
    cost: new InMemoryCostGate(1000),
    estimateTokens: () => 10,
    appender,
    effect: async () => {
      order.push("effect");
      const res = await fake.createSandbox(ctx, { image: "send-prod" });
      return { ok: res.status === "ok", detail: res.status };
    },
  };
}

describe("composition root: real ingest appender replaces the P2-I in-memory appender (S7)", () => {
  it("HAPPY: executed, effect ran EXACTLY ONCE, and the append happened BEFORE the effect", async () => {
    const order: string[] = [];
    const { service, served } = stubService(async (req) => {
      order.push("append");
      return receiptResponse(req);
    });
    const fake = new FakeSandboxAdapter();

    const out = await runGovernedToolCall(makeDeps(service, fake, order), {
      tool: "send-prod",
      context: ctx,
    });

    expect(out.status).toBe("executed");
    // The receipt is the kernel-computed chain head from the REAL ingest path (not an in-memory stub).
    if (out.status === "executed") {
      expect(out.receipt).toMatchObject({ entryHash: "sha256:dead", prevHash: "sha256:beef" });
    }
    expect(served).toHaveLength(1); // appended exactly once
    expect(order).toEqual(["append", "effect"]); // commit-before-effect ordering holds across the seam
    expect((await fake.startSandbox(ctx, "sbx-fake-1")).status).toBe("ok"); // the effect really ran once
  });

  it("FAIL-CLOSED: a transport reject -> denied@commit, the effect ran ZERO times (no sandbox)", async () => {
    const order: string[] = [];
    const { service } = stubService(() => Promise.reject(new Error("connection refused")));
    const fake = new FakeSandboxAdapter();

    const out = await runGovernedToolCall(makeDeps(service, fake, order), {
      tool: "send-prod",
      context: ctx,
    });

    expect(out).toMatchObject({ status: "denied", stage: "commit" });
    expect(order).toEqual([]); // the effect was never reached
    expect((await fake.startSandbox(ctx, "sbx-fake-1")).status).toBe("denied"); // no sandbox was created
  });

  it("FAIL-CLOSED: a server error oneof (denied append) -> denied@commit, ZERO effect", async () => {
    const order: string[] = [];
    const { service } = stubService(() =>
      Promise.resolve({
        result: { $case: "error", error: { code: AppendError_Code.MALFORMED, detail: "field" } },
      }),
    );
    const fake = new FakeSandboxAdapter();

    const out = await runGovernedToolCall(makeDeps(service, fake, order), {
      tool: "send-prod",
      context: ctx,
    });

    expect(out).toMatchObject({ status: "denied", stage: "commit" });
    expect(order).toEqual([]);
  });

  it("createIngestAppender alone: append() returns the kernel receipt for a valid AuditEvent", async () => {
    const { service, served } = stubService(async (req) => receiptResponse(req));
    const transport = createRpcAppendTransport({ endpoint: "passthrough:fake", client: service });
    const appender = createIngestAppender({ transport, sourceId: "tenant-a:proj-1" });

    const receipt = await appender.append(auditEvent());
    expect(receipt).toMatchObject({ entryHash: "sha256:dead", sequence: 0 });
    expect(served).toHaveLength(1);
  });

  it("REPLACEMENT COMPLETENESS: the wiring + pipeline never import the in-memory AppendOnlyLog as the appender", () => {
    // Static guard against regressing to the in-memory appender: neither the composition convenience
    // (wire.ts) nor the orchestration pipeline (pipeline.ts) may reach for the in-memory `AppendOnlyLog`.
    // The appender is built ONLY from `createIngestClient` over an injected transport.
    const wireSrc = readFileSync(new URL("./wire.ts", import.meta.url), "utf8");
    const pipelineSrc = readFileSync(
      new URL("../../orchestration/pipeline.ts", import.meta.url),
      "utf8",
    );
    expect(wireSrc).toContain("createIngestClient");
    // A WORD-BOUNDED match so the prose comment "(`AppendOnlyLog.append`)" does not count: an actual
    // import/use of the symbol would appear as `AppendOnlyLog(` or `import ... AppendOnlyLog`.
    expect(/\bimport\b[^;]*\bAppendOnlyLog\b/.test(wireSrc)).toBe(false);
    expect(/\bnew\s+AppendOnlyLog\b/.test(wireSrc)).toBe(false);
    expect(/\bimport\b[^;]*\bAppendOnlyLog\b/.test(pipelineSrc)).toBe(false);
    expect(/\bnew\s+AppendOnlyLog\b/.test(pipelineSrc)).toBe(false);
  });
});
