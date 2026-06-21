/**
 * Policy de-duplication — the PDP is the SOLE deny authority (integration dedup #1).
 *
 * The committed stack carries several policy engines (our PDP, AGT-derived, OpenShell OPA/Z3). To
 * avoid two parallel deny authorities, every secondary engine is demoted to an ADVISORY input: its
 * opinion is recorded for audit but it can NEVER grant what the PDP denied. The single combined
 * decision follows deny-precedence / any-deny-wins (fail-closed), and a secondary that ERRORS is
 * treated as a deny (deny-by-default) — a broken advisor can only ever deny more, never grant.
 *
 * `SecondaryPolicyAdapter` is the vendor-neutral seam for the Policy slot (default source: AGT-derived,
 * landing under src/policy/adapters/<vendor>/ in a later slice). This module imports only policy types
 * — no vendor, no evaluate.ts.
 */
import type { PolicyDecision, PolicyRequest } from "./types.js";

/** An ADVISORY policy engine (e.g. AGT, OpenShell OPA). Never the deny authority — its decision is an input to `combineDecisions`. */
export interface SecondaryPolicyAdapter {
  evaluate(req: PolicyRequest): PolicyDecision;
}

/**
 * Run each secondary adapter fail-closed: an adapter that throws yields a SYNTHETIC deny (deny-by-
 * default), so a crashing advisor cannot silently let an action through.
 */
export function evaluateSecondaries(
  adapters: readonly SecondaryPolicyAdapter[],
  req: PolicyRequest,
): PolicyDecision[] {
  return adapters.map((adapter) => {
    try {
      return adapter.evaluate(req);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        effect: "deny",
        reason: `secondary policy adapter errored — deny-by-default (fail-closed): ${reason}`,
        auditRequired: true,
      };
    }
  });
}

/**
 * Combine the PDP decision with 0..N advisory secondary decisions into ONE decision.
 *  - allow ONLY if every input's effect is exactly `"allow"`; ANY other effect contributes a deny
 *    (deny-precedence / any-deny-wins). A non-`"allow"` effect — `"deny"` OR a malformed/garbage value
 *    from an untrusted advisory engine — is treated as a deny (deny-by-default / fail-closed);
 *  - a secondary `allow` can NEVER override a PDP `deny` (PDP is the sole deny authority);
 *  - the reason annotates every input so audit shows e.g. "AGT said allow, but PDP denied".
 */
export function combineDecisions(
  primary: PolicyDecision,
  secondary: readonly PolicyDecision[],
): PolicyDecision {
  // Fail-closed: anything that is not exactly "allow" (incl. a malformed effect) is a deny.
  const denials = [
    ...(primary.effect !== "allow" ? [{ source: "pdp", d: primary }] : []),
    ...secondary.flatMap((d, i) =>
      d.effect !== "allow" ? [{ source: `secondary[${i}]`, d }] : [],
    ),
  ];
  const annotate = [
    `pdp=${primary.effect}(${primary.reason})`,
    ...secondary.map((d, i) => `secondary[${i}]=${d.effect}(${d.reason})`),
  ].join("; ");

  if (denials.length > 0) {
    // PDP deny takes the matchedRule when present; otherwise the first denying source's.
    const ruleSource = primary.effect === "deny" ? primary : denials[0]?.d;
    return {
      effect: "deny",
      reason: `deny (any-deny-wins) — ${annotate}`,
      matchedRule: ruleSource?.matchedRule,
      auditRequired: true,
    };
  }
  return {
    effect: "allow",
    reason: `allow (pdp + all secondaries) — ${annotate}`,
    auditRequired: true,
  };
}

/** Advisory adapter that always allows — a test/2nd-impl double; allow is still subject to PDP + any-deny-wins. */
export class AllowAllSecondaryPolicy implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): PolicyDecision {
    return { effect: "allow", reason: "allow-all secondary (advisory)", auditRequired: true };
  }
}

/** Advisory adapter that always denies — defense-in-depth test/2nd-impl double. */
export class DenyAllSecondaryPolicy implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): PolicyDecision {
    return { effect: "deny", reason: "deny-all secondary (advisory)", auditRequired: true };
  }
}
