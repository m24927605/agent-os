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

// PINNED BY DIGEST — accept a bare `sha256:<64hex>` content digest OR a full OCI reference pinned with
// `@sha256:<64hex>` (e.g. ghcr.io/org/img@sha256:…). The gateway's SandboxTemplate.image needs the full
// registry reference to pull the image; a bare digest alone is unresolvable there. Both forms are
// immutable; a mutable tag (`:latest`, `:1.2.3`) has no trailing `@sha256:` and is rejected
// (deny-by-default supply-chain pin). The `@sha256:` must be the LAST element so `repo:tag@sha256:…`
// is still accepted (the digest, not the tag, is what's pulled).
const SHA256_DIGEST_RE = /(?:^|@)sha256:[0-9a-f]{64}$/;

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

// --- S2 sandbox-lifecycle wire shapes (TS face of the pinned proto subset) --------------------------
//
// These mirror the upstream `openshell.v1` messages we consume in S2 (CreateSandbox / DeleteSandbox).
// They are intentionally PARTIAL: only the fields S2 reads/writes are typed (no policy, no env, no
// status). The adapter treats every field defensively (an absent `metadata.name` is fail-closed),
// so a backend that sends more (or less) cannot break the deny-by-default contract.

/** `SandboxTemplate` subset — the pinned boot image lives here (openshell.proto:333-335). */
export interface OpenShellSandboxTemplate {
  /** Fully-qualified OCI image reference — MUST be a pinned `sha256:` digest (design §5). */
  readonly image: string;
}

/** `SandboxSpec` subset — only `template.image` and `labels` are set by S2. */
export interface OpenShellSandboxSpec {
  readonly template: OpenShellSandboxTemplate;
}

/** `CreateSandboxRequest` subset (openshell.proto:427-433). */
export interface CreateSandboxRequest {
  readonly spec: OpenShellSandboxSpec;
  /** Optional caller-supplied name; empty => the gateway generates one. */
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

/** `ObjectMeta` subset — the gateway-assigned `name` is the canonical lookup key (datamodel.proto:12). */
export interface OpenShellObjectMeta {
  readonly name?: string;
  readonly id?: string;
}

/** `Sandbox` subset (openshell.proto:296-306). `status` is read by S3 readiness; absent => not ready. */
export interface OpenShellSandbox {
  readonly metadata?: OpenShellObjectMeta;
  readonly status?: OpenShellSandboxStatus;
}

/** `SandboxResponse` (openshell.proto:488-490). */
export interface SandboxResponse {
  readonly sandbox?: OpenShellSandbox;
}

/** `DeleteSandboxRequest` (openshell.proto:482-485) — keyed by the canonical sandbox `name`. */
export interface DeleteSandboxRequest {
  readonly name: string;
}

/** `DeleteSandboxResponse` (openshell.proto:517-519). */
export interface DeleteSandboxResponse {
  readonly deleted?: boolean;
}

// --- S3 readiness wire shapes (TS face of the pinned proto subset) ----------------------------------
//
// These mirror the upstream `openshell.v1` messages S3 consumes for readiness (GetSandbox unary +
// WatchSandbox server-stream). Like the S2 shapes they are intentionally PARTIAL: only `status.phase`
// is typed (no conditions / policy version / log lines / platform events). The adapter treats every
// field defensively — an absent status, an absent phase, OR an unknown enum value is fail-closed
// (NEVER READY) — so a backend that sends more (or less) cannot break deny-by-default.

/**
 * `SandboxPhase` — the gateway-derived lifecycle summary clients use for readiness (openshell.proto:401-408).
 * Numeric values match the upstream proto EXACTLY so wire decoding stays faithful. Only READY/ERROR are
 * terminal for readiness; every other value (including UNSPECIFIED/UNKNOWN and any unknown enum number)
 * is treated as not-yet-ready / fail-closed.
 */
export enum SandboxPhase {
  SANDBOX_PHASE_UNSPECIFIED = 0,
  SANDBOX_PHASE_PROVISIONING = 1,
  SANDBOX_PHASE_READY = 2,
  SANDBOX_PHASE_ERROR = 3,
  SANDBOX_PHASE_DELETING = 4,
  SANDBOX_PHASE_UNKNOWN = 5,
}

/** `SandboxStatus` subset — only `phase` is read for readiness (openshell.proto:366-380). */
export interface OpenShellSandboxStatus {
  /** May be any number on the wire; the adapter maps unknown values to NOT-ready (deny-by-default). */
  readonly phase?: number;
}

/** `GetSandboxRequest` (openshell.proto:436-439) — keyed by the canonical sandbox `name`. */
export interface GetSandboxRequest {
  readonly name: string;
}

/**
 * `WatchSandboxRequest` subset (openshell.proto:761-792). S3 sets only the readiness-relevant fields:
 * the lookup key, `follow_status`, and `stop_on_terminal` (so the gateway closes the stream on a
 * terminal READY/ERROR phase). Log/event following is OUT OF SCOPE (spec §3).
 */
export interface WatchSandboxRequest {
  /** Sandbox lookup key (the mapped OpenShell canonical name/id). */
  readonly id: string;
  readonly followStatus?: boolean;
  readonly stopOnTerminal?: boolean;
}

/**
 * `SandboxStreamEvent` subset (openshell.proto:795-810). The upstream `oneof payload` may carry a
 * snapshot, a log line, a platform event, a warning, or a draft-policy update; S3 reads ONLY the
 * `sandbox` snapshot and ignores every other variant (an event with no `sandbox` carries no readiness
 * signal and is skipped — never treated as READY).
 */
export interface SandboxStreamEvent {
  readonly sandbox?: OpenShellSandboxReadinessSnapshot;
}

/** `Sandbox` readiness subset — only `status.phase` is consumed by S3. */
export interface OpenShellSandboxReadinessSnapshot {
  readonly status?: OpenShellSandboxStatus;
}

/**
 * Transport seam extended with the S2 unary sandbox-lifecycle primitives. The adapter consumes ONLY
 * this interface (vendor-neutral seam); the production wiring builds the connect-node-backed
 * implementation, while tests inject an in-process double. Every primitive carries the client
 * deadline internally; a rejected promise is the adapter's signal to fail CLOSED (deny), never throw.
 */
export interface OpenShellLifecycleTransport extends OpenShellTransport {
  createSandbox(req: CreateSandboxRequest): Promise<SandboxResponse>;
  deleteSandbox(req: DeleteSandboxRequest): Promise<DeleteSandboxResponse>;
}

/**
 * Transport seam extended with the S3 readiness primitives: a one-shot `getSandbox` unary and a
 * `watchSandbox` server-stream. The adapter consumes ONLY this vendor-neutral seam; production wires
 * the connect-node-backed implementation while tests inject an in-process double.
 *
 * Fail-closed signalling: `getSandbox` rejects on RPC failure; `watchSandbox` may throw synchronously
 * (transport refused) OR its async iterator may throw mid-stream (RST_STREAM / deadline) — BOTH are
 * the adapter's signal to fail CLOSED (not-ready / deny), never throw across the port boundary.
 */
export interface OpenShellReadinessTransport extends OpenShellLifecycleTransport {
  getSandbox(req: GetSandboxRequest): Promise<SandboxResponse>;
  watchSandbox(req: WatchSandboxRequest): AsyncIterable<SandboxStreamEvent>;
}

// --- S4 exec wire shapes (TS face of the pinned proto subset) ---------------------------------------
//
// These mirror the upstream `openshell.v1` ExecSandbox messages S4 consumes (openshell.proto:645-696).
// Like the S2/S3 shapes they are intentionally PARTIAL: only the fields S4 writes/reads are typed. The
// interactive/tty fields (tty/cols/rows; ExecSandboxInteractive) are OUT OF SCOPE (spec §3, design §6)
// and deliberately absent. The adapter treats every field defensively — an exec stream that closes
// before the terminal ExecSandboxExit is fail-closed (NEVER a fabricated exit 0).

/**
 * `ExecSandboxRequest` subset (openshell.proto:645-672). S4 writes `sandbox_id` (the gateway-assigned
 * stable id, NOT the human-readable name), `command`, and the optional `workdir` / `environment` /
 * `timeout_seconds` / `stdin`. The tty fields (proto:665-671) are out of scope and never set.
 */
export interface ExecSandboxRequest {
  /** Gateway-assigned stable sandbox id (proto:647) — the exec lookup key. */
  readonly sandboxId: string;
  /** Command + arguments (proto:650). */
  readonly command: readonly string[];
  /** Optional working directory (proto:653). */
  readonly workdir?: string;
  /** Optional environment overrides (proto:656). Placeholder-only — raw credentials are denied. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Optional timeout in seconds; 0 = no timeout (proto:659). */
  readonly timeoutSeconds?: number;
  /** Optional stdin payload (proto:662). */
  readonly stdin?: Uint8Array;
}

/** `ExecSandboxStdout` (openshell.proto:675-677). */
export interface ExecSandboxStdout {
  readonly data?: Uint8Array;
}

/** `ExecSandboxStderr` (openshell.proto:680-682). */
export interface ExecSandboxStderr {
  readonly data?: Uint8Array;
}

/** `ExecSandboxExit` (openshell.proto:685-687) — the terminal event carrying the command exit code. */
export interface ExecSandboxExit {
  readonly exitCode?: number;
}

/**
 * `ExecSandboxEvent` (openshell.proto:690-696) — one frame of the exec server-stream. Exactly one of
 * the `oneof payload` variants is set on the wire; the adapter validates this at runtime and fails
 * CLOSED (deny + abort) on any frame that violates it — none set, more than one set, a non-`Uint8Array`
 * data field, or a non-integer exit code. A garbled frame is NEVER treated as a (possibly truncated)
 * success.
 */
export interface ExecSandboxEvent {
  readonly stdout?: ExecSandboxStdout;
  readonly stderr?: ExecSandboxStderr;
  readonly exit?: ExecSandboxExit;
}

/**
 * Transport seam extended with the S4 exec primitive: `execSandbox` returns a server-stream of
 * `ExecSandboxEvent`. The adapter consumes ONLY this vendor-neutral seam; the production connect-node
 * client (the real `ExecSandbox` descriptor) is wired by S6 / the opt-in e2e, while tests inject an
 * in-process double — mirroring how S2/S3's lifecycle/readiness primitives are exercised offline.
 *
 * It extends `OpenShellLifecycleTransport` (NOT the S3 readiness seam): S4 depends only on S2's
 * create/destroy + name<->id mapping (slice DAG: S4 -> {S2}), so exec must not force a dependency on
 * S3's get/watch primitives.
 *
 * Cancellation: an optional `AbortSignal` lets the adapter cancel the underlying stream when its
 * deadline fires (design §3.4 `AbortController` budget); a transport that honours it tears the gRPC
 * stream down rather than leaking it. The double ignores it (it has no real socket).
 *
 * Fail-closed signalling: `execSandbox` may throw synchronously (transport refused) OR its async
 * iterator may throw mid-stream (RST_STREAM / deadline) OR the stream may close WITHOUT a terminal
 * `ExecSandboxExit` — ALL are the adapter's signal to fail CLOSED (deny), never throw across the port
 * boundary and never fabricate a success exit code.
 */
export interface OpenShellExecTransport extends OpenShellLifecycleTransport {
  execSandbox(req: ExecSandboxRequest, signal?: AbortSignal): AsyncIterable<ExecSandboxEvent>;
}

// --- S5 provider-env wire shapes (TS face of the pinned proto subset) -------------------------------
//
// These mirror the upstream `openshell.v1` GetSandboxProviderEnvironment messages S5 consumes
// (openshell.proto:153 RPC; response at proto:1141-1152). Like S2/S3/S4 they are intentionally
// PARTIAL: only `environment` + `provider_env_revision` are typed. `credential_expires_at_ms`
// (proto:1147) and `dynamic_credentials` (proto:1151) are OUT OF SCOPE (spec §3 — left to R4
// CredentialLease) and deliberately absent. The adapter treats `environment` defensively: every value
// MUST pass the placeholder-only shape guard (provider-env.ts) before it is carried — a raw value is
// fail-closed (denied, never persisted), because OpenShell's SecretResolver places ONLY placeholders
// here (design §2.3, INFERRED) and a raw value would mean the backend misbehaved.

/** `GetSandboxProviderEnvironmentRequest` subset — keyed by the canonical sandbox `name`. */
export interface GetSandboxProviderEnvironmentRequest {
  readonly name: string;
}

/**
 * `GetSandboxProviderEnvironmentResponse` subset (openshell.proto:1141-1152). `environment` carries
 * placeholder-bearing values ONLY (design §2.3); `providerEnvRevision` is a `uint64` (decoded as a
 * `bigint` by the connect-node runtime) — a non-secret counter the adapter passes through as a
 * decimal string. `credential_expires_at_ms` / `dynamic_credentials` are out of scope and not typed.
 */
export interface GetSandboxProviderEnvironmentResponse {
  readonly environment?: Readonly<Record<string, string>>;
  readonly providerEnvRevision?: bigint | number;
}

/**
 * Transport seam extended with the S5 provider-env primitive: a one-shot `getSandboxProviderEnvironment`
 * unary. The adapter consumes ONLY this vendor-neutral seam; production wires the connect-node-backed
 * implementation (the real `GetSandboxProviderEnvironment` descriptor, by S6 / the opt-in e2e) while
 * tests inject an in-process double — mirroring how S2..S4 are exercised offline.
 *
 * It extends `OpenShellLifecycleTransport` (NOT the S3/S4 seams): S5 depends only on S1's client +
 * S2's name<->id mapping (slice DAG: S5 -> {S1}), so provider-env must not force a dependency on
 * readiness/exec primitives.
 *
 * Fail-closed signalling: `getSandboxProviderEnvironment` rejects on RPC failure (refused / deadline /
 * decode) — the adapter's signal to fail CLOSED (deny), never throw across the port boundary nor leak
 * baseUrl / endpoint into a reason.
 */
export interface OpenShellProviderEnvTransport extends OpenShellLifecycleTransport {
  getSandboxProviderEnvironment(
    req: GetSandboxProviderEnvironmentRequest,
  ): Promise<GetSandboxProviderEnvironmentResponse>;
}

/**
 * Reserved credential markers (secrets.rs:9-10): the placeholder prefix `openshell:resolve:env:` and
 * the alias marker `OPENSHELL-RESOLVE-ENV-`. OpenShell's `SecretResolver` rewrites provider-env raw
 * values into `openshell:resolve:env:<KEY>` (rev 0) / `openshell:resolve:env:v<rev>_<KEY>` (rev != 0)
 * placeholders BEFORE they reach a child env, and resolves them only at egress. R1 only ever carries
 * placeholder-shaped values; it must NEVER smuggle a raw credential reference into exec env.
 */
const PLACEHOLDER_PREFIX = "openshell:resolve:env:";
const PROVIDER_ALIAS_MARKER = "OPENSHELL-RESOLVE-ENV-";

/**
 * The EXACT placeholder grammar OpenShell's `SecretResolver` emits
 * (`placeholder_for_env_key_for_revision`, secrets.rs:487-493):
 *   - revision 0   => `openshell:resolve:env:<KEY>`        (no `v0_`)
 *   - revision N>0 => `openshell:resolve:env:v<N>_<KEY>`
 * where `<KEY>` is an env-var name `[A-Za-z0-9_]+` and `<N>` is a positive integer (no leading zero).
 * Anchored `^…$` so a marker embedded mid-string (e.g. `prefix-openshell:resolve:env:...`) is NOT a
 * placeholder and is rejected.
 */
const PLACEHOLDER_RE = /^openshell:resolve:env:(v[1-9][0-9]*_)?[A-Za-z0-9_]+$/;

/**
 * Fail-closed guard for a single exec env value (design §2.3, spec §3 / §5). An env value is REJECTED
 * (returns `false`) iff it carries a reserved credential marker yet is NOT a well-formed placeholder.
 * A value that matches the EXACT SecretResolver placeholder grammar ({@link PLACEHOLDER_RE}) is the
 * ONLY accepted credential-bearing form (so a legitimate revision-0 `openshell:resolve:env:<KEY>` is
 * not over-rejected). A plain literal carrying NO reserved marker at all is accepted. Anything else
 * that contains a reserved marker — the alias form `OPENSHELL-RESOLVE-ENV-…`, an empty/garbled
 * placeholder, or the prefix embedded mid-string — is denied. This keeps credentials from ever
 * entering exec env in the clear while not breaking the happy path for legitimate placeholders.
 */
export function isExecEnvValueAllowed(value: string): boolean {
  const hasMarker = value.includes(PLACEHOLDER_PREFIX) || value.includes(PROVIDER_ALIAS_MARKER);
  if (!hasMarker) return true; // plain literal, no reserved marker.
  // A reserved marker is present: accept ONLY a value that is itself a well-formed placeholder.
  return PLACEHOLDER_RE.test(value);
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
