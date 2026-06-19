/**
 * Policy layer types.
 *
 * A PolicyRequest asks "may this actor perform this action on this resource?".
 * A PolicyDecision answers, and is ALWAYS auditable. The evaluator is deny-by-default.
 */
import { z } from "zod";
import { ActorId, ProjectId, RequestId, TaskId, TenantId } from "../iam/ids.js";

export const PolicyRequest = z.object({
  requestId: RequestId,
  tenantId: TenantId,
  projectId: ProjectId,
  taskId: TaskId,
  actorId: ActorId,
  action: z.string().trim().min(1),
  resource: z.string().trim().min(1),
  context: z.record(z.unknown()).optional(),
});
export type PolicyRequest = z.infer<typeof PolicyRequest>;

export type PolicyEffect = "allow" | "deny";

export interface PolicyDecision {
  readonly effect: PolicyEffect;
  readonly reason: string;
  readonly matchedRule?: string;
  /** Every decision must be audited; deny-by-default means there is no "silent allow". */
  readonly auditRequired: boolean;
}

/**
 * An explicit allow rule. Absence of a matching rule => deny.
 * `resource` supports glob wildcards: `*` matches within a path segment, `**` across
 * segments. A pattern consisting solely of wildcards is rejected as too broad.
 */
export interface AllowRule {
  readonly id: string;
  readonly action: string;
  readonly resource: string;
}

/**
 * An explicit deny rule (same shape as AllowRule). A matching deny ALWAYS wins over any allow
 * (deny-precedence). Unlike allow, a wildcard-only deny pattern (`*` / `**`) is honoured and
 * OVER-matches (fail-safe: it can only deny more, never grant).
 */
export interface DenyRule {
  readonly id: string;
  readonly action: string;
  readonly resource: string;
}

/** A policy rule set: explicit allow + explicit deny. Deny is evaluated first (deny-precedence). */
export interface PolicyRuleSet {
  readonly allow: readonly AllowRule[];
  readonly deny: readonly DenyRule[];
}
