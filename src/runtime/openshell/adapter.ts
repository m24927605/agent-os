/**
 * OpenShellSandboxAdapter — slice P2R-R1-S2 (the FIRST real `SandboxAdapter` impl; design §3.3).
 *
 * SINGLE responsibility: translate the vendor-neutral `SandboxAdapter` create/destroy semantics into
 * OpenShell unary RPCs (CreateSandbox / DeleteSandbox) and maintain the in-memory
 * `SandboxId <-> OpenShell name` mapping. It holds NO policy decision (that is the PDP), injects NO
 * credential (that is OpenShell's SecretResolver at egress), and appends NO audit (orchestration
 * does that before the effect). It consumes the OpenShell vendor ONLY through the injected
 * `OpenShellLifecycleTransport` seam — so `no-vendor-in-core` stays intact for every core module.
 *
 * FAIL-CLOSED INVARIANT (deny-by-default): a malformed AgentContext, a non-pinned image, an unknown
 * sandbox id, a transport rejection (connection refused / deadline / malformed), OR an empty/garbled
 * SandboxResponse ALL resolve a `denied` AdapterResult. The adapter NEVER throws across the port
 * boundary and a denied `reason` NEVER carries baseUrl / endpoint / credential detail (the underlying
 * transport error is deliberately not surfaced into the reason or logged here).
 *
 * start/stop are deferred to S6 (OpenShell has no Start/Stop RPC; design §3.2). Until then they
 * fail CLOSED with an explicit reason rather than silently claiming success.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SandboxId, parseAgentContext } from "../../iam/ids.js";
import {
  type AdapterResult,
  type SandboxAdapter,
  type SandboxLifecycleEvent,
  type SandboxSpec,
  deny,
  ok,
} from "../substrate/index.js";
import {
  type CreateSandboxRequest,
  type ExecSandboxEvent,
  type ExecSandboxRequest,
  type OpenShellExecTransport,
  type OpenShellLifecycleTransport,
  type OpenShellProviderEnvTransport,
  type OpenShellReadinessTransport,
  PINNED_SANDBOX_IMAGE,
  SandboxPhase,
  type SandboxStreamEvent,
  assertPinnedImageDigest,
  isExecEnvValueAllowed,
} from "./client.js";
import { assertPlaceholderOnly } from "./provider-env.js";

/** Options for {@link OpenShellSandboxAdapter.awaitReady}. */
export interface AwaitReadyOpts {
  /** Wall-clock budget for the whole readiness probe (GetSandbox + Watch). Expiry => deny (not ready). */
  readonly deadlineMs: number;
}

/** Options for {@link OpenShellSandboxAdapter.execSandbox}. */
export interface ExecSandboxOpts {
  /** Working directory inside the sandbox (ExecSandboxRequest.workdir). */
  readonly workdir?: string;
  /** Env overrides — placeholder-only; a raw credential marker is denied (design §2.3). */
  readonly env?: Readonly<Record<string, string>>;
  /** Command timeout in seconds (ExecSandboxRequest.timeout_seconds); 0 = no timeout. */
  readonly timeoutSeconds?: number;
  /** stdin payload (ExecSandboxRequest.stdin). */
  readonly stdin?: Uint8Array;
  /**
   * Wall-clock budget for consuming the whole exec stream. Expiry BEFORE a terminal exit => deny
   * (never fabricate a success). Defaults to {@link DEFAULT_EXEC_DEADLINE_MS}.
   */
  readonly deadlineMs?: number;
  /**
   * Hard cap on the TOTAL buffered stdout+stderr bytes (deny-by-default resource bound). An untrusted
   * sandbox command can emit unbounded output; once the accumulated size would exceed this cap the
   * adapter aborts the stream and DENIES (never OOMs the host, never returns a truncated success).
   * Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}.
   */
  readonly maxOutputBytes?: number;
}

/** Converged result of a sandbox exec: the command exit code + the full stdout/stderr byte streams. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/**
 * Result of {@link OpenShellSandboxAdapter.execSandbox}. Mirrors the port's `AdapterResult` discipline
 * (auditable event on every path) but carries the richer `ExecResult` on success — the four frozen
 * P2-A port methods are unchanged; exec is an adapter-internal capability consumed by S6 / the layer
 * above. The `"start"` lifecycle is reused for the event (the P2-A enum is not extended for exec).
 */
export type ExecOutcome =
  | { status: "ok"; result: ExecResult; event: SandboxLifecycleEvent }
  | { status: "denied"; reason: string; event: SandboxLifecycleEvent };

/**
 * Result of {@link OpenShellSandboxAdapter.getProviderEnvironment} (slice S5). On success it carries
 * the placeholder-ONLY env (every value passed the {@link assertPlaceholderOnly} shape guard) plus the
 * non-secret provider-env `revision` as a decimal string. On a denied path it carries NO `env` field
 * at all — so a raw value the backend tried to leak never appears in the result. Mirrors the port's
 * auditable-event discipline (reuses the `"start"` lifecycle; the P2-A enum is not extended).
 */
export type ProviderEnvOutcome =
  | { status: "ok"; env: Record<string, string>; revision: string; event: SandboxLifecycleEvent }
  | { status: "denied"; reason: string; event: SandboxLifecycleEvent };

/** Default wall-clock budget for an exec stream when the caller supplies none. */
const DEFAULT_EXEC_DEADLINE_MS = 60_000;

/** Default hard cap on total buffered stdout+stderr bytes (8 MiB) — overflow => deny (never OOM). */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Absolute ceiling for `maxOutputBytes` (64 MiB) — a caller can lower it but never disable the cap. */
const MAX_OUTPUT_BYTES_CEILING = 64 * 1024 * 1024;

/**
 * Request-side resource caps (deny-by-default at the untrusted exec boundary). These bound the INPUT
 * a caller can forward into the sandbox before any RPC, complementing the response-side output-byte +
 * deadline caps. Generous enough for real commands, small enough that no single request can be used to
 * abuse the gateway. Oversized => deny before RPC.
 */
const MAX_ARGV_COUNT = 4096;
const MAX_ARGV_TOTAL_BYTES = 1 * 1024 * 1024; // 1 MiB of joined argv.
const MAX_WORKDIR_LEN = 4096;
const MAX_ENV_COUNT = 4096;
const MAX_ENV_ENTRY_BYTES = 128 * 1024; // per key+value.
const MAX_STDIN_BYTES = 8 * 1024 * 1024; // 8 MiB.
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60; // 1 day.
const MAX_DEADLINE_MS = 24 * 60 * 60 * 1000; // 1 day.

/** Non-allocating UTF-8 byte length (does NOT allocate a byte array, unlike `TextEncoder.encode`). */
const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * Runtime schema for exec inputs (TRUST BOUNDARY — the port accepts `unknown`-shaped JS callers). A
 * malformed OR oversized `cmd` / `opts` is DENIED before any RPC, never thrown across the boundary: a
 * non-string-array command, a null/non-string-valued env, a non-finite timeout/deadline/cap, an argv /
 * env / workdir / stdin that exceeds its size cap, etc. all fail closed. `maxOutputBytes` is clamped to
 * a finite positive integer within {@link MAX_OUTPUT_BYTES_CEILING} so a caller can never disable the
 * OOM guard with `Infinity`/`NaN`/a huge value.
 */
const ExecCommand = z
  .array(z.string())
  .min(1)
  .max(MAX_ARGV_COUNT)
  .refine(
    (argv) => argv.reduce((n, a) => n + byteLen(a), 0) <= MAX_ARGV_TOTAL_BYTES,
    "argv too large",
  );
const ExecOptsSchema = z
  .object({
    workdir: z.string().max(MAX_WORKDIR_LEN).optional(),
    env: z
      .record(z.string(), z.string())
      .refine((e) => Object.keys(e).length <= MAX_ENV_COUNT, "too many env entries")
      .refine(
        (e) => Object.entries(e).every(([k, v]) => byteLen(k) + byteLen(v) <= MAX_ENV_ENTRY_BYTES),
        "env entry too large",
      )
      .optional(),
    timeoutSeconds: z.number().int().nonnegative().finite().max(MAX_TIMEOUT_SECONDS).optional(),
    stdin: z
      .instanceof(Uint8Array)
      .refine((b) => b.length <= MAX_STDIN_BYTES, "stdin too large")
      .optional(),
    deadlineMs: z.number().int().positive().finite().max(MAX_DEADLINE_MS).optional(),
    maxOutputBytes: z.number().int().positive().max(MAX_OUTPUT_BYTES_CEILING).optional(),
  })
  .strict();

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
 * Map a (possibly unknown) `SandboxPhase` number to a readiness verdict. Deny-by-default: only the
 * exact READY enum is `ready`; only the exact ERROR enum is `errored`; EVERY other value — including
 * UNSPECIFIED/UNKNOWN, DELETING, a missing phase (`undefined`), OR an out-of-range enum (e.g. 99) — is
 * `pending` (NOT ready, NOT terminal). An unknown phase is therefore NEVER mistaken for READY.
 */
function classifyPhase(phase: number | undefined): "ready" | "errored" | "pending" {
  if (phase === SandboxPhase.SANDBOX_PHASE_READY) return "ready";
  if (phase === SandboxPhase.SANDBOX_PHASE_ERROR) return "errored";
  return "pending";
}

/**
 * The two OpenShell identifiers we must retain per sandbox. The gateway assigns BOTH at create time
 * (ObjectMeta, datamodel.proto:14/17) and the readiness RPCs key on DIFFERENT ones:
 *   - GetSandbox / DeleteSandbox key by `name` (server: `get_message_by_name`).
 *   - WatchSandbox keys by the stable gateway `id` (server: `get_message` by id).
 * Conflating them denies every PROVISIONING→READY watch against a real gateway, so we capture both.
 */
interface OpenShellRef {
  /** Human-readable name (ObjectMeta field 2). GetSandbox / DeleteSandbox lookup key. */
  readonly name: string;
  /** Stable gateway-assigned id (ObjectMeta field 1). WatchSandbox lookup key. */
  readonly id: string;
}

export class OpenShellSandboxAdapter implements SandboxAdapter {
  /** In-memory mapping: our `SandboxId` -> the OpenShell {name, id} ref. Lost mapping => deny. */
  private readonly refById = new Map<string, OpenShellRef>();

  constructor(private readonly transport: OpenShellLifecycleTransport) {}

  async createSandbox(ctx: unknown, spec: SandboxSpec): Promise<AdapterResult> {
    let context: ReturnType<typeof parseAgentContext>;
    try {
      context = parseAgentContext(ctx);
    } catch {
      // Bad context: fail closed BEFORE any RPC (no CreateSandbox is issued).
      return deny(ctx, "create", "invalid agent context (fail-closed)");
    }

    // Pinned-only: the wire image is either the spec image (if it is itself a pinned digest) or the
    // pinned default. A floating tag / malformed digest is denied BEFORE any RPC — a caller can never
    // boot an unpinned image.
    const image = spec.image ?? PINNED_SANDBOX_IMAGE;
    try {
      assertPinnedImageDigest(image);
    } catch {
      return deny(ctx, "create", "image must be a pinned sha256 digest (fail-closed)");
    }

    const req: CreateSandboxRequest = {
      spec: { template: { image } },
      ...(spec.labels !== undefined ? { labels: spec.labels } : {}),
    };

    let ref: OpenShellRef;
    try {
      const resp = await this.transport.createSandbox(req);
      const meta = resp.sandbox?.metadata;
      const name = meta?.name;
      if (typeof name !== "string" || name.length === 0) {
        // Empty / malformed response: deny, retain no mapping (deny-by-default on garbled wire).
        return deny(ctx, "create", "openshell returned no sandbox name (fail-closed)");
      }
      // Capture the stable gateway `id` too — WatchSandbox keys on it (DISTINCT from `name`). If the
      // gateway omits it, store an empty id; readiness then fails CLOSED on the watch path rather than
      // mis-keying Watch with the name (which a real gateway resolves to not_found).
      const wireId = meta?.id;
      ref = { name, id: typeof wireId === "string" ? wireId : "" };
    } catch {
      // Transport rejection (connection refused / deadline / decode): fail closed, NEVER throw, and
      // do NOT surface the underlying error (it could carry baseUrl / endpoint detail).
      return deny(ctx, "create", "openshell create rpc failed (fail-closed)");
    }

    const id = SandboxId.parse(`sbx-os-${randomUUID()}`);
    this.refById.set(id, ref);
    return ok(context, "create", id);
  }

  async destroySandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult> {
    let context: ReturnType<typeof parseAgentContext>;
    try {
      context = parseAgentContext(ctx);
    } catch {
      return deny(ctx, "destroy", "invalid agent context (fail-closed)");
    }

    let id: ReturnType<typeof SandboxId.parse>;
    try {
      id = SandboxId.parse(sandboxId);
    } catch {
      return deny(ctx, "destroy", "invalid sandbox id (fail-closed)");
    }

    const ref = this.refById.get(id);
    if (ref === undefined) {
      // Unknown id (mapping missing) => deny-by-default; issue NO DeleteSandbox (never guess a name).
      return deny(ctx, "destroy", "unknown sandbox (fail-closed)");
    }

    try {
      // DeleteSandbox keys on the canonical `name` (server: get_message_by_name), NOT the gateway id.
      await this.transport.deleteSandbox({ name: ref.name });
    } catch {
      // Delete failed: deny and KEEP the mapping so a forward-fix retry can still find the name.
      return deny(ctx, "destroy", "openshell delete rpc failed (fail-closed)");
    }

    this.refById.delete(id);
    return ok(context, "destroy", id);
  }

  /**
   * Readiness probe (slice S3; design §3.4) — NOT one of the four frozen `SandboxAdapter` port
   * methods (P2-A port shape is unchanged); it is an adapter-internal helper consumed by S6 / the
   * layer above before exec. It answers ONE question fail-closed: is this already-created sandbox
   * READY to execute?
   *
   * Flow: (1) validate ctx + resolve the mapped OpenShell name (bad ctx / unknown id => deny BEFORE
   * any RPC); (2) one-shot `GetSandbox` — READY => ok, ERROR => deny; (3) otherwise consume
   * `WatchSandbox(stop_on_terminal)` snapshots until READY (=> ok) / ERROR (=> deny) / the stream
   * ends or the deadline elapses (=> deny, not ready). EVERY non-happy path — unknown phase enum,
   * an RPC rejection, a synchronous or mid-stream throw, an empty stream, OR deadline expiry — fails
   * CLOSED to `denied` and the adapter NEVER throws across the port boundary nor leaks transport
   * detail (baseUrl / endpoint) into the reason. The `"start"` lifecycle is reused (the P2-A enum is
   * not extended for this internal helper) with the reason noting it is a readiness verdict.
   */
  async awaitReady(ctx: unknown, sandboxId: string, opts: AwaitReadyOpts): Promise<AdapterResult> {
    let context: ReturnType<typeof parseAgentContext>;
    try {
      context = parseAgentContext(ctx);
    } catch {
      return deny(ctx, "start", "invalid agent context (fail-closed)");
    }

    let id: ReturnType<typeof SandboxId.parse>;
    try {
      id = SandboxId.parse(sandboxId);
    } catch {
      return deny(ctx, "start", "invalid sandbox id (fail-closed)");
    }

    const ref = this.refById.get(id);
    if (ref === undefined) {
      // Unknown id (mapping missing) => deny-by-default; issue NO RPC (never guess a name).
      return deny(ctx, "start", "unknown sandbox (fail-closed)");
    }

    // The readiness primitives are an optional capability of the injected transport. A transport that
    // cannot watch readiness is fail-closed (NOT ready) rather than silently treated as ready. The two
    // functions are captured (narrowed) here so the rest of the probe holds non-undefined references.
    const transport = this.transport as Partial<OpenShellReadinessTransport>;
    const getSandbox = transport.getSandbox?.bind(transport);
    const watchSandbox = transport.watchSandbox?.bind(transport);
    if (getSandbox === undefined || watchSandbox === undefined) {
      return deny(ctx, "start", "openshell transport cannot probe readiness (fail-closed)");
    }

    // Step 2: one-shot GetSandbox, keyed by the canonical `name` (server: get_message_by_name).
    // READY => ok immediately; ERROR => deny (terminal).
    try {
      const resp = await getSandbox({ name: ref.name });
      const verdict = classifyPhase(resp.sandbox?.status?.phase);
      if (verdict === "ready") return ok(context, "start", id);
      if (verdict === "errored") {
        return deny(ctx, "start", "sandbox reported ERROR phase (not ready, fail-closed)");
      }
      // pending => fall through to the watch stream below.
    } catch {
      // GetSandbox rejected (refused / deadline / decode). Do NOT surface the error (it may carry
      // baseUrl / endpoint). Try the watch stream as a second chance; if it cannot reach READY the
      // overall verdict is still deny.
    }

    // The watch path keys on the gateway-assigned stable `id` (server: get_message by id), which is
    // DISTINCT from `name`. A missing id means the gateway never returned one at create time —
    // WatchSandbox cannot be keyed safely, so fail CLOSED (NOT ready) rather than mis-key with `name`.
    if (ref.id.length === 0) {
      return deny(ctx, "start", "no openshell sandbox id to watch (not ready, fail-closed)");
    }

    // Step 3: WatchSandbox(stop_on_terminal) until READY / ERROR / stream-end / deadline.
    return this.watchUntilReady(context, ctx, id, ref.id, watchSandbox, opts.deadlineMs);
  }

  /**
   * Consume the `WatchSandbox` snapshot stream until a terminal verdict or the deadline. Fail-closed
   * on EVERYTHING that is not an observed READY: ERROR phase, an unknown phase, a stream that ends
   * before READY, a synchronous throw from `watchSandbox`, a mid-stream iterator throw, OR deadline
   * expiry all resolve `denied`. The deadline is enforced with a race so a never-settling stream can
   * never hang the caller; the iterator is best-effort cancelled (`return()`) when the deadline wins.
   */
  private async watchUntilReady(
    context: ReturnType<typeof parseAgentContext>,
    ctx: unknown,
    id: ReturnType<typeof SandboxId.parse>,
    openshellId: string,
    watchSandbox: OpenShellReadinessTransport["watchSandbox"],
    deadlineMs: number,
  ): Promise<AdapterResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let iterator: AsyncIterator<SandboxStreamEvent> | undefined;
    const deadline = new Promise<AdapterResult>((resolve) => {
      timer = setTimeout(
        () => resolve(deny(ctx, "start", "readiness deadline exceeded (not ready, fail-closed)")),
        deadlineMs,
      );
    });

    const watch = (async (): Promise<AdapterResult> => {
      try {
        const stream = watchSandbox({
          id: openshellId,
          followStatus: true,
          stopOnTerminal: true,
        });
        iterator = stream[Symbol.asyncIterator]();
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) break; // stream closed before READY => not ready.
          const verdict = classifyPhase(next.value.sandbox?.status?.phase);
          if (verdict === "ready") return ok(context, "start", id);
          if (verdict === "errored") {
            return deny(ctx, "start", "sandbox reported ERROR phase (not ready, fail-closed)");
          }
          // pending (incl. unknown enum / non-snapshot event) => keep watching.
        }
        return deny(ctx, "start", "watch stream ended before READY (not ready, fail-closed)");
      } catch {
        // Synchronous throw from watchSandbox OR a mid-stream iterator throw (RST_STREAM / decode).
        // NEVER surface the error (it may carry baseUrl / endpoint). Fail closed.
        return deny(ctx, "start", "watch stream error before READY (not ready, fail-closed)");
      }
    })();

    try {
      return await Promise.race([watch, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Best-effort cancel a still-open stream when the deadline won (avoid a leaked iterator).
      if (iterator?.return !== undefined) {
        void iterator.return().catch(() => {});
      }
    }
  }

  /**
   * Execute a command inside an already-created sandbox (slice S4; design §3.4) — NOT one of the four
   * frozen `SandboxAdapter` port methods; an adapter-internal capability consumed by S6 / the layer
   * above. It drives `ExecSandbox` (server-stream, openshell.proto:67), accumulates stdout/stderr
   * chunks, and converges on the terminal `ExecSandboxExit.exit_code` (proto:685) into an
   * {@link ExecResult}.
   *
   * FAIL-CLOSED INVARIANT (deny-by-default, never fabricate success): a bad ctx / invalid or unknown
   * sandbox id / an env value carrying a raw credential marker (not a clean placeholder) ALL deny
   * BEFORE any RPC. Once streaming, a synchronous throw from `execSandbox`, a mid-stream iterator
   * throw, a stream that closes WITHOUT a terminal exit event, OR a deadline expiry ALL resolve
   * `denied` — the adapter NEVER invents an exit code 0 and NEVER throws across the boundary nor leaks
   * transport detail (baseUrl / endpoint) into the reason. A NON-ZERO exit code is a faithful command
   * result (status `ok`, `exitCode` reported as-is) — it is NOT a transport/deny condition.
   */
  async execSandbox(
    ctx: unknown,
    sandboxId: string,
    cmd: readonly string[],
    opts?: ExecSandboxOpts,
  ): Promise<ExecOutcome> {
    let context: ReturnType<typeof parseAgentContext>;
    try {
      context = parseAgentContext(ctx);
    } catch {
      return this.execDenied(ctx, "invalid agent context (fail-closed)");
    }

    let id: ReturnType<typeof SandboxId.parse>;
    try {
      id = SandboxId.parse(sandboxId);
    } catch {
      return this.execDenied(ctx, "invalid sandbox id (fail-closed)");
    }

    const ref = this.refById.get(id);
    if (ref === undefined) {
      // Unknown id (mapping missing) => deny-by-default; issue NO ExecSandbox (never guess an id).
      return this.execDenied(ctx, "unknown sandbox (fail-closed)");
    }

    // Trust boundary: validate the (untrusted JS) command + options at runtime. A malformed shape is
    // DENIED before any RPC, never thrown across the boundary (a non-string-array cmd, a null/non-
    // string-valued env, a non-finite timeout/deadline/cap, an unknown extra option, etc.). The
    // validation is wrapped in try/catch because zod `safeParse` does NOT catch exceptions thrown by
    // a hostile object's property getter / Proxy trap during access — any such throw fails closed.
    // Preflight (before zod) to avoid iterating a hostile huge/sparse array: a non-array or an argv
    // longer than the cap is denied without zod spreading the whole array.
    if (!Array.isArray(cmd) || cmd.length === 0 || cmd.length > MAX_ARGV_COUNT) {
      return this.execDenied(ctx, "invalid exec command (fail-closed)");
    }
    // `opts` is an optional param: null/undefined => no options (default caps apply). A non-object
    // (e.g. a primitive) fails the object schema below and is denied.
    const rawOpts = opts == null ? {} : opts;
    let parsedCmd: ReturnType<typeof ExecCommand.safeParse>;
    let parsedOptsResult: ReturnType<typeof ExecOptsSchema.safeParse>;
    try {
      parsedCmd = ExecCommand.safeParse(cmd);
      parsedOptsResult = ExecOptsSchema.safeParse(rawOpts);
    } catch {
      return this.execDenied(ctx, "invalid exec input (fail-closed)");
    }
    if (!parsedCmd.success) {
      return this.execDenied(ctx, "invalid exec command (fail-closed)");
    }
    if (!parsedOptsResult.success) {
      return this.execDenied(ctx, "invalid exec options (fail-closed)");
    }
    const o = parsedOptsResult.data;

    // Credentials never enter exec env in the clear (design §2.3): an env value carrying a reserved
    // credential marker that is NOT a clean `openshell:resolve:env:` placeholder is denied BEFORE any
    // RPC, so a smuggled raw credential can never be dispatched into the sandbox.
    const env = o.env;
    if (env !== undefined) {
      for (const value of Object.values(env)) {
        if (!isExecEnvValueAllowed(value)) {
          return this.execDenied(
            ctx,
            "exec env value carries a raw credential marker (fail-closed)",
          );
        }
      }
    }

    // ExecSandbox keys on the gateway-assigned stable `id` (proto:647), DISTINCT from the name.
    if (ref.id.length === 0) {
      return this.execDenied(ctx, "no openshell sandbox id to exec (fail-closed)");
    }

    const exec = (this.transport as Partial<OpenShellExecTransport>).execSandbox?.bind(
      this.transport,
    );
    if (exec === undefined) {
      return this.execDenied(ctx, "openshell transport cannot exec (fail-closed)");
    }

    const req: ExecSandboxRequest = {
      sandboxId: ref.id,
      command: parsedCmd.data,
      ...(o.workdir !== undefined ? { workdir: o.workdir } : {}),
      ...(env !== undefined ? { environment: env } : {}),
      ...(o.timeoutSeconds !== undefined ? { timeoutSeconds: o.timeoutSeconds } : {}),
      ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
    };

    const deadlineMs = o.deadlineMs ?? DEFAULT_EXEC_DEADLINE_MS;
    const maxOutputBytes = o.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    return this.streamExec(context, ctx, id, exec, req, deadlineMs, maxOutputBytes);
  }

  /**
   * Consume the `ExecSandbox` server-stream until the terminal `ExecSandboxExit` or the deadline.
   * Accumulates stdout/stderr chunks in arrival order; converges to `ok` ONLY on an observed exit
   * event (any exit code, including non-zero). Fail-closed on EVERYTHING that is not an observed exit:
   * a synchronous throw, a mid-stream iterator throw, a stream that ends before exit, a total output
   * size that would exceed `maxOutputBytes`, OR deadline expiry all resolve `denied`.
   *
   * The deadline is enforced with a race so a never-settling stream can never hang the caller. An
   * `AbortController` is wired to the transport (design §3.4 `AbortController` budget) and aborted when
   * the deadline wins OR the cap overflows, so a transport that honours the signal tears the gRPC
   * stream down; `iterator.return()` is the best-effort fallback for transports that do not.
   */
  private async streamExec(
    context: ReturnType<typeof parseAgentContext>,
    ctx: unknown,
    id: ReturnType<typeof SandboxId.parse>,
    exec: OpenShellExecTransport["execSandbox"],
    req: ExecSandboxRequest,
    deadlineMs: number,
    maxOutputBytes: number,
  ): Promise<ExecOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let iterator: AsyncIterator<ExecSandboxEvent> | undefined;
    const abort = new AbortController();
    const deadline = new Promise<ExecOutcome>((resolve) => {
      timer = setTimeout(() => {
        // Cancel the underlying stream first so a real transport stops producing, then fail closed.
        abort.abort();
        resolve(this.execDenied(ctx, "exec deadline exceeded before exit (fail-closed)"));
      }, deadlineMs);
    });

    const consume = (async (): Promise<ExecOutcome> => {
      const stdout: Uint8Array[] = [];
      const stderr: Uint8Array[] = [];
      let buffered = 0;
      try {
        const stream = exec(req, abort.signal);
        iterator = stream[Symbol.asyncIterator]();
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) break; // stream closed before a terminal exit => fail-closed.

          // Validate the `oneof payload` shape at runtime (untrusted wire frame): EXACTLY one variant
          // must be present. A frame mixing variants (e.g. `exit` + bytes), or with none, is garbled
          // and fails closed — it is never accepted as a (possibly truncated) success.
          const ev = next.value;
          const present =
            (ev.stdout !== undefined ? 1 : 0) +
            (ev.stderr !== undefined ? 1 : 0) +
            (ev.exit !== undefined ? 1 : 0);
          if (present !== 1) {
            abort.abort();
            return this.execDenied(ctx, "malformed exec event oneof (fail-closed)");
          }

          if (ev.exit !== undefined) {
            // Terminal: converge. A missing / non-integer exit_code is fail-closed (no fabricated 0).
            const code = ev.exit.exitCode;
            if (typeof code !== "number" || !Number.isInteger(code)) {
              return this.execDenied(ctx, "exec exit event missing exit_code (fail-closed)");
            }
            return {
              status: "ok",
              result: {
                exitCode: code,
                stdout: concatChunks(stdout),
                stderr: concatChunks(stderr),
              },
              event: this.execEvent(context, id),
            };
          }

          // stdout or stderr chunk: the data field MUST be a Uint8Array (a garbled frame fails closed).
          const chunk = ev.stdout?.data ?? ev.stderr?.data;
          if (!(chunk instanceof Uint8Array)) {
            abort.abort();
            return this.execDenied(ctx, "malformed exec chunk (fail-closed)");
          }
          // Resource bound: deny (never OOM, never return a truncated success) once the total buffered
          // stdout+stderr would exceed the cap. Abort so the transport stops producing.
          buffered += chunk.length;
          if (buffered > maxOutputBytes) {
            abort.abort();
            return this.execDenied(ctx, "exec output exceeded max bytes (fail-closed)");
          }
          if (ev.stdout !== undefined) stdout.push(chunk);
          else stderr.push(chunk);
        }
        return this.execDenied(ctx, "exec stream ended before exit event (fail-closed)");
      } catch {
        // Synchronous throw from exec OR a mid-stream iterator throw (RST_STREAM / decode). NEVER
        // surface the error (it may carry baseUrl / endpoint). Fail closed.
        return this.execDenied(ctx, "exec stream error before exit (fail-closed)");
      }
    })();

    try {
      return await Promise.race([consume, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Cancel the underlying stream on EVERY exit path (real cancellation for transports that honour
      // the signal; `iterator.return()` is the best-effort fallback to avoid a leaked iterator).
      abort.abort();
      if (iterator?.return !== undefined) {
        void iterator.return().catch(() => {});
      }
    }
  }

  /** Build a denied {@link ExecOutcome} reusing the shared substrate deny() event (fail-closed). */
  private execDenied(ctx: unknown, reason: string): ExecOutcome {
    return { status: "denied", reason, event: deny(ctx, "start", reason).event };
  }

  /** Build the auditable ok event for an exec (reuses the "start" lifecycle; P2-A enum unchanged). */
  private execEvent(
    context: ReturnType<typeof parseAgentContext>,
    id: ReturnType<typeof SandboxId.parse>,
  ): SandboxLifecycleEvent {
    return ok(context, "start", id).event;
  }

  /**
   * Fetch the sandbox's provider-env PLACEHOLDERS (slice S5; design §2.3) — NOT one of the four frozen
   * `SandboxAdapter` port methods (the P2-A shape is unchanged); it is an adapter-internal capability
   * consumed by S6 / the layer above so an injection point knows which credential slots exist. It NEVER
   * resolves a placeholder into a real value (that is OpenShell's SecretResolver at egress) and NEVER
   * persists a raw value.
   *
   * Flow: (1) validate ctx + resolve the mapped OpenShell name — bad ctx / unknown id => deny BEFORE
   * any RPC; (2) the provider-env primitive is an optional transport capability — a transport without
   * it fails CLOSED (deny), not silently treated as empty; (3) call `GetSandboxProviderEnvironment`,
   * then run the returned `environment` through the fail-closed placeholder-only shape guard
   * ({@link assertPlaceholderOnly}). The guard THROWS on ANY value that is not a well-formed
   * placeholder (e.g. a raw secret the backend tried to leak) — that throw is caught and mapped to a
   * `denied` outcome that carries NO env at all (the raw value is never carried, logged, or surfaced).
   * EVERY non-happy path — bad ctx, unknown id, an RPC rejection, OR a suspicious value — fails CLOSED
   * to `denied`; the adapter NEVER throws across the boundary nor leaks transport / credential detail
   * into the reason.
   */
  async getProviderEnvironment(ctx: unknown, sandboxId: string): Promise<ProviderEnvOutcome> {
    let context: ReturnType<typeof parseAgentContext>;
    try {
      context = parseAgentContext(ctx);
    } catch {
      return this.providerEnvDenied(ctx, "invalid agent context (fail-closed)");
    }

    let id: ReturnType<typeof SandboxId.parse>;
    try {
      id = SandboxId.parse(sandboxId);
    } catch {
      return this.providerEnvDenied(ctx, "invalid sandbox id (fail-closed)");
    }

    const ref = this.refById.get(id);
    if (ref === undefined) {
      // Unknown id (mapping missing) => deny-by-default; issue NO RPC (never guess a name).
      return this.providerEnvDenied(ctx, "unknown sandbox (fail-closed)");
    }

    // The provider-env primitive is an optional capability of the injected transport. A transport that
    // cannot fetch it is fail-closed (deny) rather than silently treated as an empty env.
    const transport = this.transport as Partial<OpenShellProviderEnvTransport>;
    const getProviderEnv = transport.getSandboxProviderEnvironment?.bind(transport);
    if (getProviderEnv === undefined) {
      return this.providerEnvDenied(
        ctx,
        "openshell transport cannot fetch provider env (fail-closed)",
      );
    }

    let env: Record<string, string>;
    let revision: string;
    try {
      // GetSandboxProviderEnvironment keys on the canonical `name` (server: get_message_by_name).
      const resp = await getProviderEnv({ name: ref.name });
      // FAIL-CLOSED shape guard: throws on ANY non-placeholder value (a raw secret never gets carried).
      env = assertPlaceholderOnly(resp.environment ?? {});
      // revision is a non-secret counter (uint64 -> bigint|number on the wire); carry it as a decimal
      // string. An absent value defaults to "0" (revision 0); a negative number is fail-closed.
      const rev = resp.providerEnvRevision ?? 0;
      if (typeof rev === "number" && (!Number.isInteger(rev) || rev < 0)) {
        return this.providerEnvDenied(
          ctx,
          "openshell returned a malformed provider-env revision (fail-closed)",
        );
      }
      if (typeof rev === "bigint" && rev < 0n) {
        return this.providerEnvDenied(
          ctx,
          "openshell returned a malformed provider-env revision (fail-closed)",
        );
      }
      revision = rev.toString();
    } catch {
      // Either the transport rejected (refused / deadline / decode) OR the placeholder guard threw on a
      // suspicious value. BOTH fail CLOSED: deny, carry NO env, and NEVER surface the underlying error
      // (it could carry baseUrl / endpoint / a raw credential).
      return this.providerEnvDenied(
        ctx,
        "openshell provider-env unavailable or not placeholder-only (fail-closed)",
      );
    }

    return { status: "ok", env, revision, event: this.execEvent(context, id) };
  }

  /** Build a denied {@link ProviderEnvOutcome} reusing the shared substrate deny() event (no env carried). */
  private providerEnvDenied(ctx: unknown, reason: string): ProviderEnvOutcome {
    return { status: "denied", reason, event: deny(ctx, "start", reason).event };
  }

  /**
   * start/stop are an HONEST noop shim (slice S6; design §3.2): OpenShell has NO Start/Stop RPC
   * (the `service OpenShell` block has no StartSandbox/StopSandbox — only Create/Get/List/Delete/
   * Exec/Watch/…), so a create'd sandbox is already running. Rather than let the port "lie" (claim a
   * success that maps to nothing, or pretend to call an RPC), this shim:
   *   - issues NO RPC at all (a noop is a noop — it never touches the transport);
   *   - returns `ok` ONLY for a KNOWN id (one with a live mapping), with an event reason that names
   *     the shim so the lifecycle event stays auditable and truthful;
   *   - fails CLOSED (`deny`) for a bad AgentContext, a malformed id, OR an unknown id (no mapping) —
   *     it never fabricates a phantom success for a sandbox we did not create.
   */
  startSandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult> {
    return Promise.resolve(this.noopShim(ctx, "start", sandboxId));
  }

  stopSandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult> {
    return Promise.resolve(this.noopShim(ctx, "stop", sandboxId));
  }

  /** Shared body for the start/stop noop shim (issues NO RPC; fail-closed on unknown/invalid id). */
  private noopShim(ctx: unknown, lifecycle: "start" | "stop", sandboxId: string): AdapterResult {
    const shimReason = `${lifecycle} is a noop shim (OpenShell has no Start/Stop RPC)`;
    let context: ReturnType<typeof parseAgentContext>;
    try {
      context = parseAgentContext(ctx);
    } catch {
      return deny(ctx, lifecycle, "invalid agent context (fail-closed)");
    }

    let id: ReturnType<typeof SandboxId.parse>;
    try {
      id = SandboxId.parse(sandboxId);
    } catch {
      return deny(ctx, lifecycle, "invalid sandbox id (fail-closed)");
    }

    if (!this.refById.has(id)) {
      // Unknown id (mapping missing) => deny-by-default; a noop shim never invents a success.
      return deny(ctx, lifecycle, "unknown sandbox (fail-closed)");
    }

    // Known sandbox: succeed WITHOUT any RPC, but mark the event so the success is honestly a shim.
    return {
      status: "ok",
      sandboxId: id,
      event: { lifecycle, result: "ok", context, sandboxId: id, reason: shimReason },
    };
  }
}
