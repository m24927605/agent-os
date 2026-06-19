/**
 * AuditEvent — the auditable record of a privileged decision/action.
 *
 * Security invariants (CLAUDE.md "Audit Completeness Loop"): every sensitive event carries
 * actor_id, tenant_id, project_id, task_id, (optional) sandbox_id, action, resource,
 * policy_decision, timestamp, request_id, and result. `createAuditEvent` fails closed:
 * a missing/invalid field throws rather than producing a partial event.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ActorId,
  EventId,
  ProjectId,
  RequestId,
  SandboxId,
  TaskId,
  TenantId,
  parseAgentContext,
} from "../iam/ids.js";

export const AuditResult = z.enum(["success", "denied", "error"]);
export type AuditResult = z.infer<typeof AuditResult>;

export const AuditPolicyDecision = z.object({
  effect: z.enum(["allow", "deny"]),
  reason: z.string().min(1),
  matchedRule: z.string().min(1).optional(),
});
export type AuditPolicyDecision = z.infer<typeof AuditPolicyDecision>;

export const AuditEvent = z.object({
  eventId: EventId,
  requestId: RequestId,
  timestamp: z.string().datetime({ offset: true }),
  tenantId: TenantId,
  projectId: ProjectId,
  taskId: TaskId,
  actorId: ActorId,
  sandboxId: SandboxId.optional(),
  action: z.string().trim().min(1),
  resource: z.string().trim().min(1),
  policyDecision: AuditPolicyDecision,
  result: AuditResult,
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/** Plain-string input shape; `createAuditEvent` validates it into a branded AuditEvent. */
export interface AuditEventInput {
  requestId: string;
  tenantId: string;
  projectId: string;
  taskId: string;
  actorId: string;
  sandboxId?: string;
  action: string;
  resource: string;
  policyDecision: { effect: "allow" | "deny"; reason: string; matchedRule?: string };
  result: AuditResult;
  /** Optional overrides (mainly for deterministic tests). */
  eventId?: string;
  timestamp?: string;
}

/** Injectable clock + id source so audit events are deterministic under test. */
export interface AuditClock {
  now(): string;
  newId(): string;
}

const systemClock: AuditClock = {
  now: () => new Date().toISOString(),
  newId: () => randomUUID(),
};

export function createAuditEvent(
  input: AuditEventInput,
  clock: AuditClock = systemClock,
): AuditEvent {
  // Identity fields flow only through a validated AgentContext (single source; fail-closed).
  const context = parseAgentContext({
    actorId: input.actorId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    taskId: input.taskId,
    requestId: input.requestId,
    sandboxId: input.sandboxId,
  });
  const candidate = {
    eventId: input.eventId ?? clock.newId(),
    requestId: context.requestId,
    timestamp: input.timestamp ?? clock.now(),
    tenantId: context.tenantId,
    projectId: context.projectId,
    taskId: context.taskId,
    actorId: context.actorId,
    sandboxId: context.sandboxId,
    action: input.action,
    resource: input.resource,
    policyDecision: input.policyDecision,
    result: input.result,
  };
  // Throws ZodError on any missing/invalid field => no partial/silent audit events.
  return AuditEvent.parse(candidate);
}
