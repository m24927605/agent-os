/**
 * AgentHosting port — the vendor-neutral contract for hosting the (untrusted) brain as a long-lived
 * process inside an execution substrate (one pluggable slot; default adapter NemoClaw, landing under
 * src/hosting/adapters/<vendor>/ later).
 *
 * NemoClaw's reference pattern (nohup + gosu launch, recovery scripts, health-probe loop,
 * ConnectSupervisor lifetime) is single-operator: it explicitly does NOT isolate tenants. That gap is
 * the Enterprise differentiation, so this port makes tenant isolation a first-class, verifiable
 * invariant: every lifecycle op is tenant-scoped — an agent hosted under tenant-A is invisible/untouchable
 * to tenant-B. The port is CREDENTIAL-BLIND: the host spec carries no secret (credentials are injected by
 * the OpenShell SecretResolver at egress, never here).
 *
 * Cohesion: the port + its in-tree adapters import only identity primitives (no egress, no vendor).
 */
import { type AgentContext, parseAgentContext } from "../iam/ids.js";

/**
 * Caller-facing deny reason for "no sandbox you may act on" — used for BOTH unknown-sandbox and
 * cross-tenant denials so a caller cannot tell them apart (closes the cross-tenant existence oracle).
 * The true reason (unknown vs cross-tenant) is kept only in the audit event.reason.
 */
export const UNKNOWN_SANDBOX = "unknown sandbox";

export type AgentPhase = "running" | "stopped" | "unknown";
export type HostingOperation = "host" | "status" | "reconcile";
export type ReconcileAction = "health-probe" | "restart";

/** Auditable hosting event (NOT yet appended to the evidence kernel). Carries no secret/credential. */
export interface AgentLifecycleEvent {
  readonly operation: HostingOperation;
  readonly result: "ok" | "denied";
  readonly context?: AgentContext;
  readonly contextError?: string;
  readonly sandboxId?: string;
  readonly reason?: string;
}

/** What to host. NO credential field — the brain stays credential-blind. */
export interface HostSpec {
  readonly sandboxId: string;
  readonly agentName: string;
  /** Optional launch command (e.g. the gateway entrypoint). Not a secret. */
  readonly gatewayCommand?: string;
  /** Optional inference route id (resolved to a backend by the substrate; not a key). */
  readonly inferenceProvider?: string;
  /**
   * Hosting lifecycle ownership. Default (absent) is treated as `"launch"` — fully backward-compatible.
   *
   * - `"launch"`: the adapter launches the gateway itself (exec the entrypoint, parse its PID) and
   *   owns its lifecycle, including restart-on-failure.
   * - `"observe"`: the SUBSTRATE / ENTRYPOINT launches the gateway (e.g. a root entrypoint dropping to
   *   a privileged `gateway` user — the real NemoClaw/Hermes shape per the Hermes live finding). The
   *   adapter does NOT exec-launch; it OBSERVES the gateway via the /health probe and health-reconciles
   *   it. A restart is fail-closed denied in observe mode (the lifecycle is owned by the substrate).
   */
  readonly mode?: "launch" | "observe";
}

export type HostResult =
  | { status: "ok"; agentProcessId: string; event: AgentLifecycleEvent }
  | { status: "denied"; reason: string; event: AgentLifecycleEvent };

export type StatusResult =
  | { status: "ok"; phase: AgentPhase; event: AgentLifecycleEvent }
  | { status: "denied"; reason: string; event: AgentLifecycleEvent };

export type ReconcileResult =
  | { status: "ok"; event: AgentLifecycleEvent }
  | { status: "denied"; reason: string; event: AgentLifecycleEvent };

export interface AgentHosting {
  hostAgent(ctx: unknown, spec: HostSpec): Promise<HostResult>;
  getAgentStatus(ctx: unknown, sandboxId: string): Promise<StatusResult>;
  reconcileAgentProcess(
    ctx: unknown,
    sandboxId: string,
    action: ReconcileAction,
  ): Promise<ReconcileResult>;
}

/** Validate ctx fail-closed; returns the AgentContext or an error marker (never throws). */
export function contextOrError(ctx: unknown): { context: AgentContext } | { contextError: string } {
  try {
    return { context: parseAgentContext(ctx) };
  } catch {
    return { contextError: "invalid agent context" };
  }
}

/** Build a denied event, fail-closed even on a malformed AgentContext. */
export function denyEvent(
  ctx: unknown,
  operation: HostingOperation,
  reason: string,
  sandboxId?: string,
): AgentLifecycleEvent {
  return { operation, result: "denied", reason, sandboxId, ...contextOrError(ctx) };
}
