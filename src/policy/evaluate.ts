/**
 * Deny-by-default policy evaluator.
 *
 * Security invariants (CLAUDE.md):
 *  - Unknown file/network/process/inference/credential access is denied by default.
 *  - Fail closed: malformed input or an evaluation error yields `deny`, never `allow`.
 *  - Every decision sets `auditRequired: true`.
 *  - Reasons never echo request values that could carry secrets (only field names / static text).
 */
import { type AllowRule, type PolicyDecision, PolicyRequest } from "./types.js";

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
 * Evaluate a (possibly untrusted) policy request against a set of explicit allow rules.
 * `input` is intentionally `unknown`: callers may pass unvalidated data and rely on the
 * evaluator to fail closed.
 */
export function evaluatePolicy(input: unknown, rules: readonly AllowRule[]): PolicyDecision {
  const parsed = PolicyRequest.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "<root>").join(", ");
    return deny(`malformed policy request (fail-closed); invalid fields: ${fields}`);
  }

  const request = parsed.data;
  try {
    const match = rules.find(
      (rule) => rule.action === request.action && matchResource(rule.resource, request.resource),
    );
    if (match) {
      return {
        effect: "allow",
        reason: `matched allow rule '${match.id}'`,
        matchedRule: match.id,
        auditRequired: true,
      };
    }
    return deny("no matching allow rule (deny-by-default)");
  } catch {
    return deny("policy evaluation error (fail-closed)");
  }
}
