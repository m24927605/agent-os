/**
 * Unit tests for the CONVERGED mTLS gRPC ExecSandbox transport (slice SLICE-NC-S11b,收斂 OS-S1).
 *
 * OS-S1 left a DUPLICATE stream accumulator here (`consumeExecStream` -> `Promise<ExecResult>`); this
 * slice converges the transport onto the adapter's seam: `createOpenShellGrpcTransport` now returns a
 * thin `OpenShellExecTransport` whose `execSandbox(req, signal)` opens the `ExecSandbox` server-stream
 * and YIELDS the raw `ExecSandboxEvent`s — NO accumulation, NO deadline, NO maxOutputBytes here (the
 * SINGLE accumulator is `OpenShellSandboxAdapter.streamExec`, covered by adapter.exec.test.ts).
 *
 * NO live gateway, NO mTLS handshake, NO docker: every test injects a FAKE server-stream source
 * (mirroring how the ingest transport test injects an in-process double). The real grpc-js
 * `makeServerStreamRequest` against the gateway is exercised only by the live harness.
 *
 * Load-bearing seam probes:
 *   - execSandbox(req, signal) yields ALL injected events IN ORDER (the stream IS an AsyncIterable).
 *   - an aborted `signal` CANCELS the underlying stream (no leaked gRPC stream).
 * The unary lifecycle (createSandbox / getSandbox / deleteSandbox) is now REAL — covered by
 * grpc-transport.lifecycle.test.ts; watchSandbox is now the REAL WatchSandbox server-stream (OS-S2b) —
 * covered exhaustively by grpc-transport.watch.test.ts. A fail-closed reason carries NO endpoint / cert
 * content (credential-blind).
 */
import { describe, expect, it } from "vitest";
import type { ExecSandboxRequest } from "./client.js";
import {
  type ExecStreamHandle,
  type UnaryRequestFn,
  type WatchStreamHandle,
  createOpenShellGrpcTransport,
} from "./grpc-transport.js";
import type { ExecSandboxEvent } from "./proto/openshell.subset.codec.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const stdoutEvent = (data: string): ExecSandboxEvent => ({ stdout: { data: enc(data) } });
const stderrEvent = (data: string): ExecSandboxEvent => ({ stderr: { data: enc(data) } });
const exitEvent = (code: number): ExecSandboxEvent => ({ exit: { exitCode: code } });

const REQ: ExecSandboxRequest = { sandboxId: "sbx-1", command: ["sh", "-c", "echo OS_S1_LIVE"] };

/**
 * A fake `ExecStreamHandle`: an EventEmitter-shaped server stream that replays a script of `data`
 * events then either `end` or an `error`. It records cancellation so a test can assert the transport
 * cancels the stream on abort. The transport adapts this handle into an `AsyncIterable<ExecSandboxEvent>`.
 */
interface FakeScript {
  /** Events to emit (in order). An Error entry emits an `error` event and stops. */
  events: Array<ExecSandboxEvent | Error>;
  /** When true, the stream never emits `end` after the events (simulates a hung stream). */
  noEnd?: boolean;
}

function fakeStream(script: FakeScript): {
  handle: ExecStreamHandle;
  cancelled: () => boolean;
} {
  const dataCbs: Array<(ev: ExecSandboxEvent) => void> = [];
  const endCbs: Array<() => void> = [];
  const errCbs: Array<(err: Error) => void> = [];
  let cancelled = false;

  const handle: ExecStreamHandle = {
    on(event, cb): ExecStreamHandle {
      if (event === "data") dataCbs.push(cb as (ev: ExecSandboxEvent) => void);
      else if (event === "end") endCbs.push(cb as () => void);
      else if (event === "error") errCbs.push(cb as (err: Error) => void);
      return handle;
    },
    cancel(): void {
      cancelled = true;
    },
  };

  // Drive the script asynchronously (next tick) so the consumer has wired its listeners.
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
    for (const cb of dataCbs) cb(ev as ExecSandboxEvent);
    setImmediate(pump);
  };
  setImmediate(pump);

  return { handle, cancelled: () => cancelled };
}

/** Build a converged transport whose stream source is the injected fake (no real grpc-js Client). */
function transportWith(makeStream: () => { handle: ExecStreamHandle; cancelled: () => boolean }): {
  transport: ReturnType<typeof createOpenShellGrpcTransport>;
  lastCancelled: () => boolean;
} {
  let last: () => boolean = () => false;
  // Inject a unary seam too so a lifecycle call never falls through to the real grpc-js Client (these
  // exec-focused tests don't exercise lifecycle; that lives in grpc-transport.lifecycle.test.ts).
  const makeUnary: UnaryRequestFn = () =>
    Promise.reject(new Error("unary not used in this test (fail-closed)"));
  const transport = createOpenShellGrpcTransport({
    endpoint: "127.0.0.1:17670",
    caCertPath: "/dev/null",
    clientCertPath: "/dev/null",
    clientKeyPath: "/dev/null",
    // Test seam: production builds the grpc-js Client + makeServerStreamRequest; the test injects a
    // fake stream so no socket / TLS / cert read happens.
    openExecStream: () => {
      const s = makeStream();
      last = s.cancelled;
      return s.handle;
    },
    makeUnary,
  });
  return { transport, lastCancelled: () => last() };
}

/** Drain an `AsyncIterable<ExecSandboxEvent>` into an array (in arrival order). */
async function drain(stream: AsyncIterable<ExecSandboxEvent>): Promise<ExecSandboxEvent[]> {
  const out: ExecSandboxEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("createOpenShellGrpcTransport — execSandbox seam (yields events; no accumulation)", () => {
  it("yields ALL injected events IN ORDER (stdout chunks then a terminal exit)", async () => {
    const { transport } = transportWith(() =>
      fakeStream({ events: [stdoutEvent("OS_S1_"), stdoutEvent("LIVE\n"), exitEvent(0)] }),
    );
    const events = await drain(transport.execSandbox(REQ));
    expect(events).toHaveLength(3);
    expect(dec(events[0]?.stdout?.data ?? new Uint8Array())).toBe("OS_S1_");
    expect(dec(events[1]?.stdout?.data ?? new Uint8Array())).toBe("LIVE\n");
    expect(events[2]?.exit?.exitCode).toBe(0);
  });

  it("yields a stderr chunk + a NON-ZERO exit as raw events (it does NOT interpret them)", async () => {
    const { transport } = transportWith(() =>
      fakeStream({ events: [stderrEvent("boom"), exitEvent(7)] }),
    );
    const events = await drain(transport.execSandbox(REQ));
    expect(dec(events[0]?.stderr?.data ?? new Uint8Array())).toBe("boom");
    expect(events[1]?.exit?.exitCode).toBe(7);
  });

  it("surfaces a mid-stream stream `error` as an iterator throw (the adapter fails closed on it)", async () => {
    const { transport } = transportWith(() =>
      fakeStream({ events: [stdoutEvent("x"), new Error("RST_STREAM")] }),
    );
    await expect(drain(transport.execSandbox(REQ))).rejects.toThrow();
  });
});

describe("createOpenShellGrpcTransport — execSandbox abort cancels the underlying stream", () => {
  it("cancels the stream when the supplied AbortSignal aborts (no leaked gRPC stream)", async () => {
    const { transport, lastCancelled } = transportWith(() =>
      // Emits one stdout then NEVER ends and NEVER exits — the consumer abandons it via abort.
      fakeStream({ events: [stdoutEvent("hang")], noEnd: true }),
    );
    const abort = new AbortController();
    const stream = transport.execSandbox(REQ, abort.signal);
    const it = stream[Symbol.asyncIterator]();
    // Pull the first event so the stream is open, then abort.
    const first = await it.next();
    expect(dec(first.value?.stdout?.data ?? new Uint8Array())).toBe("hang");
    abort.abort();
    // The abort must cancel the underlying stream (deterministically — give the listener a tick).
    await new Promise((r) => setImmediate(r));
    expect(lastCancelled()).toBe(true);
  });

  it("an ALREADY-aborted signal cancels the stream and yields nothing once iteration starts", async () => {
    const { transport, lastCancelled } = transportWith(() =>
      fakeStream({ events: [stdoutEvent("hang")], noEnd: true }),
    );
    const abort = new AbortController();
    abort.abort();
    // The adapter always drives the iterator; the generator opens the stream then cancels it and ends.
    const events = await drain(transport.execSandbox(REQ, abort.signal));
    expect(events).toEqual([]);
    expect(lastCancelled()).toBe(true);
  });
});

describe("createOpenShellGrpcTransport — watchSandbox is now REAL (OS-S2b; no fail-closed stub)", () => {
  it("watchSandbox no longer throws on iteration — it is wired to a real WatchSandbox stream", async () => {
    // Inject a watch stream seam so iteration is exercised WITHOUT a real grpc-js Client. The OS-S2b
    // real watch (yields / abort / error) is covered exhaustively in grpc-transport.watch.test.ts; here
    // we only prove the OS-S2a "throws on iteration" stub is GONE.
    const transport = createOpenShellGrpcTransport({
      endpoint: "127.0.0.1:17670",
      caCertPath: "/dev/null",
      clientCertPath: "/dev/null",
      clientKeyPath: "/dev/null",
      makeUnary: () => Promise.reject(new Error("unary not used (fail-closed)")),
      // A watch stream that immediately ends with no events.
      openWatchStream: (): WatchStreamHandle => {
        const endCbs: Array<() => void> = [];
        const handle: WatchStreamHandle = {
          on(event, cb): WatchStreamHandle {
            if (event === "end") endCbs.push(cb as () => void);
            return handle;
          },
          cancel(): void {},
        };
        setImmediate(() => {
          for (const cb of endCbs) cb();
        });
        return handle;
      },
    });
    const events: unknown[] = [];
    for await (const ev of transport.watchSandbox({ id: "x", followStatus: true })) {
      events.push(ev);
    }
    expect(events).toEqual([]); // a clean (empty) stream end — no throw, no fabricated READY.
  });
});
