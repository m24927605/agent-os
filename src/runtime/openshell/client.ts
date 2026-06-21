/**
 * connect-node OpenShell gRPC client — slice P2R-R1-S1 (integration Strategy B: no fork).
 *
 * This is the SINGLE module that names the OpenShell RPC vendor (`@connectrpc/connect{,-node}`). It
 * lives under src/runtime/openshell/ (NOT a core governance module), so `no-vendor-in-core`
 * (.dependency-cruiser.cjs) stays intact: core consumes only the injected `OpenShellTransport` port.
 *
 * Responsibility (and ONLY this): hold an OpenShell connection contract and expose
 *   - an injectable `OpenShellTransport` seam (shared by later slices + test doubles),
 *   - a fail-closed `health()` that wraps the pinned `Health` RPC (openshell.proto:22), and
 *   - the pinned sandbox image digest + its deny-by-default assertion.
 * It contains NO sandbox lifecycle semantics (Create/Get/Exec/Watch/Delete → S2..S5).
 *
 * FAIL-CLOSED INVARIANT: `health()` NEVER throws across the boundary and NEVER leaks `baseUrl`. Any
 * transport error, a non-HEALTHY status, OR a `deadlineMs` expiry resolves `{ ok: false }`. There is
 * no live OpenShell server in CI: tests inject a transport double; the real connect-node transport
 * (built from `baseUrl`) is constructed lazily and only exercised by the S6 opt-in e2e.
 */
import { type DescService, create, createFileRegistry } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ServiceStatus } from "./proto/openshell.subset.js";

/**
 * PINNED sandbox boot image — a `sha256:` content digest, NEVER a floating tag (design §5). It is
 * injected at `CreateSandboxRequest.spec.template.image` by S2; a caller may not override it with an
 * unpinned tag (fail-closed via {@link assertPinnedImageDigest}).
 *
 * Placeholder digest (all-zero sha256) until the real OpenShell boot image is pinned in S2 — its
 * SHAPE (sha256:<64 hex>) is what this slice locks; the exact value is set when S2 wires CreateSandbox.
 */
export const PINNED_SANDBOX_IMAGE =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000";

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Assert that `image` is a pinned `sha256:` digest (deny-by-default). A floating tag, an empty
 * string, or a malformed digest THROWS — so S2 cannot accidentally boot an unpinned image. This is a
 * pre-RPC guard (it runs in-process before any sandbox is created), so throwing is correct here; the
 * cross-boundary fail-closed path is `health()` / the S2 adapter's `deny()`.
 */
export function assertPinnedImageDigest(image: string): void {
  if (!SHA256_DIGEST_RE.test(image)) {
    throw new Error("openshell: image must be a pinned sha256 digest (deny-by-default)");
  }
}

/**
 * Vendor-neutral transport seam shared by later slices and test doubles. S1 needs only `health()`;
 * S2..S5 extend this with the sandbox-lifecycle call primitives.
 */
export interface OpenShellTransport {
  /** Resolves `{ ok: true }` iff the gateway reports a HEALTHY status; fail-closed otherwise. */
  health(): Promise<{ ok: boolean }>;
}

export interface OpenShellClientOpts {
  /** OpenShell gateway endpoint (e.g. `https://gateway:443`). Treated as sensitive: never logged. */
  readonly baseUrl: string;
  /** Per-call deadline; on expiry `health()` resolves `{ ok: false }` (fail-closed). */
  readonly deadlineMs: number;
  /**
   * Injected transport. Production omits it and a connect-node gRPC transport is built lazily from
   * `baseUrl` (network-free under test). Tests inject an in-process double. Mirrors the ingest seam.
   */
  readonly transport?: OpenShellTransport;
}

/**
 * Build an `OpenShellTransport`. The returned `health()` is fail-closed: it wraps the underlying
 * transport's `health()` in a deadline race and a catch-all, so a thrown error, a rejected promise,
 * OR a never-settling call ALL resolve `{ ok: false }` — never a throw, never a `baseUrl` leak.
 */
export function createOpenShellClient(opts: OpenShellClientOpts): OpenShellTransport {
  // Build the real connect-node transport lazily ONLY when none is injected (keeps tests offline).
  const inner = opts.transport ?? createGrpcOpenShellTransport(opts.baseUrl, opts.deadlineMs);
  const deadlineMs = opts.deadlineMs;

  return {
    health(): Promise<{ ok: boolean }> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<{ ok: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), deadlineMs);
      });
      const call = Promise.resolve()
        .then(() => inner.health())
        // Deny-by-default: ANY rejection becomes a fail-closed `{ ok: false }`. The error is
        // intentionally NOT logged here — it could carry `baseUrl` / endpoint detail.
        .catch(() => ({ ok: false }) as { ok: boolean });

      return Promise.race([call, deadline]).then((result) => {
        if (timer !== undefined) clearTimeout(timer);
        // Normalize: only an explicit `{ ok: true }` passes; any other shape is fail-closed.
        return { ok: result.ok === true };
      });
    },
  };
}

// --- production connect-node transport (lazy; exercised only by the S6 opt-in e2e) ------------------

/** Runtime-built `Health` service descriptor for the pinned `openshell.v1` subset (no codegen step). */
function healthServiceDesc(): DescService {
  const fileProto = create(FileDescriptorProtoSchema, {
    name: "openshell.subset.proto",
    package: "openshell.v1",
    syntax: "proto3",
    messageType: [
      { name: "HealthRequest" },
      {
        name: "HealthResponse",
        field: [
          {
            name: "status",
            number: 1,
            type: 14, // TYPE_ENUM
            label: 1, // LABEL_OPTIONAL
            typeName: ".openshell.v1.ServiceStatus",
            jsonName: "status",
          },
          { name: "version", number: 2, type: 9, label: 1, jsonName: "version" }, // TYPE_STRING
        ],
      },
    ],
    enumType: [
      {
        name: "ServiceStatus",
        value: [
          { name: "SERVICE_STATUS_UNSPECIFIED", number: 0 },
          { name: "SERVICE_STATUS_HEALTHY", number: 1 },
          { name: "SERVICE_STATUS_DEGRADED", number: 2 },
          { name: "SERVICE_STATUS_UNHEALTHY", number: 3 },
        ],
      },
    ],
    service: [
      {
        name: "OpenShell",
        method: [
          {
            name: "Health",
            inputType: ".openshell.v1.HealthRequest",
            outputType: ".openshell.v1.HealthResponse",
          },
        ],
      },
    ],
  });
  const fileSet = create(FileDescriptorSetSchema, { file: [fileProto] });
  const registry = createFileRegistry(fileSet);
  const svc = registry.getService("openshell.v1.OpenShell");
  if (svc === undefined) {
    throw new Error("openshell: failed to build Health service descriptor (fail-closed)");
  }
  return svc;
}

/**
 * Build the connect-node-backed transport. A gRPC error (refused connection / DEADLINE_EXCEEDED /
 * malformed response) surfaces as a rejected promise, which {@link createOpenShellClient} catches
 * and maps to `{ ok: false }`. `ok:true` requires the gateway to report `SERVICE_STATUS_HEALTHY`.
 */
function createGrpcOpenShellTransport(baseUrl: string, deadlineMs: number): OpenShellTransport {
  const transport = createGrpcTransport({ baseUrl });
  const desc = healthServiceDesc();
  // The runtime descriptor types the method loosely; the connect client is shaped by `desc`.
  const client = createClient(desc, transport) as unknown as {
    health(req: Record<string, never>, opts: { timeoutMs: number }): Promise<{ status?: number }>;
  };
  return {
    async health(): Promise<{ ok: boolean }> {
      const resp = await client.health({}, { timeoutMs: deadlineMs });
      return { ok: resp.status === ServiceStatus.SERVICE_STATUS_HEALTHY };
    },
  };
}
