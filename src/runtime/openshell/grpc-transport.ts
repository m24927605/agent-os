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
 * to `call.cancel()`, and expose the stream as an `AsyncIterable<ExecSandboxEvent>`.
 *
 * FAIL-CLOSED INVARIANT (deny-by-default): the lifecycle primitives `createSandbox` / `deleteSandbox`
 * are NOT yet implemented (they land in OS-S2). They REJECT with a static reason rather than silently
 * claiming success — so `new OpenShellSandboxAdapter(this)` has a valid `OpenShellLifecycleTransport`
 * while a caller that tries to create/delete fails closed. The exec stream itself never fabricates a
 * result: a stream `error`, a stream `end` before exit, an abort, etc. surface to the adapter (the
 * single accumulator), which converges them deny-by-default.
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
  OpenShellExecTransport,
  SandboxResponse,
} from "./client.js";
import {
  EXEC_SANDBOX_METHOD,
  type ExecSandboxEvent,
  type ExecSandboxRequestWire,
  decodeExecSandboxEvent,
  encodeExecSandboxRequest,
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
}

/** Static deny reason for the not-yet-implemented lifecycle primitives (credential-blind; deny-by-default). */
const LIFECYCLE_NOT_IMPLEMENTED =
  "openshell grpc transport: lifecycle not implemented until OS-S2 (fail-closed)";

/**
 * Build an `OpenShellExecTransport` over an mTLS gRPC channel to the gateway — the transport
 * `OpenShellSandboxAdapter` consumes directly.
 *
 * mTLS channel construction (grpc-js `createSsl` arg order: rootCerts, privateKey, certChain):
 *   credentials.createSsl(readFileSync(caCertPath), readFileSync(clientKeyPath), readFileSync(clientCertPath))
 * The certs are read from the supplied PATHS lazily, ONLY when no `openExecStream` test seam is given,
 * so the unit tests never read a cert nor open a socket.
 *
 * `health()` reports `{ ok: true }` (the live exec path does not depend on a Health RPC here; readiness
 * is OS-S2 / out of scope). `createSandbox` / `deleteSandbox` FAIL CLOSED (reject) until OS-S2 makes
 * them real — they exist only so the returned object is a valid `OpenShellLifecycleTransport`.
 */
export function createOpenShellGrpcTransport(
  opts: OpenShellGrpcTransportOpts,
): OpenShellExecTransport {
  // Build the real mTLS grpc-js stream source lazily ONLY when no test seam is injected.
  const openExecStream = opts.openExecStream ?? buildGrpcExecStreamSource(opts);

  return {
    health(): Promise<{ ok: boolean }> {
      // The exec transport does not wrap a Health RPC (S1's health client does); exec health is proven
      // by an actual exec. Report ok so the lifecycle seam is satisfied; readiness lands in OS-S2.
      return Promise.resolve({ ok: true });
    },

    createSandbox(_req: CreateSandboxRequest): Promise<SandboxResponse> {
      // Deny-by-default: OS-S2 wires the real CreateSandbox RPC. Until then a create attempt fails
      // closed (never a silent fake success). No endpoint / cert detail in the reason.
      return Promise.reject(new Error(LIFECYCLE_NOT_IMPLEMENTED));
    },

    deleteSandbox(_req: DeleteSandboxRequest): Promise<DeleteSandboxResponse> {
      // Deny-by-default: OS-S2 wires the real DeleteSandbox RPC. Until then a delete attempt fails closed.
      return Promise.reject(new Error(LIFECYCLE_NOT_IMPLEMENTED));
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
 * Build the production mTLS grpc-js stream source (lazy; exercised by the live harness, never by the
 * hermetic unit tests). Reads the cert PATHS, constructs an mTLS channel with the grpc-js
 * `createSsl(rootCerts, privateKey, certChain)` arg order, and opens an `ExecSandbox` server-stream via
 * `makeServerStreamRequest` (encode request -> decode each ExecSandboxEvent frame). The returned
 * `ClientReadableStream` is a Node `Readable` (already an `AsyncIterable`) AND exposes `cancel()`, so it
 * satisfies the vendor-neutral {@link ExecStreamHandle}.
 */
function buildGrpcExecStreamSource(
  opts: OpenShellGrpcTransportOpts,
): (request: ExecSandboxRequestWire) => ExecStreamHandle {
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

  return (request: ExecSandboxRequestWire): ExecStreamHandle => {
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
}
