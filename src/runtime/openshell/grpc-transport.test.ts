/**
 * RED-first unit tests for the mTLS gRPC ExecSandbox transport (slice SLICE-OS-S1).
 *
 * NO live gateway, NO mTLS handshake, NO docker: every test injects a FAKE server-stream source
 * (mirroring how the ingest transport test injects an in-process `AppendService`). The real grpc-js
 * `makeServerStreamRequest` against the gateway is exercised only by the main loop's live validation.
 *
 * Load-bearing fail-closed probes (deny-by-default; NEVER fabricate success):
 *   - stdout chunks + exit(0)               => { exitCode: 0, stdout, stderr } (faithful convergence)
 *   - a NON-ZERO exit code                  => resolved with that code (a command result, not a deny)
 *   - only stdout, NO terminal exit + short deadline => DENY (stream ended / timed out before exit)
 *   - total output exceeding maxOutputBytes => DENY + the underlying stream is cancelled (abort)
 *   - a stream `error` event / synchronous throw => REJECT
 * A denied/rejected reason carries NO endpoint / cert content (credential-blind).
 */
import { describe, expect, it } from "vitest";
import { type ExecStreamHandle, createOpenShellGrpcTransport } from "./grpc-transport.js";
import type { ExecSandboxEvent } from "./proto/openshell.subset.codec.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const stdoutEvent = (data: string): ExecSandboxEvent => ({ stdout: { data: enc(data) } });
const stderrEvent = (data: string): ExecSandboxEvent => ({ stderr: { data: enc(data) } });
const exitEvent = (code: number): ExecSandboxEvent => ({ exit: { exitCode: code } });

/**
 * A fake `ExecStreamHandle`: an EventEmitter-shaped server stream that replays a script of `data`
 * events then either `end` (no terminal close beyond the scripted events) or an `error`. It records
 * cancellation so a test can assert the transport aborts the stream on overflow/deadline.
 */
interface FakeScript {
  /** Events to emit (in order). An Error entry emits an `error` event and stops. */
  events: Array<ExecSandboxEvent | Error>;
  /** Delay (ms) before emitting each event (default 0 — flush on next tick). */
  delayMs?: number;
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

  // Drive the script asynchronously (next tick) so the transport has wired its listeners.
  const delay = script.delayMs ?? 0;
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
    if (delay > 0) setTimeout(pump, delay);
    else setImmediate(pump);
  };
  if (delay > 0) setTimeout(pump, delay);
  else setImmediate(pump);

  return { handle, cancelled: () => cancelled };
}

/** Build a transport whose stream source is the injected fake (no real grpc-js Client / no certs). */
function transportWith(makeStream: () => { handle: ExecStreamHandle; cancelled: () => boolean }): {
  exec: ReturnType<typeof createOpenShellGrpcTransport>["execSandbox"];
  lastCancelled: () => boolean;
} {
  let last: () => boolean = () => false;
  const t = createOpenShellGrpcTransport({
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
  });
  return { exec: t.execSandbox.bind(t), lastCancelled: () => last() };
}

describe("createOpenShellGrpcTransport.execSandbox — happy path", () => {
  it("converges stdout chunks + exit(0) into { exitCode: 0, stdout, stderr }", async () => {
    const { exec } = transportWith(() =>
      fakeStream({ events: [stdoutEvent("OS_S1_"), stdoutEvent("LIVE\n"), exitEvent(0)] }),
    );
    const result = await exec("sbx-1", ["sh", "-c", "echo OS_S1_LIVE"]);
    expect(result.exitCode).toBe(0);
    expect(dec(result.stdout)).toBe("OS_S1_LIVE\n");
    expect(result.stderr.length).toBe(0);
  });

  it("joins stderr chunks and reports a NON-ZERO exit code as a faithful result (not a deny)", async () => {
    const { exec } = transportWith(() =>
      fakeStream({ events: [stderrEvent("boom"), exitEvent(7)] }),
    );
    const result = await exec("sbx-1", ["false"]);
    expect(result.exitCode).toBe(7);
    expect(dec(result.stderr)).toBe("boom");
    expect(result.stdout.length).toBe(0);
  });
});

describe("createOpenShellGrpcTransport.execSandbox — fail-closed (no fabricated success)", () => {
  it("DENIES (rejects) when the stream ends with NO terminal exit event", async () => {
    const { exec } = transportWith(() => fakeStream({ events: [stdoutEvent("partial")] }));
    await expect(exec("sbx-1", ["sh"])).rejects.toThrow();
  });

  it("DENIES (rejects) when the deadline elapses before a terminal exit (hung stream)", async () => {
    const { exec, lastCancelled } = transportWith(() =>
      // Emits one stdout then NEVER ends and NEVER exits — must trip the wall-clock deadline.
      fakeStream({ events: [stdoutEvent("hang")], noEnd: true }),
    );
    await expect(exec("sbx-1", ["sleep", "999"], { deadlineMs: 20 })).rejects.toThrow();
    expect(lastCancelled()).toBe(true);
  });

  it("DENIES (rejects) + cancels the stream when output exceeds maxOutputBytes", async () => {
    const big = "x".repeat(64);
    const { exec, lastCancelled } = transportWith(() =>
      fakeStream({ events: [stdoutEvent(big), stdoutEvent(big), exitEvent(0)] }),
    );
    await expect(exec("sbx-1", ["yes"], { maxOutputBytes: 100 })).rejects.toThrow();
    expect(lastCancelled()).toBe(true);
  });

  it("REJECTS on a stream `error` event before exit", async () => {
    const { exec } = transportWith(() =>
      fakeStream({ events: [stdoutEvent("x"), new Error("RST_STREAM")] }),
    );
    await expect(exec("sbx-1", ["sh"])).rejects.toThrow();
  });

  it("REJECTS without leaking the endpoint or cert paths into the error message", async () => {
    const { exec } = transportWith(() => fakeStream({ events: [stdoutEvent("x")] }));
    let caught: unknown;
    try {
      await exec("sbx-1", ["sh"]);
    } catch (e) {
      caught = e;
    }
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).not.toContain("127.0.0.1");
    expect(msg).not.toContain("17670");
    expect(msg).not.toContain("/dev/null");
  });
});
