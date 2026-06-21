/**
 * In-memory agent-hosting adapter — the mandatory 2nd implementation of the AgentHosting port (and a
 * deterministic local/test host). It closes the tenant-isolation gap NemoClaw leaves open: every
 * lifecycle op is tenant-scoped against the registry. No real I/O: state is an in-memory Map. Imports
 * only the port + identity primitives.
 */
import {
  type AgentHosting,
  type AgentPhase,
  type HostResult,
  type HostSpec,
  type ReconcileAction,
  type ReconcileResult,
  type StatusResult,
  UNKNOWN_SANDBOX,
  contextOrError,
  denyEvent,
} from "./port.js";

interface HostedAgent {
  readonly tenantId: string;
  readonly agentName: string;
  phase: AgentPhase;
}

export class InMemoryAgentHosting implements AgentHosting {
  private counter = 0;
  private readonly agents = new Map<string, HostedAgent>();

  hostAgent(ctx: unknown, spec: HostSpec): Promise<HostResult> {
    const c = contextOrError(ctx);
    if ("contextError" in c) {
      return Promise.resolve({
        status: "denied",
        reason: "invalid agent context (fail-closed)",
        event: denyEvent(ctx, "host", "invalid agent context (fail-closed)", spec.sandboxId),
      });
    }
    const existing = this.agents.get(spec.sandboxId);
    if (existing && existing.tenantId !== c.context.tenantId) {
      // cross-tenant: another tenant already owns this sandbox. Caller-facing reason is
      // indistinguishable from unknown-sandbox; the true reason goes only to the audit event.
      const auditReason = "cross-tenant: sandbox is hosted by another tenant (deny-by-default)";
      return Promise.resolve({
        status: "denied",
        reason: UNKNOWN_SANDBOX,
        event: denyEvent(ctx, "host", auditReason, spec.sandboxId),
      });
    }
    this.agents.set(spec.sandboxId, {
      tenantId: c.context.tenantId,
      agentName: spec.agentName,
      phase: "running",
    });
    const agentProcessId = `proc-${++this.counter}`;
    return Promise.resolve({
      status: "ok",
      agentProcessId,
      event: { operation: "host", result: "ok", context: c.context, sandboxId: spec.sandboxId },
    });
  }

  getAgentStatus(ctx: unknown, sandboxId: string): Promise<StatusResult> {
    const owned = this.requireOwned(ctx, "status", sandboxId);
    if ("denied" in owned) return Promise.resolve(owned.denied as StatusResult);
    return Promise.resolve({
      status: "ok",
      phase: owned.agent.phase,
      event: { operation: "status", result: "ok", context: owned.context, sandboxId },
    });
  }

  reconcileAgentProcess(
    ctx: unknown,
    sandboxId: string,
    action: ReconcileAction,
  ): Promise<ReconcileResult> {
    const owned = this.requireOwned(ctx, "reconcile", sandboxId);
    if ("denied" in owned) return Promise.resolve(owned.denied as ReconcileResult);
    if (action === "restart") {
      owned.agent.phase = "running";
    }
    return Promise.resolve({
      status: "ok",
      event: { operation: "reconcile", result: "ok", context: owned.context, sandboxId },
    });
  }

  /**
   * Resolve a sandbox the caller is allowed to act on, or a denied result. Fail-closed on a malformed
   * ctx; deny on unknown sandbox; deny cross-tenant (a tenant may only touch its own agents).
   */
  private requireOwned(ctx: unknown, operation: "status" | "reconcile", sandboxId: string) {
    const c = contextOrError(ctx);
    if ("contextError" in c) {
      const reason = "invalid agent context (fail-closed)";
      return {
        denied: { status: "denied", reason, event: denyEvent(ctx, operation, reason, sandboxId) },
      };
    }
    // unknown-sandbox and cross-tenant return the SAME caller-facing reason (UNKNOWN_SANDBOX) so the
    // caller cannot probe existence/ownership; the true reason is preserved only in the audit event.
    const agent = this.agents.get(sandboxId);
    if (agent === undefined) {
      const auditReason = "unknown sandbox (deny-by-default)";
      return {
        denied: {
          status: "denied",
          reason: UNKNOWN_SANDBOX,
          event: denyEvent(ctx, operation, auditReason, sandboxId),
        },
      };
    }
    if (agent.tenantId !== c.context.tenantId) {
      const auditReason = "cross-tenant: sandbox is hosted by another tenant (deny-by-default)";
      return {
        denied: {
          status: "denied",
          reason: UNKNOWN_SANDBOX,
          event: denyEvent(ctx, operation, auditReason, sandboxId),
        },
      };
    }
    return { agent, context: c.context };
  }
}
