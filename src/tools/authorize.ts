/**
 * Registry-backed `tool:invoke` authorization — a DENY-ONLY pre-screen in front of the PDP.
 *
 * Security invariants (CLAUDE.md / design §2.3):
 *  - DENY-BY-DEFAULT: a `tool:invoke` whose tool name is not in the ToolRegistry is denied
 *    structurally (rather than falling through to the generic no-allow default).
 *  - FAIL-CLOSED: a malformed request denies (delegated to `evaluatePolicy`, which parses it).
 *  - This predicate can ONLY ever deny more — it NEVER grants. A registered tool is fully
 *    delegated to `evaluatePolicy`, so the PDP remains the sole deny/grant authority (dedup #1).
 *
 * Convention: for `action === "tool:invoke"`, `req.resource` IS the tool name (the registry key /
 * manifest `name`). `resourcePattern` is NOT consulted here (design §2.1 field-consumption scope).
 */
import {
  type AllowRule,
  type PolicyDecision,
  PolicyRequest,
  type PolicyRuleSet,
  evaluatePolicy,
} from "../policy/index.js";
import type { ToolRegistry } from "./registry.js";

export function authorizeToolInvoke(
  req: unknown,
  registry: ToolRegistry,
  rules: PolicyRuleSet | readonly AllowRule[],
): PolicyDecision {
  const parsed = PolicyRequest.safeParse(req);
  if (
    parsed.success &&
    parsed.data.action === "tool:invoke" &&
    !registry.has(parsed.data.resource)
  ) {
    return {
      effect: "deny",
      reason: "tool:invoke for unregistered tool (deny-by-default)",
      auditRequired: true,
    };
  }
  return evaluatePolicy(req, rules as PolicyRuleSet);
}
