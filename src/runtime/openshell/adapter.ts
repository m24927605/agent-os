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
import { SandboxId, parseAgentContext } from "../../iam/ids.js";
import {
  type AdapterResult,
  type SandboxAdapter,
  type SandboxSpec,
  deny,
  ok,
} from "../substrate/index.js";
import {
  type CreateSandboxRequest,
  type OpenShellLifecycleTransport,
  type OpenShellReadinessTransport,
  PINNED_SANDBOX_IMAGE,
  SandboxPhase,
  type SandboxStreamEvent,
  assertPinnedImageDigest,
} from "./client.js";

/** Options for {@link OpenShellSandboxAdapter.awaitReady}. */
export interface AwaitReadyOpts {
  /** Wall-clock budget for the whole readiness probe (GetSandbox + Watch). Expiry => deny (not ready). */
  readonly deadlineMs: number;
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

  // start/stop are an explicit S6 concern (OpenShell has no Start/Stop RPC; design §3.2). Until the
  // S6 noop-shim lands they fail CLOSED rather than claim a success the substrate cannot deliver.
  startSandbox(ctx: unknown, _sandboxId: string): Promise<AdapterResult> {
    return Promise.resolve(deny(ctx, "start", "start not implemented in this slice (S6)"));
  }

  stopSandbox(ctx: unknown, _sandboxId: string): Promise<AdapterResult> {
    return Promise.resolve(deny(ctx, "stop", "stop not implemented in this slice (S6)"));
  }
}
