/**
 * IAM identity primitives.
 *
 * Branded, non-empty string IDs so that a TenantId can never be silently used where a
 * ProjectId is expected. These feed the Audit and Policy layers; tenant scoping here is
 * the foundation for the future Tenant Isolation work (enterprise mode = gateway-per-tenant).
 */
import { z } from "zod";

const nonEmpty = z.string().trim().min(1);

export const TenantId = nonEmpty.brand<"TenantId">();
export type TenantId = z.infer<typeof TenantId>;

export const ProjectId = nonEmpty.brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectId>;

export const TaskId = nonEmpty.brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;

export const ActorId = nonEmpty.brand<"ActorId">();
export type ActorId = z.infer<typeof ActorId>;

export const RequestId = nonEmpty.brand<"RequestId">();
export type RequestId = z.infer<typeof RequestId>;

export const EventId = nonEmpty.brand<"EventId">();
export type EventId = z.infer<typeof EventId>;

export const SandboxId = nonEmpty.brand<"SandboxId">();
export type SandboxId = z.infer<typeof SandboxId>;

/**
 * OCSF AgentContext — the validated aggregate of identity primitives carried by every
 * privileged action and AuditEvent. `sandboxId` is optional (not every action runs in a sandbox).
 * This is the OCSF AgentContext mapping start; downstream slices (canonical serialize, evidence
 * kernel ingest) draw an event's identity from here, eliminating field drift.
 */
export const AgentContext = z.object({
  actorId: ActorId,
  tenantId: TenantId,
  projectId: ProjectId,
  taskId: TaskId,
  requestId: RequestId,
  sandboxId: SandboxId.optional(),
});
export type AgentContext = z.infer<typeof AgentContext>;

/** Validate untrusted input into an AgentContext. Fail-closed: missing/empty id throws. */
export function parseAgentContext(input: unknown): AgentContext {
  return AgentContext.parse(input);
}
