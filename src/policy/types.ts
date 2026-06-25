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

/**
 * A value that MAY be a promise — `T` or `Promise<T>`. The async seam (SLICE-R9a) for the policy path:
 * a port typed `MaybePromise<T>` accepts BOTH a sync implementation (a plain `T`) and an async one (a
 * `Promise<T>`), so an async advisory (e.g. a future cross-language AGT engine) can be folded in without
 * forcing every existing sync closure/fake to change. The pipeline `await`s such a value, on which a
 * plain `T` resolves to itself — so the absent/sync path stays behaviorally byte-identical.
 */
export type MaybePromise<T> = T | Promise<T>;

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
  /**
   * Tenant scope. Absent => the rule applies to ALL tenants (backward-compatible / global). When set,
   * the allow applies ONLY to a request from the same tenant — a tenant-A allow never grants tenant-B
   * (cross-tenant deny-by-default).
   */
  readonly tenantId?: string;
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
  /**
   * Tenant scope. Absent => the deny applies to ALL tenants (fail-safe global deny — can only deny
   * more). When set, the deny applies ONLY to its own tenant (tenant-A's deny does not block tenant-B).
   */
  readonly tenantId?: string;
}

/** A policy rule set: explicit allow + explicit deny. Deny is evaluated first (deny-precedence). */
export interface PolicyRuleSet {
  readonly allow: readonly AllowRule[];
  readonly deny: readonly DenyRule[];
}
