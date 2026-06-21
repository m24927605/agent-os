/**
 * AgtSecondaryPolicy — the real-vendor policy adapter for the P2-E SecondaryPolicyAdapter seam (R11-S4).
 *
 * AGT (the Agent Governance Toolkit) ships its own policy engine. Its GovernedCallable.__call__
 * evaluates to a PolicyDecision { allowed, action, matched_rule, reason } (verified from
 * /tmp/agent-governance-toolkit/agent-governance-python/agent-mesh/src/agentmesh/governance/policy.py
 * :435-455; action ∈ {"allow","deny","warn","require_approval","log"} :452; default action = "deny"
 * :238; conflict strategy deny_overrides govern.py:122).
 *
 * This adapter DEMOTES the whole AGT engine to an ADVISORY input on our policy seam (integration dedup
 * #1: the PDP is the SOLE deny authority). We map AGT's decision onto our PolicyDecision:
 *   - allowed===true && action==="allow"  -> effect:"allow"
 *   - EVERYTHING ELSE (deny / warn / log / require_approval / a malformed action / a malformed object)
 *     -> effect:"deny"  (fail-CLOSED, deny-by-default).
 * AGT can never GRANT what the PDP denied: combineDecisions (dedup.ts) keeps an AGT-allow advisory, and
 * an AGT throw becomes a synthetic deny via evaluateSecondaries. The AGT matched_rule/reason are carried
 * into our reason for the audit trail.
 *
 * Honest mis-alignment (design vendor-adapters.md §2.4): AGT's `require_approval` is a
 * routed-to-coordinator non-terminal state; we have NO approval channel here (approval is PDP /
 * maker-checker, P4), so it is conservatively mapped to deny — NEVER mistaken for allow. AGT's own
 * advisory/shadow layer is deliberately NOT mapped (it would double the advisory semantics).
 *
 * Capability gate: the real AGT engine is Python; here it is an injected `AgtEvaluateFn` seam, so the
 * adapter runs fully in-process with no I/O and the core imports no vendor SDK. The live Python engine
 * lands via the R9 SDK seam in a later integration slice. Cohesion: imports ONLY the policy types — no
 * vendor, no evaluate.ts, no deep import.
 */
import type { SecondaryPolicyAdapter } from "../../dedup.js";
import type { PolicyDecision, PolicyRequest } from "../../types.js";

/**
 * AGT's PolicyDecision shape, mapped 1:1 from policy.py:435-455. `allowed` is the boolean verdict;
 * `action` is AGT's effect literal; `matchedRule`/`reason` are advisory metadata for the audit trail.
 */
export interface AgtDecision {
  readonly allowed: boolean;
  readonly action: string;
  readonly matchedRule?: string;
  readonly reason?: string;
}

/**
 * Injected seam to AGT's engine.evaluate (live Python engine lands via the R9 SDK seam). It receives
 * the AGT evaluation context derived from our PolicyRequest. A throw is treated as fail-CLOSED by the
 * caller (evaluateSecondaries synthesises a deny) — a crashing advisor can only ever deny more.
 */
export type AgtEvaluateFn = (ctx: AgtEvaluationContext) => AgtDecision;

/** The evaluation context handed to AGT — action/resource/actor/tenant, the fields AGT rules key on. */
export interface AgtEvaluationContext {
  readonly action: string;
  readonly resource: string;
  readonly actor: string;
  readonly tenant: string;
}

/** ONLY an unambiguous AGT allow (allowed===true AND action==="allow") may map to our allow. */
function isAgtAllow(d: AgtDecision): boolean {
  return d.allowed === true && d.action === "allow";
}

/** Structural validation — an untrusted vendor reply that is not the expected shape is treated as deny. */
function isAgtDecision(value: unknown): value is AgtDecision {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.allowed === "boolean" && typeof d.action === "string";
}

export class AgtSecondaryPolicy implements SecondaryPolicyAdapter {
  constructor(private readonly evaluateFn: AgtEvaluateFn) {}

  /**
   * Map our PolicyRequest -> AGT context -> AGT decision -> our advisory PolicyDecision. Fail-CLOSED on
   * any non-allow or malformed AGT reply. Note: this method does NOT swallow a thrown AgtEvaluateFn —
   * the throw propagates so evaluateSecondaries (dedup.ts) records the canonical synthetic deny
   * (deny-by-default), keeping a single fail-closed path rather than two divergent ones.
   */
  evaluate(req: PolicyRequest): PolicyDecision {
    const ctx: AgtEvaluationContext = {
      action: req.action,
      resource: req.resource,
      actor: req.actorId,
      tenant: req.tenantId,
    };
    const raw: unknown = this.evaluateFn(ctx);
    if (!isAgtDecision(raw)) {
      return {
        effect: "deny",
        reason: "AGT advisory returned a malformed decision — deny-by-default (fail-closed)",
        auditRequired: true,
      };
    }
    const annotate = `agt: allowed=${raw.allowed} action=${raw.action}${
      raw.matchedRule ? ` rule=${raw.matchedRule}` : ""
    }${raw.reason ? ` reason=${raw.reason}` : ""}`;
    if (isAgtAllow(raw)) {
      return { effect: "allow", reason: `allow (advisory) — ${annotate}`, auditRequired: true };
    }
    return {
      effect: "deny",
      reason: `deny (fail-closed; AGT non-allow is advisory-deny) — ${annotate}`,
      matchedRule: raw.matchedRule,
      auditRequired: true,
    };
  }
}
