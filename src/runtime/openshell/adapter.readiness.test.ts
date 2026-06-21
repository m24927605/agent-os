/**
 * RED-first tests for SLICE-P2R-R1-S3 — GetSandbox / WatchSandbox readiness (phase -> ok/deny).
 *
 * These assert the behaviours + security invariants of §5 of the slice spec
 * (docs/slices/phase-2-remaining/P2R-R1-S3-getsandbox-watch-readiness.md) BEFORE any
 * `awaitReady` implementation exists. They MUST be SEEN to fail first (the transport seam has no
 * `getSandbox`/`watchSandbox` and the adapter has no `awaitReady`).
 *
 * No live OpenShell server exists in this environment (design §7.4): every test drives the adapter
 * through an INJECTED transport double that mimics the S1/S2 `OpenShellLifecycleTransport` seam
 * extended with the S3 `getSandbox` unary + `watchSandbox` server-stream primitives. The
 * load-bearing security probe (deny-by-default): an unknown phase enum, a stream that errors before
 * READY, a deadline that elapses before READY, OR an unknown sandbox id ALL fail CLOSED (denied,
 * never READY); the adapter NEVER throws across the port boundary and a denied reason NEVER leaks
 * baseUrl / endpoint / credential detail.
 */
import { describe, expect, it, vi } from "vitest";
import { OpenShellSandboxAdapter } from "./adapter.js";
import { PINNED_SANDBOX_IMAGE, SandboxPhase } from "./client.js";
import type {
  GetSandboxRequest,
  OpenShellReadinessTransport,
  SandboxResponse,
  SandboxStreamEvent,
  WatchSandboxRequest,
} from "./client.js";

/** A well-formed AgentContext (mirrors the iam/ids AgentContext schema). */
const GOOD_CTX = {
  actorId: "actor-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  taskId: "task-1",
  requestId: "request-1",
};

/**
 * The gateway assigns TWO DISTINCT identifiers (ObjectMeta, datamodel.proto:14/17): a stable `id`
 * (field 1) and a human-readable `name` (field 2). They are deliberately different here because the
 * two readiness RPCs key on DIFFERENT fields — GetSandboxRequest{name=1} (server: get_message_by_name)
 * vs WatchSandboxRequest{id=1} (server: get_message by id). The adapter MUST key Get by name and Watch
 * by id; conflating them (the S2 bug) makes Watch call get_message(name) → not_found → deny, killing
 * the entire PROVISIONING→READY observation this slice exists for.
 */
const OS_NAME = "os-sbx-ready";
const OS_ID = "sbxid-7f3c9a2e-stable-gateway-id";

interface ReadinessDoubleOpts {
  /** GetSandbox response (one-shot probe). */
  getResponse?: SandboxResponse;
  getReject?: Error;
  /** WatchSandbox events streamed in order; an Error throws from the iterator (stream error). */
  watchEvents?: Array<SandboxStreamEvent | Error>;
  watchReject?: Error;
}

/** A transport double that records calls and replays caller-supplied readiness responses. */
function readinessTransport(opts: ReadinessDoubleOpts): OpenShellReadinessTransport & {
  getCalls: GetSandboxRequest[];
  watchCalls: WatchSandboxRequest[];
} {
  const getCalls: GetSandboxRequest[] = [];
  const watchCalls: WatchSandboxRequest[] = [];
  return {
    getCalls,
    watchCalls,
    health: () => Promise.resolve({ ok: true }),
    createSandbox: () => Promise.resolve({ sandbox: { metadata: { name: OS_NAME, id: OS_ID } } }),
    deleteSandbox: () => Promise.resolve({ deleted: true }),
    getSandbox(req: GetSandboxRequest): Promise<SandboxResponse> {
      getCalls.push(req);
      if (opts.getReject !== undefined) return Promise.reject(opts.getReject);
      return Promise.resolve(opts.getResponse ?? { sandbox: {} });
    },
    watchSandbox(req: WatchSandboxRequest): AsyncIterable<SandboxStreamEvent> {
      watchCalls.push(req);
      if (opts.watchReject !== undefined) throw opts.watchReject;
      const events = opts.watchEvents ?? [];
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<SandboxStreamEvent> {
          for (const ev of events) {
            if (ev instanceof Error) throw ev;
            yield ev;
          }
        },
      };
    },
  };
}

/** Create a sandbox through the adapter and return its mapped SandboxId (helper for readiness tests). */
async function createMapped(adapter: OpenShellSandboxAdapter): Promise<string> {
  const res = await adapter.createSandbox(GOOD_CTX, { image: PINNED_SANDBOX_IMAGE });
  if (res.status !== "ok") throw new Error("setup: createSandbox should be ok");
  return res.sandboxId;
}

const statusSnapshot = (phase: number): SandboxResponse => ({
  sandbox: { status: { phase } },
});

const watchSandboxEvent = (phase: number): SandboxStreamEvent => ({
  sandbox: { status: { phase } },
});

describe("OpenShellSandboxAdapter.awaitReady — GetSandbox one-shot", () => {
  it("returns ok when GetSandbox reports phase=READY", async () => {
    const t = readinessTransport({ getResponse: statusSnapshot(SandboxPhase.SANDBOX_PHASE_READY) });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(GOOD_CTX, id, { deadlineMs: 1000 });

    expect(res.status).toBe("ok");
    // GetSandbox MUST be keyed by the gateway `name` (server: get_message_by_name), NOT the id.
    expect(t.getCalls).toHaveLength(1);
    expect(t.getCalls[0]?.name).toBe(OS_NAME);
    // A READY one-shot needs no watch stream.
    expect(t.watchCalls).toHaveLength(0);
  });

  it("denies (fail-closed) when GetSandbox reports phase=ERROR, noting the ERROR phase", async () => {
    const t = readinessTransport({ getResponse: statusSnapshot(SandboxPhase.SANDBOX_PHASE_ERROR) });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(GOOD_CTX, id, { deadlineMs: 1000 });

    expect(res.status).toBe("denied");
    if (res.status !== "denied") throw new Error("unreachable");
    expect(res.reason.toLowerCase()).toContain("error");
    // ERROR is terminal: no watch is opened.
    expect(t.watchCalls).toHaveLength(0);
  });

  it("denies a bad AgentContext and does NOT call GetSandbox (fail-closed before any RPC)", async () => {
    const t = readinessTransport({ getResponse: statusSnapshot(SandboxPhase.SANDBOX_PHASE_READY) });
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.awaitReady({ not: "a context" }, "sbx-os-anything", {
      deadlineMs: 1000,
    });

    expect(res.status).toBe("denied");
    expect(res.event.result).toBe("denied");
    expect(t.getCalls).toHaveLength(0);
  });

  it("denies an unknown sandbox id (no mapping) and issues NO RPC (deny-by-default)", async () => {
    const t = readinessTransport({ getResponse: statusSnapshot(SandboxPhase.SANDBOX_PHASE_READY) });
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.awaitReady(GOOD_CTX, "sbx-os-never-created", { deadlineMs: 1000 });

    expect(res.status).toBe("denied");
    expect(t.getCalls).toHaveLength(0);
    expect(t.watchCalls).toHaveLength(0);
  });
});

describe("OpenShellSandboxAdapter.awaitReady — WatchSandbox stream", () => {
  it("returns ok when GetSandbox is PROVISIONING and Watch then pushes a READY snapshot", async () => {
    const t = readinessTransport({
      getResponse: statusSnapshot(SandboxPhase.SANDBOX_PHASE_PROVISIONING),
      watchEvents: [
        watchSandboxEvent(SandboxPhase.SANDBOX_PHASE_PROVISIONING),
        watchSandboxEvent(SandboxPhase.SANDBOX_PHASE_READY),
      ],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(GOOD_CTX, id, { deadlineMs: 1000 });

    expect(res.status).toBe("ok");
    expect(t.watchCalls).toHaveLength(1);
    // WatchSandbox MUST be keyed by the gateway-assigned stable `id` (server: get_message by id),
    // which is DISTINCT from the `name` GetSandbox uses. Conflating them (the S2 regression) makes a
    // real gateway return not_found and the slice's PROVISIONING→READY observation can NEVER succeed.
    expect(t.watchCalls[0]?.id).toBe(OS_ID);
    expect(t.watchCalls[0]?.id).not.toBe(OS_NAME);
    // The watch is opened with stop_on_terminal so the gateway closes on READY/ERROR.
    expect(t.watchCalls[0]?.stopOnTerminal).toBe(true);
  });

  it("denies (fail-closed) when the watch stream ends before READY (deadline-equivalent close)", async () => {
    const t = readinessTransport({
      getResponse: statusSnapshot(SandboxPhase.SANDBOX_PHASE_PROVISIONING),
      // Stream closes after only non-terminal snapshots — never READY.
      watchEvents: [watchSandboxEvent(SandboxPhase.SANDBOX_PHASE_PROVISIONING)],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(GOOD_CTX, id, { deadlineMs: 1000 });

    expect(res.status).toBe("denied");
  });

  it("denies (fail-closed) when the deadline elapses before READY is observed", async () => {
    vi.useFakeTimers();
    try {
      const t: OpenShellReadinessTransport = {
        health: () => Promise.resolve({ ok: true }),
        createSandbox: () =>
          Promise.resolve({ sandbox: { metadata: { name: "os-sbx-slow", id: "sbxid-slow" } } }),
        deleteSandbox: () => Promise.resolve({ deleted: true }),
        getSandbox: () => Promise.resolve(statusSnapshot(SandboxPhase.SANDBOX_PHASE_PROVISIONING)),
        // A stream that yields one non-terminal event then hangs forever — only the deadline can
        // resolve this; if it cannot, the test times out (proving the deadline is load-bearing).
        watchSandbox(): AsyncIterable<SandboxStreamEvent> {
          return {
            async *[Symbol.asyncIterator](): AsyncIterator<SandboxStreamEvent> {
              yield watchSandboxEvent(SandboxPhase.SANDBOX_PHASE_PROVISIONING);
              await new Promise<never>(() => {}); // never settles
            },
          };
        },
      };
      const adapter = new OpenShellSandboxAdapter(t);
      const id = await createMapped(adapter);

      const pending = adapter.awaitReady(GOOD_CTX, id, { deadlineMs: 500 });
      await vi.advanceTimersByTimeAsync(600);
      const res = await pending;

      expect(res.status).toBe("denied");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OpenShellSandboxAdapter.awaitReady — adversarial deny-by-default (never-READY)", () => {
  it("denies an unknown phase enum value (e.g. 99) from GetSandbox — never treats it as READY", async () => {
    const t = readinessTransport({ getResponse: statusSnapshot(99) });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(GOOD_CTX, id, { deadlineMs: 1000 });

    // 99 is non-terminal -> falls through to watch; the (empty) watch then closes -> denied.
    expect(res.status).toBe("denied");
  });

  it("denies an unknown phase enum pushed on the WATCH stream — never treats it as READY", async () => {
    const t = readinessTransport({
      getResponse: statusSnapshot(SandboxPhase.SANDBOX_PHASE_PROVISIONING),
      watchEvents: [watchSandboxEvent(99), watchSandboxEvent(99)],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(GOOD_CTX, id, { deadlineMs: 1000 });

    expect(res.status).toBe("denied");
  });

  it("denies (fail-closed, does NOT throw) when GetSandbox rejects, leaking no baseUrl", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = "https://super-secret-gateway.internal:8443";
    const t = readinessTransport({ getReject: new Error(`connect ECONNREFUSED ${secret}`) });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(GOOD_CTX, id, { deadlineMs: 1000 });

    expect(res.status).toBe("denied");
    if (res.status !== "denied") throw new Error("unreachable");
    expect(res.reason).not.toContain(secret);
    expect(JSON.stringify(res.event)).not.toContain(secret);
    for (const spy of [errSpy, logSpy, warnSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(secret);
      }
    }
    errSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("denies (fail-closed, does NOT throw) when the watch stream errors before READY", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "https://gateway.internal:9443";
    const t = readinessTransport({
      getResponse: statusSnapshot(SandboxPhase.SANDBOX_PHASE_PROVISIONING),
      watchEvents: [
        watchSandboxEvent(SandboxPhase.SANDBOX_PHASE_PROVISIONING),
        new Error(`stream RST_STREAM ${secret}`),
      ],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(GOOD_CTX, id, { deadlineMs: 1000 });

    expect(res.status).toBe("denied");
    if (res.status !== "denied") throw new Error("unreachable");
    expect(res.reason).not.toContain(secret);
    expect(JSON.stringify(res.event)).not.toContain(secret);
    errSpy.mockRestore();
  });

  it("denies (fail-closed) when the gateway returned no id, so Watch cannot be safely keyed", async () => {
    // The gateway returned a name but NO stable id at create time. The Get one-shot is PROVISIONING,
    // so readiness would normally fall through to Watch — but Watch keys on the id (DISTINCT from
    // name) and there is none. Mis-keying Watch with the name would resolve to not_found on a real
    // gateway, so the adapter MUST fail closed and never even open the stream.
    const t = readinessTransport({
      getResponse: statusSnapshot(SandboxPhase.SANDBOX_PHASE_PROVISIONING),
      watchEvents: [watchSandboxEvent(SandboxPhase.SANDBOX_PHASE_READY)],
    });
    // Override createSandbox to omit the id (name only).
    t.createSandbox = () => Promise.resolve({ sandbox: { metadata: { name: OS_NAME } } });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(GOOD_CTX, id, { deadlineMs: 1000 });

    expect(res.status).toBe("denied");
    // No watch stream is opened when the id is absent (never mis-key Watch with the name).
    expect(t.watchCalls).toHaveLength(0);
  });

  it("denies (fail-closed) when watchSandbox itself throws synchronously (e.g. transport refused)", async () => {
    const t = readinessTransport({
      getResponse: statusSnapshot(SandboxPhase.SANDBOX_PHASE_PROVISIONING),
      watchReject: new Error("UNAVAILABLE"),
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(GOOD_CTX, id, { deadlineMs: 1000 });

    expect(res.status).toBe("denied");
  });
});
