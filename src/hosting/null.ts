/**
 * Fail-closed agent-hosting adapter used when no real host backend is wired: every operation is DENIED
 * (deny-by-default), so no agent is hosted until a real AgentHosting is configured. No I/O.
 */
import {
  type AgentHosting,
  type HostResult,
  type HostSpec,
  type ReconcileAction,
  type ReconcileResult,
  type StatusResult,
  denyEvent,
} from "./port.js";

const DENY_REASON = "no agent-hosting backend configured (deny-by-default, fail-closed)";

export class NullAgentHosting implements AgentHosting {
  hostAgent(ctx: unknown, spec: HostSpec): Promise<HostResult> {
    return Promise.resolve({
      status: "denied",
      reason: DENY_REASON,
      event: denyEvent(ctx, "host", DENY_REASON, spec.sandboxId),
    });
  }
  getAgentStatus(ctx: unknown, sandboxId: string): Promise<StatusResult> {
    return Promise.resolve({
      status: "denied",
      reason: DENY_REASON,
      event: denyEvent(ctx, "status", DENY_REASON, sandboxId),
    });
  }
  reconcileAgentProcess(
    ctx: unknown,
    sandboxId: string,
    _action: ReconcileAction,
  ): Promise<ReconcileResult> {
    return Promise.resolve({
      status: "denied",
      reason: DENY_REASON,
      event: denyEvent(ctx, "reconcile", DENY_REASON, sandboxId),
    });
  }
}
