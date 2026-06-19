/**
 * Deny-by-default policy evaluator.
 *
 * Security invariants (CLAUDE.md):
 *  - Unknown file/network/process/inference/credential access is denied by default.
 *  - Fail closed: malformed input or an evaluation error yields `deny`, never `allow`.
 *  - Every decision sets `auditRequired: true`.
 *  - Reasons never echo request values that could carry secrets (only field names / static text).
 */
import { type AllowRule, type PolicyDecision, PolicyRequest, type PolicyRuleSet } from "./types.js";

function deny(reason: string): PolicyDecision {
  return { effect: "deny", reason, auditRequired: true };
}

/** Translate a restricted glob (`*`, `**`) into an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "*") {
      if (pattern.charAt(i + 1) === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else {
      source += c.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** Does an allow rule's resource pattern match the requested resource? */
export function matchResource(pattern: string, resource: string): boolean {
  if (pattern === resource) {
    return true;
  }
  if (!pattern.includes("*")) {
    return false;
  }
  // Reject patterns that are only wildcards (e.g. "*", "**", "***") as dangerously broad.
  if (pattern.replace(/\*/g, "").length === 0) {
    return false;
  }
  return globToRegExp(pattern).test(resource);
}

/**
 * Deny matching: like `matchResource`, but a wildcard-only pattern OVER-matches (matches
 * everything). This is fail-safe — a wildcard-only deny can only deny MORE, never grant.
 */
export function matchDenyResource(pattern: string, resource: string): boolean {
  if (pattern === resource) {
    return true;
  }
  if (!pattern.includes("*")) {
    return false;
  }
  if (pattern.replace(/\*/g, "").length === 0) {
    return true;
  }
  return globToRegExp(pattern).test(resource);
}

/**
 * Evaluate a (possibly untrusted) policy request. Accepts either a legacy allow-rule list or a
 * full `PolicyRuleSet` ({ allow, deny }). Invariants (PDP seed):
 *  - DENY-PRECEDENCE: any matching deny rule wins over every allow rule.
 *  - DENY-BY-DEFAULT: no matching allow (and no matching deny) => deny.
 *  - FAIL-CLOSED: malformed input or an evaluation error => deny, never allow.
 *  - Reasons never echo request values (only rule ids / field names / static text).
 */
export function evaluatePolicy(input: unknown, rules: readonly AllowRule[]): PolicyDecision;
export function evaluatePolicy(input: unknown, rules: PolicyRuleSet): PolicyDecision;
export function evaluatePolicy(
  input: unknown,
  rules: readonly AllowRule[] | PolicyRuleSet,
): PolicyDecision {
  const ruleSet: PolicyRuleSet = Array.isArray(rules)
    ? { allow: rules, deny: [] }
    : (rules as PolicyRuleSet);

  const parsed = PolicyRequest.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "<root>").join(", ");
    return deny(`malformed policy request (fail-closed); invalid fields: ${fields}`);
  }

  const request = parsed.data;
  try {
    // Deny precedence: any matching deny wins over every allow.
    const denied = ruleSet.deny.find(
      (rule) =>
        rule.action === request.action && matchDenyResource(rule.resource, request.resource),
    );
    if (denied) {
      return {
        effect: "deny",
        reason: `matched deny rule '${denied.id}'`,
        matchedRule: denied.id,
        auditRequired: true,
      };
    }
    const allowed = ruleSet.allow.find(
      (rule) => rule.action === request.action && matchResource(rule.resource, request.resource),
    );
    if (allowed) {
      return {
        effect: "allow",
        reason: `matched allow rule '${allowed.id}'`,
        matchedRule: allowed.id,
        auditRequired: true,
      };
    }
    return deny("no matching allow rule (deny-by-default)");
  } catch {
    return deny("policy evaluation error (fail-closed)");
  }
}
