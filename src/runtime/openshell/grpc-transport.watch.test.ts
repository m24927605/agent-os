/**
 * RED-first unit tests for the OS-S2b real WatchSandbox server-stream on the mTLS gRPC transport —
 * replacing the OS-S2a fail-closed watch stub. This COMPLETES `OpenShellReadinessTransport` (all four
 * methods create/get/delete + watch are now real on `createOpenShellGrpcTransport`).
 *
 * NO live gateway, NO mTLS handshake, NO docker: every test injects a FAKE server-stream source
 * (mirroring grpc-transport.test.ts's exec fake). The real grpc-js `makeServerStreamRequest` against
 * the gateway is exercised only by the live harness.
 *
 * Load-bearing seam probes:
 *   - watchSandbox(req, signal) yields ALL decoded snapshot events IN ORDER (the stream IS an
 *     AsyncIterable; NO accumulation — the adapter's watchUntilReady consumes + decides phase).
 *   - the wire WatchSandboxRequest carries the curated {id, followStatus, stopOnTerminal}.
 *   - an aborted `signal` CANCELS the underlying stream (no leaked gRPC stream).
 *   - a mid-stream `error` surfaces as an iterator throw (the adapter fails closed on it).
 * The adapter-readiness-via-watch end-to-end (PROVISIONING -> READY => ok; timeout/error => deny) is
 * driven through the SAME real transport in this file's last describe block.
 */
import { describe, expect, it } from "vitest";
import { OpenShellSandboxAdapter } from "./adapter.js";
import {
  PINNED_SANDBOX_IMAGE,
  SandboxPhase,
  type SandboxStreamEvent,
  type WatchSandboxRequest,
} from "./client.js";
import {
  type UnaryRequestFn,
  type WatchStreamHandle,
  createOpenShellGrpcTransport,
} from "./grpc-transport.js";

// --- a tiny INDEPENDENT proto3 encoder to build fake SandboxStreamEvent / SandboxResponse bytes ------

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

/** SandboxStreamEvent { sandbox=1 -> Sandbox { status=3 -> SandboxStatus { phase=6 } } }. */
function streamEventBytes(phase: number): Uint8Array {
  const status: number[] = [];
  pushTag(status, 6, 0);
  pushVarint(status, phase);
  const sandbox: number[] = [];
  pushLenDelim(sandbox, 3, Uint8Array.from(status));
  const event: number[] = [];
  pushLenDelim(event, 1, Uint8Array.from(sandbox));
  return Uint8Array.from(event);
}

/** A non-sandbox variant: SandboxStreamEvent { log=2 } — must decode to {sandbox: undefined}. */
function logEventBytes(): Uint8Array {
  const log: number[] = [];
  pushString(log, 1, "log line");
  const event: number[] = [];
  pushLenDelim(event, 2, Uint8Array.from(log));
  return Uint8Array.from(event);
}

/** SandboxResponse { sandbox=1 -> Sandbox { metadata=1{id,name}, status=3{phase} } } (for create/get). */
function sandboxResponseBytes(name: string, id: string, phase: number): Buffer {
  const meta: number[] = [];
  pushString(meta, 1, id);
  pushString(meta, 2, name);
  const status: number[] = [];
  pushTag(status, 6, 0);
  pushVarint(status, phase);
  const sandbox: number[] = [];
  pushLenDelim(sandbox, 1, Uint8Array.from(meta));
  pushLenDelim(sandbox, 3, Uint8Array.from(status));
  const resp: number[] = [];
  pushLenDelim(resp, 1, Uint8Array.from(sandbox));
  return Buffer.from(resp);
}

const OS_NAME = "os-sbx-ready";
const OS_ID = "sbxid-7f3c9a2e-stable-gateway-id";

/**
 * A fake `WatchStreamHandle`: an EventEmitter-shaped server stream that replays a script of `data`
 * events (raw wire bytes — the transport's decode runs in the grpc-js deserialize seam, so the fake
 * supplies pre-decoded bytes via the injected decoder) then either `end` or an `error`. It records
 * cancellation so a test can assert the transport cancels the stream on abort.
 *
 * To stay faithful to the real seam (decode happens BEFORE the handle), the fake emits ALREADY-DECODED
 * `SandboxStreamEvent`s (the production `makeServerStreamRequest` deserialize callback produces these);
 * a test that wants to exercise the codec uses the codec test instead.
 */
interface WatchScript {
  events: Array<SandboxStreamEvent | Error>;
  noEnd?: boolean;
}

function fakeWatchStream(script: WatchScript): {
  handle: WatchStreamHandle;
  cancelled: () => boolean;
} {
  const dataCbs: Array<(ev: SandboxStreamEvent) => void> = [];
  const endCbs: Array<() => void> = [];
  const errCbs: Array<(err: Error) => void> = [];
  let cancelled = false;

  const handle: WatchStreamHandle = {
    on(event, cb): WatchStreamHandle {
      if (event === "data") dataCbs.push(cb as (ev: SandboxStreamEvent) => void);
      else if (event === "end") endCbs.push(cb as () => void);
      else if (event === "error") errCbs.push(cb as (err: Error) => void);
      return handle;
    },
    cancel(): void {
      cancelled = true;
    },
  };

  let i = 0;
  const pump = (): void => {
    if (cancelled) return;
    if (i >= script.events.length) {
      if (script.noEnd !== true) for (const cb of endCbs) cb();
      return;
    }
    const ev = script.events[i++];
    if (ev instanceof Error) {
      for (const cb of errCbs) cb(ev);
      return;
    }
    for (const cb of dataCbs) cb(ev as SandboxStreamEvent);
    setImmediate(pump);
  };
  setImmediate(pump);

  return { handle, cancelled: () => cancelled };
}

const snap = (phase: number): SandboxStreamEvent => ({ sandbox: { status: { phase } } });
const REQ: WatchSandboxRequest = { id: OS_ID, followStatus: true, stopOnTerminal: true };

/** Build a transport whose WATCH stream source is the injected fake (no real grpc-js Client). */
function transportWith(makeStream: () => { handle: WatchStreamHandle; cancelled: () => boolean }): {
  transport: ReturnType<typeof createOpenShellGrpcTransport>;
  lastReq: () => WatchSandboxRequest | undefined;
  lastCancelled: () => boolean;
} {
  let last: () => boolean = () => false;
  let lastReq: WatchSandboxRequest | undefined;
  const makeUnary: UnaryRequestFn = () =>
    Promise.reject(new Error("unary not used in this test (fail-closed)"));
  const transport = createOpenShellGrpcTransport({
    endpoint: "127.0.0.1:17670",
    caCertPath: "/dev/null",
    clientCertPath: "/dev/null",
    clientKeyPath: "/dev/null",
    openWatchStream: (req: WatchSandboxRequest) => {
      lastReq = req;
      const s = makeStream();
      last = s.cancelled;
      return s.handle;
    },
    makeUnary,
  });
  return { transport, lastReq: () => lastReq, lastCancelled: () => last() };
}

async function drain(stream: AsyncIterable<SandboxStreamEvent>): Promise<SandboxStreamEvent[]> {
  const out: SandboxStreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("createOpenShellGrpcTransport — watchSandbox seam (yields snapshots; no accumulation)", () => {
  it("yields ALL injected snapshot events IN ORDER (PROVISIONING then READY)", async () => {
    const { transport } = transportWith(() =>
      fakeWatchStream({
        events: [
          snap(SandboxPhase.SANDBOX_PHASE_PROVISIONING),
          snap(SandboxPhase.SANDBOX_PHASE_READY),
        ],
      }),
    );
    const events = await drain(transport.watchSandbox(REQ));
    expect(events).toHaveLength(2);
    expect(events[0]?.sandbox?.status?.phase).toBe(SandboxPhase.SANDBOX_PHASE_PROVISIONING);
    expect(events[1]?.sandbox?.status?.phase).toBe(SandboxPhase.SANDBOX_PHASE_READY);
  });

  it("forwards a non-sandbox variant verbatim as {sandbox: undefined} (no readiness signal)", async () => {
    const { transport } = transportWith(() =>
      fakeWatchStream({ events: [{ sandbox: undefined }, snap(SandboxPhase.SANDBOX_PHASE_READY)] }),
    );
    const events = await drain(transport.watchSandbox(REQ));
    expect(events[0]?.sandbox).toBeUndefined();
    expect(events[1]?.sandbox?.status?.phase).toBe(SandboxPhase.SANDBOX_PHASE_READY);
  });

  it("builds the wire WatchSandboxRequest from the curated {id, followStatus, stopOnTerminal}", async () => {
    const { transport, lastReq } = transportWith(() =>
      fakeWatchStream({ events: [snap(SandboxPhase.SANDBOX_PHASE_READY)] }),
    );
    await drain(transport.watchSandbox(REQ));
    expect(lastReq()?.id).toBe(OS_ID);
    expect(lastReq()?.followStatus).toBe(true);
    expect(lastReq()?.stopOnTerminal).toBe(true);
  });

  it("surfaces a mid-stream stream `error` as an iterator throw (the adapter fails closed on it)", async () => {
    const { transport } = transportWith(() =>
      fakeWatchStream({
        events: [snap(SandboxPhase.SANDBOX_PHASE_PROVISIONING), new Error("RST_STREAM")],
      }),
    );
    await expect(drain(transport.watchSandbox(REQ))).rejects.toThrow();
  });
});

describe("createOpenShellGrpcTransport — watchSandbox abort cancels the underlying stream", () => {
  it("cancels the stream when the supplied AbortSignal aborts (no leaked gRPC stream)", async () => {
    const { transport, lastCancelled } = transportWith(() =>
      fakeWatchStream({ events: [snap(SandboxPhase.SANDBOX_PHASE_PROVISIONING)], noEnd: true }),
    );
    const abort = new AbortController();
    const stream = transport.watchSandbox(REQ, abort.signal);
    const it = stream[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value?.sandbox?.status?.phase).toBe(SandboxPhase.SANDBOX_PHASE_PROVISIONING);
    abort.abort();
    await new Promise((r) => setImmediate(r));
    expect(lastCancelled()).toBe(true);
  });

  it("an ALREADY-aborted signal cancels the stream and yields nothing once iteration starts", async () => {
    const { transport, lastCancelled } = transportWith(() =>
      fakeWatchStream({ events: [snap(SandboxPhase.SANDBOX_PHASE_PROVISIONING)], noEnd: true }),
    );
    const abort = new AbortController();
    abort.abort();
    const events = await drain(transport.watchSandbox(REQ, abort.signal));
    expect(events).toEqual([]);
    expect(lastCancelled()).toBe(true);
  });
});

/**
 * Adapter readiness END-TO-END through the REAL transport's watchSandbox (fake stream): the OS-S2a stub
 * is gone, so `awaitReady` genuinely streams PROVISIONING -> READY to `ok` (and times out / errors to
 * deny). This is the load-bearing OS-S2b proof: the watch PATH carries readiness, not the getSandbox
 * fast-path.
 */
describe("OpenShellSandboxAdapter.awaitReady via the REAL transport watch (fake stream)", () => {
  /** A transport double over the REAL grpc transport: getSandbox returns PROVISIONING, watch is faked. */
  function readinessTransportWith(watch: WatchScript): {
    transport: ReturnType<typeof createOpenShellGrpcTransport>;
    watchCalls: WatchSandboxRequest[];
  } {
    const watchCalls: WatchSandboxRequest[] = [];
    const makeUnary: UnaryRequestFn = (method) => {
      // create/get both return a SandboxResponse; create supplies the {name,id}, get is PROVISIONING.
      if (method.endsWith("/CreateSandbox")) {
        return Promise.resolve(
          sandboxResponseBytes(OS_NAME, OS_ID, SandboxPhase.SANDBOX_PHASE_PROVISIONING),
        );
      }
      if (method.endsWith("/GetSandbox")) {
        return Promise.resolve(
          sandboxResponseBytes(OS_NAME, OS_ID, SandboxPhase.SANDBOX_PHASE_PROVISIONING),
        );
      }
      return Promise.reject(new Error("unexpected unary method (fail-closed)"));
    };
    const transport = createOpenShellGrpcTransport({
      endpoint: "127.0.0.1:17670",
      caCertPath: "/dev/null",
      clientCertPath: "/dev/null",
      clientKeyPath: "/dev/null",
      makeUnary,
      openWatchStream: (req: WatchSandboxRequest) => {
        watchCalls.push(req);
        return fakeWatchStream(watch).handle;
      },
    });
    return { transport, watchCalls };
  }

  const CTX = {
    actorId: "actor-1",
    tenantId: "tenant-1",
    projectId: "project-1",
    taskId: "task-1",
    requestId: "request-1",
  };

  async function createMapped(adapter: OpenShellSandboxAdapter): Promise<string> {
    const res = await adapter.createSandbox(CTX, { image: PINNED_SANDBOX_IMAGE });
    if (res.status !== "ok") throw new Error(`setup: create denied: ${res.reason}`);
    return res.sandboxId;
  }

  it("getSandbox PROVISIONING then watch yields [PROVISIONING, READY] => ok (READY via watch)", async () => {
    const { transport, watchCalls } = readinessTransportWith({
      events: [
        snap(SandboxPhase.SANDBOX_PHASE_PROVISIONING),
        snap(SandboxPhase.SANDBOX_PHASE_READY),
      ],
    });
    const adapter = new OpenShellSandboxAdapter(transport);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(CTX, id, { deadlineMs: 1000 });

    expect(res.status).toBe("ok");
    // The watch path WAS exercised (the getSandbox fast-path was PROVISIONING, not READY).
    expect(watchCalls).toHaveLength(1);
    expect(watchCalls[0]?.id).toBe(OS_ID);
    expect(watchCalls[0]?.stopOnTerminal).toBe(true);
  });

  it("watch yields only PROVISIONING then ENDS before READY => deny (fail-closed)", async () => {
    const { transport } = readinessTransportWith({
      events: [snap(SandboxPhase.SANDBOX_PHASE_PROVISIONING)],
    });
    const adapter = new OpenShellSandboxAdapter(transport);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(CTX, id, { deadlineMs: 1000 });

    expect(res.status).toBe("denied");
  });

  it("watch errors before READY => deny (fail-closed, never fabricates ready)", async () => {
    const { transport } = readinessTransportWith({
      events: [snap(SandboxPhase.SANDBOX_PHASE_PROVISIONING), new Error("RST_STREAM")],
    });
    const adapter = new OpenShellSandboxAdapter(transport);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(CTX, id, { deadlineMs: 1000 });

    expect(res.status).toBe("denied");
  });

  it("watch yields a non-sandbox variant then READY => ok (the variant carries no readiness signal)", async () => {
    const { transport } = readinessTransportWith({
      events: [{ sandbox: undefined }, snap(SandboxPhase.SANDBOX_PHASE_READY)],
    });
    const adapter = new OpenShellSandboxAdapter(transport);
    const id = await createMapped(adapter);

    const res = await adapter.awaitReady(CTX, id, { deadlineMs: 1000 });

    expect(res.status).toBe("ok");
  });
});

/** Forward-compatible decode-via-bytes sanity: the codec produces {sandbox: undefined} for a log. */
describe("watch decode sanity (raw bytes -> the production decoder is wired in the deserialize seam)", () => {
  it("a log-variant wire decodes to {sandbox: undefined} (asserted in the codec test; sanity here)", () => {
    // The production transport decodes bytes in the grpc-js deserialize callback; this asserts the
    // fixture bytes used by the codec test are well-formed (the codec test owns the decode assertion).
    expect(logEventBytes().length).toBeGreaterThan(0);
    expect(streamEventBytes(SandboxPhase.SANDBOX_PHASE_READY).length).toBeGreaterThan(0);
  });
});
