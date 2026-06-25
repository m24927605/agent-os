/**
 * SLICE-CAP5 — the vendor-neutral egress-allowlist PRIMITIVE: the SINGLE SOURCE OF TRUTH for the
 * deny-by-default, exact-match (case-insensitive), fail-closed egress host matcher, plus the PDP-side
 * defense-in-depth decision built on it.
 *
 * `matchEgressAllow` is lifted VERBATIM from the inference second-chokepoint gate
 * (`src/inference/egress-allowlist.ts`, SLICE-P2R-R6-S2) so there is ONE matcher, not two. The inference
 * gate now re-imports it (its observable behavior + tests stay byte-identical). Two invariants hold by
 * construction:
 *   - deny-by-default: only a host that EXACTLY matches an allowlist entry (compared case-insensitively
 *     after a trim+lowercase normalize) passes. An unknown host, an effectively-empty host, OR an empty
 *     allowlist all deny.
 *   - bypass resistance / fail-closed: matching is EXACT on the normalized host — NOT a suffix or
 *     substring match. `evil-api.allowed.example`, `api.allowed.example.evil.com`, a bare
 *     `allowed.example`, or a leading/trailing-dot variant must NOT match `api.allowed.example`.
 *
 * VENDOR-NEUTRALITY: lives in the policy core zone. Imports ONLY the neutral `PolicyDecision` type from
 * this module's own `types.ts` — no vendor token, so `no-vendor-in-core` holds and both the inference
 * gate AND the substrate/bin layers can re-use it via the policy barrel.
 *
 * PURE: no I/O, no throw on normal input.
 */
import type { PolicyDecision } from "./types.js";

/** The PDP egress defense-in-depth reason — STATIC gate text; it never echoes a host value. */
const EGRESS_GATE = "policy.egress-allowlist";

/** Lower-case + trim. The ONLY normalization applied before an EXACT equality comparison. */
function normalize(host: string): string {
  return host.trim().toLowerCase();
}

/**
 * Deny-by-default exact-match egress host check. `true` iff `host` (normalized) EXACTLY equals some
 * allowlist entry (normalized). An effectively-empty host can never be on the allowlist (and an empty
 * entry must never serve as a wildcard), so it is rejected explicitly. NO suffix / substring matching.
 */
export function matchEgressAllow(host: string, allowlist: readonly string[]): boolean {
  const normalized = normalize(host);
  // deny-by-default: an effectively-empty host can never be on the allowlist (an empty entry must
  // never act as a wildcard), so reject it explicitly before the `.some()` exact comparison.
  if (normalized.length === 0) return false;
  return allowlist.some((entry) => normalize(entry) === normalized);
}

/**
 * The PDP-side egress defense-in-depth decision (SLICE-CAP5). For a tool whose credential-blind
 * governance projection carries `networkHosts`, the bin's authorize closure folds THIS decision in
 * alongside the PDP + advisory secondaries (any-deny-wins):
 *   - empty `networkHosts` => `allow` (no egress to gate);
 *   - EVERY host on the allowlist (via `matchEgressAllow`) => `allow`;
 *   - ANY host NOT on the allowlist => `deny` with a STATIC reason that names a COUNT of unallowed
 *     hosts only — never the offending host value (credential-blind; a host may carry sensitive
 *     deployment topology). An empty allowlist + a non-empty host list therefore denies (deny-all).
 *
 * HONEST BOUNDARY: the substrate seal (OpenShell network policy) is the PRIMARY no-egress enforcement.
 * This is a BEST-EFFORT secondary check — an obfuscated / IP-literal host could slip past the projection
 * — so it strengthens, never replaces, the substrate. The PDP remains the sole DENY authority: this
 * decision is FOLDED INTO authorize (any-deny-wins), not a second runtime path.
 *
 * PURE: no I/O, no throw.
 */
export function egressDecisionForProjection(
  networkHosts: readonly string[],
  egressAllow: readonly string[],
): PolicyDecision {
  const unallowed = networkHosts.filter((h) => !matchEgressAllow(h, egressAllow));
  if (unallowed.length > 0) {
    return {
      // STATIC reason: a COUNT only (never the host value) — credential-blind, deny-by-default.
      effect: "deny",
      reason: `${EGRESS_GATE}: ${unallowed.length} egress host(s) not on allowlist (deny-by-default)`,
      auditRequired: true,
    };
  }
  return {
    effect: "allow",
    reason: `${EGRESS_GATE}: all ${networkHosts.length} egress host(s) on allowlist`,
    auditRequired: true,
  };
}
