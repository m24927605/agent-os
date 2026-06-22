/**
 * The mTLS gRPC `ExecSandbox` transport — slice SLICE-OS-S1, CONVERGED in SLICE-NC-S11b.
 *
 * This is a SINGLE chokepoint where the runtime RPC vendor (@grpc/grpc-js) + the OpenShell wire codec
 * are named for exec. It lives under src/runtime/openshell/ (an adapter sub-tree, NOT core), so the
 * `no-vendor-in-core` boundary (.dependency-cruiser.cjs) stays intact — core consumes only injected
 * ports. It mirrors the ingest grpc-js client (src/runtime/ingest/grpc-client.ts) and the lazy,
 * test-injectable construction of the OpenShell health client (client.ts) / ingest transport
 * (transport.ts): production builds the real grpc-js Client; tests inject a fake stream.
 *
 * CONVERGENCE (NC-S11b — resolves the OS-S1 §6 MAJOR-with-tracking): this transport now implements the
 * adapter-consumed `OpenShellExecTransport` (client.ts) — `execSandbox(req, signal)` opens the
 * `ExecSandbox` server-stream and YIELDS the raw `ExecSandboxEvent`s as an `AsyncIterable`. It does NOT
 * accumulate, deadline, or cap output — the SINGLE stream accumulator (deadline via AbortController,
 * maxOutputBytes cap, oneof validation, redaction -> ExecOutcome) lives ONLY in
 * `OpenShellSandboxAdapter.streamExec` (adapter.ts). The old `consumeExecStream` / `ExecResult` /
 * `ExecOpts` / `OpenShellGrpcExecTransport` (the DUPLICATE accumulator) are deleted.
 *
 * Responsibility (and ONLY this): build an mTLS channel to the gateway, open the `ExecSandbox`
 * server-stream (encodeExecSandboxRequest -> stream<ExecSandboxEvent>), wire the caller's `AbortSignal`
 * to `call.cancel()`, expose the exec stream as an `AsyncIterable<ExecSandboxEvent>`, AND (slice
 * SLICE-OS-S2a) drive the UNARY sandbox lifecycle CreateSandbox / GetSandbox / DeleteSandbox over the
 * SAME channel via `makeUnaryRequest` (encode request -> decode the unary reply).
 *
 * CONVERGENCE (OS-S2a): the NC-S11b fail-closed `createSandbox` / `deleteSandbox` stubs are REPLACED by
 * real unary impls and a unary `getSandbox` is added. CONVERGENCE (OS-S2b): the OS-S2a fail-closed
 * `watchSandbox` stub is REPLACED by a REAL `WatchSandbox` server-stream (encode WatchSandboxRequest ->
 * stream<SandboxStreamEvent>) over the SAME channel, so `createOpenShellGrpcTransport` now returns a
 * COMPLETE `OpenShellReadinessTransport` (create / get / delete / watch all real). The adapter's
 * `watchUntilReady` consumes the watch stream to observe PROVISIONING -> READY.
 *
 * FAIL-CLOSED INVARIANT (deny-by-default): a unary RPC error (refused / DEADLINE_EXCEEDED / malformed
 * reply) surfaces as a REJECTED promise — the adapter's signal to fail closed (deny), never a silent
 * fake success. The exec AND watch streams never fabricate a result: a stream `error`, a stream `end`
 * before the awaited terminal (exit / READY), an abort, etc. surface to the adapter (the single
 * consumer), which converges them deny-by-default.
 *
 * CREDENTIAL-BLIND: the mTLS materials are read from PATHS (never inlined); NO cert/key/endpoint
 * content is ever placed in an error message, a reason, or a log (mirrors the adapter's discipline —
 * a denied reason carries no baseUrl/endpoint). The certs here are the LOCAL gateway mTLS material
 * (not an LLM key), but the discipline is identical: nothing sensitive on disk in repo/logs/fixtures.
 */
import { readFileSync } from "node:fs";
import { Client, Metadata, credentials } from "@grpc/grpc-js";
import type {
  CreateSandboxRequest,
  DeleteSandboxRequest,
  DeleteSandboxResponse,
  ExecSandboxRequest,
  GetSandboxRequest,
  OpenShellExecTransport,
  OpenShellReadinessTransport,
  SandboxResponse,
  SandboxStreamEvent,
  WatchSandboxRequest,
} from "./client.js";
import {
  CREATE_SANDBOX_METHOD,
  DELETE_SANDBOX_METHOD,
  EXEC_SANDBOX_METHOD,
  type ExecSandboxEvent,
  type ExecSandboxRequestWire,
  GET_SANDBOX_METHOD,
  type SandboxStreamEventWire,
  WATCH_SANDBOX_METHOD,
  type WatchSandboxRequestWire,
  decodeDeleteSandboxResponse,
  decodeExecSandboxEvent,
  decodeSandboxResponse,
  decodeSandboxStreamEvent,
  encodeCreateSandboxRequest,
  encodeDeleteSandboxRequest,
  encodeExecSandboxRequest,
  encodeGetSandboxRequest,
  encodeWatchSandboxRequest,
} from "./proto/openshell.subset.codec.js";

/**
 * The minimal EventEmitter-shaped server-stream handle the transport adapts into an `AsyncIterable`.
 * Both the real grpc-js `ClientReadableStream<ExecSandboxEvent>` (returned by `makeServerStreamRequest`,
 * a Node `Readable` so it already satisfies this) and the unit-test fake satisfy it: `data`/`end`/`error`
 * events + a `cancel()` to tear the stream down on abort. Decoding from wire bytes happens in the
 * grpc-js `deserialize` callback BEFORE this seam.
 */
export interface ExecStreamHandle {
  on(event: "data", cb: (ev: ExecSandboxEvent) => void): ExecStreamHandle;
  on(event: "end", cb: () => void): ExecStreamHandle;
  on(event: "error", cb: (err: Error) => void): ExecStreamHandle;
  cancel(): void;
}

/**
 * The minimal EventEmitter-shaped server-stream handle the transport adapts into an
 * `AsyncIterable<SandboxStreamEvent>` for WatchSandbox (slice SLICE-OS-S2b). Identical SHAPE to
 * {@link ExecStreamHandle} but typed for the decoded `SandboxStreamEventWire` frames. The real grpc-js
 * `ClientReadableStream<SandboxStreamEventWire>` (a Node `Readable` exposing `cancel()`) and the unit-
 * test fake both satisfy it. Decoding from wire bytes happens in the grpc-js `deserialize` callback
 * BEFORE this seam (so the fake supplies pre-decoded events).
 */
export interface WatchStreamHandle {
  on(event: "data", cb: (ev: SandboxStreamEventWire) => void): WatchStreamHandle;
  on(event: "end", cb: () => void): WatchStreamHandle;
  on(event: "error", cb: (err: Error) => void): WatchStreamHandle;
  cancel(): void;
}

/**
 * The vendor-neutral unary seam (slice SLICE-OS-S2a): send `requestBytes` to the fully-qualified
 * gRPC `method` and resolve the raw reply bytes (the codec decodes them in the caller). The real
 * grpc-js `makeUnaryRequest` (built lazily from the cert PATHS) satisfies this; the unit test injects
 * an in-process double — mirroring the `openExecStream` server-stream seam. A gRPC error (refused /
 * DEADLINE_EXCEEDED / malformed) rejects, which the adapter converges deny-by-default.
 */
export type UnaryRequestFn = (method: string, requestBytes: Buffer) => Promise<Buffer>;

export interface OpenShellGrpcTransportOpts {
  /** Gateway endpoint (host:port, e.g. `127.0.0.1:17670`). Treated as sensitive: NEVER logged / leaked. */
  readonly endpoint: string;
  /** Path to the CA cert (rootCerts) — read from disk, never inlined. */
  readonly caCertPath: string;
  /** Path to the client cert (certChain) — read from disk, never inlined. */
  readonly clientCertPath: string;
  /** Path to the client key (privateKey) — read from disk, never inlined. */
  readonly clientKeyPath: string;
  /**
   * Default wall-clock budget for an exec stream. Retained for API compatibility with OS-S1 callers /
   * the live harness; the deadline is ENFORCED by the adapter's single accumulator (`streamExec`), not
   * here. Passing it through `OpenShellSandboxAdapter.execSandbox(…, { deadlineMs })` is how it bites.
   */
  readonly deadlineMs?: number;
  /**
   * Default hard cap on total buffered output bytes. Like `deadlineMs`, the CAP is enforced by the
   * adapter's accumulator, not by this thin transport. Retained for API compatibility.
   */
  readonly maxOutputBytes?: number;
  /**
   * TLS server name to verify against / send as SNI. The OpenShell gateway listens on an IP
   * (`127.0.0.1:17670`), but Node TLS refuses to set the SNI servername to an IP address
   * ("Setting the TLS ServerName to an IP address is not permitted"), which makes the grpc-js mTLS
   * handshake fail. The gateway's server cert carries `DNS:localhost` (among others) in its SAN, so we
   * override the SNI / authority to a DNS name in that SAN. Defaults to `localhost`. NOT sensitive.
   */
  readonly serverNameOverride?: string;
  /**
   * Test seam: open the `ExecSandbox` server-stream for `request`. Production omits it and a real
   * grpc-js mTLS Client + `makeServerStreamRequest` is built lazily from the cert PATHS (so tests stay
   * network-free, certless, and hermetic). Tests inject a fake stream. Mirrors the ingest/health
   * injected-client seam.
   */
  readonly openExecStream?: (request: ExecSandboxRequestWire) => ExecStreamHandle;
  /**
   * Test seam: drive a unary RPC (send `requestBytes` to `method` -> reply bytes). Production omits it
   * and a real grpc-js mTLS Client + `makeUnaryRequest` is built lazily from the cert PATHS (so tests
   * stay network-free, certless, and hermetic). Tests inject a fake unary fn. Mirrors `openExecStream`.
   */
  readonly makeUnary?: UnaryRequestFn;
  /**
   * Test seam (slice SLICE-OS-S2b): open the `WatchSandbox` server-stream for `request`. Production
   * omits it and a real grpc-js mTLS Client + `makeServerStreamRequest` is built lazily from the cert
   * PATHS (so tests stay network-free, certless, and hermetic). Tests inject a fake stream. Mirrors
   * `openExecStream`.
   */
  readonly openWatchStream?: (request: WatchSandboxRequestWire) => WatchStreamHandle;
}

/**
 * Build an `OpenShellExecTransport` over an mTLS gRPC channel to the gateway — the transport
 * `OpenShellSandboxAdapter` consumes directly.
 *
 * mTLS channel construction (grpc-js `createSsl` arg order: rootCerts, privateKey, certChain):
 *   credentials.createSsl(readFileSync(caCertPath), readFileSync(clientKeyPath), readFileSync(clientCertPath))
 * The certs are read from the supplied PATHS lazily, ONLY when no `openExecStream` test seam is given,
 * so the unit tests never read a cert nor open a socket.
 *
 * `health()` reports `{ ok: true }` (the live exec path does not depend on a Health RPC here; S1's
 * health client wraps Health). `createSandbox` / `getSandbox` / `deleteSandbox` are REAL unary RPCs
 * over the SAME mTLS channel (OS-S2a); `execSandbox` is the converged server-stream (NC-S11b);
 * `watchSandbox` is the REAL `WatchSandbox` server-stream (OS-S2b). The returned object therefore
 * satisfies the COMPLETE `OpenShellReadinessTransport` AND `OpenShellExecTransport`.
 */
export function createOpenShellGrpcTransport(
  opts: OpenShellGrpcTransportOpts,
): OpenShellReadinessTransport & OpenShellExecTransport {
  // Build the real mTLS grpc-js sources LAZILY (one shared Client; certs read + channel built on first
  // actual use), so a unit test that injects ONLY one seam (exec OR unary) never triggers a cert read
  // for the other. The exec stream source and the unary fn share the SAME channel, so a single mTLS
  // handshake backs both exec and the lifecycle RPCs.
  let grpc: ReturnType<typeof buildGrpc> | undefined;
  const lazyGrpc = (): ReturnType<typeof buildGrpc> => {
    grpc ??= buildGrpc(opts);
    return grpc;
  };
  const openExecStream =
    opts.openExecStream ?? ((req: ExecSandboxRequestWire) => lazyGrpc().openExecStream(req));
  const makeUnary: UnaryRequestFn =
    opts.makeUnary ?? ((method: string, bytes: Buffer) => lazyGrpc().makeUnary(method, bytes));
  const openWatchStream =
    opts.openWatchStream ?? ((req: WatchSandboxRequestWire) => lazyGrpc().openWatchStream(req));

  return {
    health(): Promise<{ ok: boolean }> {
      // The exec transport does not wrap a Health RPC (S1's health client does); exec health is proven
      // by an actual exec. Report ok so the lifecycle seam is satisfied.
      return Promise.resolve({ ok: true });
    },

    async createSandbox(req: CreateSandboxRequest): Promise<SandboxResponse> {
      // OS-S2a: real unary CreateSandbox. A gRPC error rejects (the adapter fails closed on it); a
      // garbled/empty reply decodes to `{}` and the adapter denies on a missing name. No endpoint /
      // cert detail is constructed here — the underlying grpc-js error is propagated AS-IS for the
      // adapter's credential-blind deny() boundary to swallow.
      const reply = await makeUnary(CREATE_SANDBOX_METHOD, encodeCreateSandboxRequest(req));
      return decodeSandboxResponse(reply);
    },

    async getSandbox(req: GetSandboxRequest): Promise<SandboxResponse> {
      // OS-S2a: real unary GetSandbox (the adapter's getSandbox-polling readiness path).
      const reply = await makeUnary(GET_SANDBOX_METHOD, encodeGetSandboxRequest(req));
      return decodeSandboxResponse(reply);
    },

    async deleteSandbox(req: DeleteSandboxRequest): Promise<DeleteSandboxResponse> {
      // OS-S2a: real unary DeleteSandbox (keyed by the canonical name; the adapter passes ref.name).
      const reply = await makeUnary(DELETE_SANDBOX_METHOD, encodeDeleteSandboxRequest(req));
      return decodeDeleteSandboxResponse(reply);
    },

    watchSandbox(
      req: WatchSandboxRequest,
      signal?: AbortSignal,
    ): AsyncIterable<SandboxStreamEvent> {
      // OS-S2b: REAL WatchSandbox server-stream. Build the wire request from the adapter's curated
      // {id, followStatus, stopOnTerminal} (the codec omits proto3 zero/false fields). The stream
      // yields each decoded SandboxStreamEvent (only `sandbox` snapshots carry a readiness signal; a
      // non-sandbox variant decodes to `{ sandbox: undefined }`). NO accumulation / phase decision here
      // — the adapter's `watchUntilReady` consumes + decides. A stream error throws (the adapter fails
      // closed); an abort cancels the underlying stream (no leak).
      const wire: WatchSandboxRequestWire = {
        id: req.id,
        ...(req.followStatus !== undefined ? { followStatus: req.followStatus } : {}),
        ...(req.stopOnTerminal !== undefined ? { stopOnTerminal: req.stopOnTerminal } : {}),
      };
      return streamWatchSandbox(openWatchStream, wire, signal);
    },

    execSandbox(req: ExecSandboxRequest, signal?: AbortSignal): AsyncIterable<ExecSandboxEvent> {
      // Build the wire request from the adapter's neutral ExecSandboxRequest. proto3 zero/empty values
      // are omitted by the codec; only set fields the caller supplied.
      const wire: ExecSandboxRequestWire = {
        sandboxId: req.sandboxId,
        command: req.command,
        ...(req.workdir !== undefined ? { workdir: req.workdir } : {}),
        ...(req.environment !== undefined ? { environment: req.environment } : {}),
        ...(req.timeoutSeconds !== undefined ? { timeoutSeconds: req.timeoutSeconds } : {}),
        ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
      };
      return streamExecSandbox(openExecStream, wire, signal);
    },
  };
}

/**
 * Adapt the EventEmitter-shaped `ExecStreamHandle` into an `AsyncIterable<ExecSandboxEvent>` that yields
 * each frame in arrival order, completes on `end`, and throws on a stream `error`. The caller's
 * `AbortSignal` (if any) is wired to `handle.cancel()` so the adapter's deadline / overflow abort tears
 * the underlying gRPC stream down (no leaked stream). NO accumulation, NO deadline, NO output cap here
 * — the adapter's `streamExec` is the SINGLE accumulator that owns all of that.
 *
 * A synchronous throw from opening the stream (transport refused) is re-thrown from the iterator (the
 * adapter's `streamExec` try/catch converges it deny-by-default). We never surface the underlying error
 * detail verbatim across this seam — but a stream `error` is propagated as-is so the adapter can fail
 * closed on it; the adapter NEVER places it in a reason / log (credential-blind there).
 */
async function* streamExecSandbox(
  openExecStream: (request: ExecSandboxRequestWire) => ExecStreamHandle,
  request: ExecSandboxRequestWire,
  signal?: AbortSignal,
): AsyncIterable<ExecSandboxEvent> {
  const handle = openExecStream(request);

  // Wire the abort -> cancel. If the signal is ALREADY aborted, cancel immediately (and never start
  // consuming). Otherwise listen once; cancelling a closed stream is harmless.
  const cancel = (): void => {
    try {
      handle.cancel();
    } catch {
      // a cancel on an already-closed stream is harmless; never surface it.
    }
  };
  if (signal?.aborted === true) {
    cancel();
    return;
  }
  const onAbort = (): void => cancel();
  signal?.addEventListener("abort", onAbort, { once: true });

  // Bridge the event emitter into a pull queue so the async generator can `yield` each frame.
  const queue: ExecSandboxEvent[] = [];
  let ended = false;
  let error: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    if (wake !== undefined) {
      const w = wake;
      wake = undefined;
      w();
    }
  };

  handle
    .on("data", (ev: ExecSandboxEvent) => {
      queue.push(ev);
      notify();
    })
    .on("end", () => {
      ended = true;
      notify();
    })
    .on("error", (err: Error) => {
      error = err;
      ended = true;
      notify();
    });

  try {
    for (;;) {
      while (queue.length > 0) {
        const ev = queue.shift();
        if (ev !== undefined) yield ev;
      }
      if (error !== undefined) throw error;
      if (ended) return;
      // Wait for the next emitter event (data/end/error). Re-loop to drain the queue when woken.
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    // The consumer stopped iterating (return / throw / abort): tear the stream down + drop the listener.
    signal?.removeEventListener("abort", onAbort);
    cancel();
  }
}

/**
 * Adapt the EventEmitter-shaped `WatchStreamHandle` into an `AsyncIterable<SandboxStreamEventWire>` that
 * yields each decoded snapshot in arrival order, completes on `end`, and throws on a stream `error`
 * (mirrors {@link streamExecSandbox} exactly). The caller's `AbortSignal` (the adapter's deadline /
 * cancellation) is wired to `handle.cancel()` so a deny / READY observation tears the underlying gRPC
 * stream down (no leaked stream). NO accumulation, NO phase decision here — the adapter's
 * `watchUntilReady` is the SINGLE consumer that decides READY / ERROR / pending. A stream `error` is
 * propagated as-is so the adapter can fail closed on it (the adapter NEVER places it in a reason / log
 * — credential-blind there).
 */
async function* streamWatchSandbox(
  openWatchStream: (request: WatchSandboxRequestWire) => WatchStreamHandle,
  request: WatchSandboxRequestWire,
  signal?: AbortSignal,
): AsyncIterable<SandboxStreamEventWire> {
  const handle = openWatchStream(request);

  const cancel = (): void => {
    try {
      handle.cancel();
    } catch {
      // a cancel on an already-closed stream is harmless; never surface it.
    }
  };
  if (signal?.aborted === true) {
    cancel();
    return;
  }
  const onAbort = (): void => cancel();
  signal?.addEventListener("abort", onAbort, { once: true });

  const queue: SandboxStreamEventWire[] = [];
  let ended = false;
  let error: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    if (wake !== undefined) {
      const w = wake;
      wake = undefined;
      w();
    }
  };

  handle
    .on("data", (ev: SandboxStreamEventWire) => {
      queue.push(ev);
      notify();
    })
    .on("end", () => {
      ended = true;
      notify();
    })
    .on("error", (err: Error) => {
      error = err;
      ended = true;
      notify();
    });

  try {
    for (;;) {
      while (queue.length > 0) {
        const ev = queue.shift();
        if (ev !== undefined) yield ev;
      }
      if (error !== undefined) throw error;
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    cancel();
  }
}

/**
 * Build the production mTLS grpc-js sources (lazy; exercised by the live harness, never by the
 * hermetic unit tests). Reads the cert PATHS, constructs ONE mTLS channel with the grpc-js
 * `createSsl(rootCerts, privateKey, certChain)` arg order, and returns BOTH:
 *   - `openExecStream`: opens an `ExecSandbox` server-stream via `makeServerStreamRequest` (encode
 *     request -> decode each ExecSandboxEvent frame). The returned `ClientReadableStream` is a Node
 *     `Readable` (already an `AsyncIterable`) AND exposes `cancel()`, so it satisfies the vendor-neutral
 *     {@link ExecStreamHandle}.
 *   - `makeUnary`: drives a unary RPC via `makeUnaryRequest` (identity serialize: we already hold the
 *     encoded request bytes; identity deserialize: we return the raw reply bytes and decode in the
 *     caller). A gRPC status error surfaces as a rejected promise.
 *   - `openWatchStream` (slice SLICE-OS-S2b): opens a `WatchSandbox` server-stream via
 *     `makeServerStreamRequest` (encode WatchSandboxRequest -> decode each SandboxStreamEvent frame),
 *     mirroring `openExecStream`. The returned `ClientReadableStream` satisfies {@link WatchStreamHandle}.
 * All three share the SAME Client so a single mTLS handshake backs exec + lifecycle + watch.
 */
function buildGrpc(opts: OpenShellGrpcTransportOpts): {
  openExecStream: (request: ExecSandboxRequestWire) => ExecStreamHandle;
  makeUnary: UnaryRequestFn;
  openWatchStream: (request: WatchSandboxRequestWire) => WatchStreamHandle;
} {
  // Read the mTLS materials from PATHS (never inlined). grpc-js createSsl arg order:
  // rootCerts (CA), privateKey (client key), certChain (client cert).
  const channelCreds = credentials.createSsl(
    readFileSync(opts.caCertPath),
    readFileSync(opts.clientKeyPath),
    readFileSync(opts.clientCertPath),
  );
  // Node TLS forbids an IP as the SNI servername; the gateway listens on 127.0.0.1 but its server cert
  // has DNS:localhost in the SAN, so override the SNI / authority to a DNS name in the SAN (default
  // "localhost"). Without this, the mTLS subchannel fails CONNECTING -> TRANSIENT_FAILURE and every
  // call returns a status error before any exit event.
  const serverName = opts.serverNameOverride ?? "localhost";
  const client = new Client(opts.endpoint, channelCreds, {
    "grpc.ssl_target_name_override": serverName,
    "grpc.default_authority": serverName,
  });

  const openExecStream = (request: ExecSandboxRequestWire): ExecStreamHandle => {
    const call = client.makeServerStreamRequest<ExecSandboxRequestWire, ExecSandboxEvent>(
      EXEC_SANDBOX_METHOD,
      encodeExecSandboxRequest,
      (bytes: Buffer) => decodeExecSandboxEvent(bytes),
      request,
      new Metadata(),
    );
    // The grpc-js ClientReadableStream already exposes on('data'|'end'|'error') + cancel(); narrow it
    // to the vendor-neutral handle the consumer expects.
    return call as unknown as ExecStreamHandle;
  };

  const makeUnary: UnaryRequestFn = (method: string, requestBytes: Buffer): Promise<Buffer> =>
    new Promise<Buffer>((resolve, reject) => {
      // Identity serialize/deserialize: we already hold the encoded request bytes and want the raw
      // reply bytes (the codec decodes them in the caller). The deadline is the channel default; the
      // caller (adapter) wraps a wall-clock budget. A gRPC status error rejects (deny-by-default).
      client.makeUnaryRequest<Buffer, Buffer>(
        method,
        (b: Buffer) => b,
        (b: Buffer) => b,
        requestBytes,
        new Metadata(),
        (err, value) => {
          if (err !== null && err !== undefined) reject(err);
          else if (value === undefined)
            reject(new Error("openshell unary: empty reply (fail-closed)"));
          else resolve(value);
        },
      );
    });

  const openWatchStream = (request: WatchSandboxRequestWire): WatchStreamHandle => {
    const call = client.makeServerStreamRequest<WatchSandboxRequestWire, SandboxStreamEventWire>(
      WATCH_SANDBOX_METHOD,
      encodeWatchSandboxRequest,
      (bytes: Buffer) => decodeSandboxStreamEvent(bytes),
      request,
      new Metadata(),
    );
    // The grpc-js ClientReadableStream already exposes on('data'|'end'|'error') + cancel(); narrow it
    // to the vendor-neutral handle the consumer expects.
    return call as unknown as WatchStreamHandle;
  };

  return { openExecStream, makeUnary, openWatchStream };
}
