/**
 * The mTLS gRPC `ExecSandbox` transport — slice SLICE-OS-S1 (the FIRST real OpenShell gRPC transport).
 *
 * This is a SINGLE chokepoint where the runtime RPC vendor (@grpc/grpc-js) + the OpenShell wire codec
 * are named for exec. It lives under src/runtime/openshell/ (an adapter sub-tree, NOT core), so the
 * `no-vendor-in-core` boundary (.dependency-cruiser.cjs) stays intact — core consumes only injected
 * ports. It mirrors the ingest grpc-js client (src/runtime/ingest/grpc-client.ts) and the lazy,
 * test-injectable construction of the OpenShell health client (client.ts) / ingest transport
 * (transport.ts): production builds the real grpc-js Client; tests inject a fake stream.
 *
 * Responsibility (and ONLY this): build an mTLS channel to the gateway, drive the `ExecSandbox`
 * server-stream (encodeExecSandboxRequest -> stream<ExecSandboxEvent>), accumulate stdout/stderr bytes,
 * and converge on the terminal `ExecSandboxExit` into an {@link ExecResult}.
 *
 * FAIL-CLOSED INVARIANT (deny-by-default; NEVER fabricate success): a stream that closes WITHOUT a
 * terminal exit event, a wall-clock deadline that elapses before exit, a total output size that would
 * exceed `maxOutputBytes`, a stream `error`, OR a synchronous throw ALL REJECT — the transport NEVER
 * invents an exit code 0. A NON-ZERO exit code is a faithful command result (resolved as-is), NOT a
 * deny condition. On overflow / deadline the underlying gRPC stream is CANCELLED so the gateway stops
 * producing (no leaked stream).
 *
 * CREDENTIAL-BLIND: the mTLS materials are read from PATHS (never inlined); NO cert/key/endpoint
 * content is ever placed in an error message, a reason, or a log (mirrors the adapter's discipline —
 * a denied reason carries no baseUrl/endpoint). The certs here are the LOCAL gateway mTLS material
 * (not an LLM key), but the discipline is identical: nothing sensitive on disk in repo/logs/fixtures.
 */
import { readFileSync } from "node:fs";
import { Client, Metadata, credentials } from "@grpc/grpc-js";
import {
  EXEC_SANDBOX_METHOD,
  type ExecSandboxEvent,
  type ExecSandboxRequestWire,
  decodeExecSandboxEvent,
  encodeExecSandboxRequest,
} from "./proto/openshell.subset.codec.js";

/** Converged result of a sandbox exec: the command exit code + the full stdout/stderr byte streams. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/** Per-call options for {@link OpenShellGrpcExecTransport.execSandbox}. */
export interface ExecOpts {
  /** Working directory inside the sandbox (ExecSandboxRequest.workdir). */
  readonly workdir?: string;
  /** Env overrides (ExecSandboxRequest.environment). Caller is responsible for placeholder-only values. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Command timeout in seconds (ExecSandboxRequest.timeout_seconds); 0 = no timeout. */
  readonly timeoutSeconds?: number;
  /** stdin payload (ExecSandboxRequest.stdin). */
  readonly stdin?: Uint8Array;
  /**
   * Wall-clock budget for consuming the whole exec stream. Expiry BEFORE a terminal exit => REJECT
   * (never fabricate success) + the stream is cancelled. Defaults to {@link DEFAULT_DEADLINE_MS}.
   */
  readonly deadlineMs?: number;
  /**
   * Hard cap on the TOTAL buffered stdout+stderr bytes. Once the accumulated size would exceed this cap
   * the stream is cancelled and the call REJECTS (never OOMs the host, never returns a truncated
   * success). Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}.
   */
  readonly maxOutputBytes?: number;
}

/**
 * The exec capability of the OpenShell gRPC transport. `execSandbox` resolves an {@link ExecResult} on
 * an observed terminal exit (any code) and REJECTS on every fail-closed path. This is the grpc
 * transport's public exec shape (distinct from the adapter-internal `OpenShellExecTransport` event
 * stream seam in client.ts, which leaves accumulation to the adapter).
 */
export interface OpenShellGrpcExecTransport {
  execSandbox(sandboxId: string, command: readonly string[], opts?: ExecOpts): Promise<ExecResult>;
}

/**
 * The minimal EventEmitter-shaped server-stream handle the transport consumes. Both the real grpc-js
 * `ClientReadableStream<ExecSandboxEvent>` (returned by `makeServerStreamRequest`) and the unit-test
 * fake satisfy it: `data`/`end`/`error` events + a `cancel()` to tear the stream down on deadline /
 * overflow. Decoding from wire bytes happens in the grpc-js `deserialize` callback BEFORE this seam.
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
  /** Default wall-clock budget for an exec stream (per call override via {@link ExecOpts.deadlineMs}). */
  readonly deadlineMs?: number;
  /** Default hard cap on total buffered output bytes (per call override via {@link ExecOpts.maxOutputBytes}). */
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

/** Default wall-clock budget for an exec stream when the caller supplies none (60s). */
const DEFAULT_DEADLINE_MS = 60_000;

/** Default hard cap on total buffered stdout+stderr bytes (8 MiB) — overflow => reject (never OOM). */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Concatenate accumulated byte chunks into one contiguous Uint8Array (preserving order). */
function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Build an `OpenShellGrpcExecTransport` over an mTLS gRPC channel to the gateway.
 *
 * mTLS channel construction (grpc-js `createSsl` arg order: rootCerts, privateKey, certChain):
 *   credentials.createSsl(readFileSync(caCertPath), readFileSync(clientKeyPath), readFileSync(clientCertPath))
 * The certs are read from the supplied PATHS lazily, ONLY when no `openExecStream` test seam is given,
 * so the unit tests never read a cert nor open a socket.
 */
export function createOpenShellGrpcTransport(
  opts: OpenShellGrpcTransportOpts,
): OpenShellGrpcExecTransport {
  const defaultDeadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const defaultMaxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  // Build the real mTLS grpc-js stream source lazily ONLY when no test seam is injected.
  const openExecStream = opts.openExecStream ?? buildGrpcExecStreamSource(opts);

  return {
    execSandbox(
      sandboxId: string,
      command: readonly string[],
      execOpts?: ExecOpts,
    ): Promise<ExecResult> {
      const deadlineMs = execOpts?.deadlineMs ?? defaultDeadlineMs;
      const maxOutputBytes = execOpts?.maxOutputBytes ?? defaultMaxOutputBytes;
      const request: ExecSandboxRequestWire = {
        sandboxId,
        command,
        ...(execOpts?.workdir !== undefined ? { workdir: execOpts.workdir } : {}),
        ...(execOpts?.environment !== undefined ? { environment: execOpts.environment } : {}),
        ...(execOpts?.timeoutSeconds !== undefined
          ? { timeoutSeconds: execOpts.timeoutSeconds }
          : {}),
        ...(execOpts?.stdin !== undefined ? { stdin: execOpts.stdin } : {}),
      };
      return consumeExecStream(openExecStream, request, deadlineMs, maxOutputBytes);
    },
  };
}

/**
 * Consume the `ExecSandbox` server-stream until the terminal `ExecSandboxExit` or a fail-closed event.
 * Accumulates stdout/stderr chunks in arrival order; resolves `ok` ONLY on an observed exit event (any
 * exit code). REJECTS — never fabricating success — on: a stream that ends before exit, a wall-clock
 * deadline expiry, a total output size that would exceed `maxOutputBytes`, a malformed oneof frame, a
 * stream `error`, OR a synchronous throw. On deadline / overflow the underlying stream is cancelled.
 *
 * NO endpoint / cert content is ever placed in a rejection message (credential-blind).
 */
function consumeExecStream(
  openExecStream: (request: ExecSandboxRequestWire) => ExecStreamHandle,
  request: ExecSandboxRequestWire,
  deadlineMs: number,
  maxOutputBytes: number,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let buffered = 0;
    let settled = false;
    let stream: ExecStreamHandle | undefined;

    // Wall-clock deadline: a never-settling stream can never hang the caller. The callback runs LATER
    // (after `settle` below is defined), so referencing `settle` here is safe. Fail closed (no exit).
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      settle({ err: new Error("openshell exec: deadline exceeded before exit (fail-closed)") });
    }, deadlineMs);

    /** Resolve/reject exactly once; always cancel the stream + clear the timer (no leak). */
    const settle = (outcome: { ok: ExecResult } | { err: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Best-effort cancel so a real gateway stops producing (overflow/deadline/early settle).
      if (stream !== undefined) {
        try {
          stream.cancel();
        } catch {
          // a cancel on an already-closed stream is harmless; never surface it.
        }
      }
      if ("ok" in outcome) resolve(outcome.ok);
      else reject(outcome.err);
    };

    // A synchronous throw from opening the stream (transport refused) fails closed.
    try {
      stream = openExecStream(request);
    } catch {
      // NEVER surface the underlying error (it may carry endpoint / cert detail). Fail closed.
      settle({ err: new Error("openshell exec: stream open failed (fail-closed)") });
      return;
    }

    stream
      .on("data", (ev: ExecSandboxEvent) => {
        if (settled) return;
        // Validate the oneof shape (untrusted wire frame): EXACTLY one variant must be present. A frame
        // with none or more than one is garbled and fails closed — never a (possibly truncated) success.
        const present =
          (ev.stdout !== undefined ? 1 : 0) +
          (ev.stderr !== undefined ? 1 : 0) +
          (ev.exit !== undefined ? 1 : 0);
        if (present !== 1) {
          settle({ err: new Error("openshell exec: malformed event oneof (fail-closed)") });
          return;
        }

        if (ev.exit !== undefined) {
          // Terminal: converge. A missing / non-integer exit_code fails closed (no fabricated 0).
          const code = ev.exit.exitCode;
          if (typeof code !== "number" || !Number.isInteger(code)) {
            settle({
              err: new Error("openshell exec: exit event missing exit_code (fail-closed)"),
            });
            return;
          }
          settle({
            ok: { exitCode: code, stdout: concatChunks(stdout), stderr: concatChunks(stderr) },
          });
          return;
        }

        // stdout or stderr chunk: the data field MUST be a Uint8Array (a garbled frame fails closed).
        const chunk = ev.stdout?.data ?? ev.stderr?.data;
        if (!(chunk instanceof Uint8Array)) {
          settle({ err: new Error("openshell exec: malformed chunk (fail-closed)") });
          return;
        }
        // Resource bound: reject (never OOM, never return a truncated success) once the total buffered
        // stdout+stderr would exceed the cap. settle() cancels the stream so the gateway stops producing.
        buffered += chunk.length;
        if (buffered > maxOutputBytes) {
          settle({ err: new Error("openshell exec: output exceeded max bytes (fail-closed)") });
          return;
        }
        if (ev.stdout !== undefined) stdout.push(chunk);
        else stderr.push(chunk);
      })
      .on("end", () => {
        // Stream closed WITHOUT a terminal exit event => fail closed (never fabricate success).
        settle({ err: new Error("openshell exec: stream ended before exit event (fail-closed)") });
      })
      .on("error", () => {
        // gRPC status error / RST_STREAM / decode error. NEVER surface it (it may carry endpoint /
        // cert detail). Fail closed.
        settle({ err: new Error("openshell exec: stream error before exit (fail-closed)") });
      });
  });
}

/**
 * Build the production mTLS grpc-js stream source (lazy; exercised by the main loop's live validation,
 * never by the hermetic unit tests). Reads the cert PATHS, constructs an mTLS channel with the grpc-js
 * `createSsl(rootCerts, privateKey, certChain)` arg order, and opens an `ExecSandbox` server-stream via
 * `makeServerStreamRequest` (encode request -> decode each ExecSandboxEvent frame). The returned handle
 * adapts the grpc-js `ClientReadableStream` to the vendor-neutral {@link ExecStreamHandle}.
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
