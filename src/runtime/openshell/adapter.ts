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
  PINNED_SANDBOX_IMAGE,
  assertPinnedImageDigest,
} from "./client.js";

export class OpenShellSandboxAdapter implements SandboxAdapter {
  /** In-memory mapping: our `SandboxId` -> OpenShell canonical sandbox `name`. Lost mapping => deny. */
  private readonly nameById = new Map<string, string>();

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

    let openshellName: string;
    try {
      const resp = await this.transport.createSandbox(req);
      const name = resp.sandbox?.metadata?.name;
      if (typeof name !== "string" || name.length === 0) {
        // Empty / malformed response: deny, retain no mapping (deny-by-default on garbled wire).
        return deny(ctx, "create", "openshell returned no sandbox name (fail-closed)");
      }
      openshellName = name;
    } catch {
      // Transport rejection (connection refused / deadline / decode): fail closed, NEVER throw, and
      // do NOT surface the underlying error (it could carry baseUrl / endpoint detail).
      return deny(ctx, "create", "openshell create rpc failed (fail-closed)");
    }

    const id = SandboxId.parse(`sbx-os-${randomUUID()}`);
    this.nameById.set(id, openshellName);
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

    const openshellName = this.nameById.get(id);
    if (openshellName === undefined) {
      // Unknown id (mapping missing) => deny-by-default; issue NO DeleteSandbox (never guess a name).
      return deny(ctx, "destroy", "unknown sandbox (fail-closed)");
    }

    try {
      await this.transport.deleteSandbox({ name: openshellName });
    } catch {
      // Delete failed: deny and KEEP the mapping so a forward-fix retry can still find the name.
      return deny(ctx, "destroy", "openshell delete rpc failed (fail-closed)");
    }

    this.nameById.delete(id);
    return ok(context, "destroy", id);
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
