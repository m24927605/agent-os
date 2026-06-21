/**
 * Egress host deny-by-default gate — the SECOND chokepoint of the inference routing gate
 * (docs/design/inference-routing-gate.md §2.2 step 2; §2.1 / §4.1 for the interim rationale).
 * Pure function, no I/O.
 *
 * This is the core-side INTERIM guard that aligns with OpenShell's deny-by-default egress
 * (best-practices.mdx:40-51) before the real adapter (R1/R11) wires up network_policies. Two
 * invariants hold by construction:
 *   - deny-by-default: only a host that EXACTLY matches an allowlist entry (compared
 *     case-insensitively) passes. An unknown host, an effectively-empty host, or an empty
 *     allowlist all deny.
 *   - bypass resistance / fail-closed: matching is exact on the normalized host — NOT a suffix or
 *     substring match. `evil-api.allowed.example`, `api.allowed.example.evil.com`, a bare
 *     `allowed.example`, or a leading/trailing-dot variant must NOT match `api.allowed.example`.
 *
 * The deny `reason` is static gate text — it never echoes the request payload (reason-does-not-leak).
 */
import type { EgressAllowlist, InferenceRequest } from "./types.js";

const GATE = "inference.egress-allowlist";

type EgressDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** Lower-case + trim. The only normalization we apply before an EXACT equality comparison. */
function normalize(host: string): string {
  return host.trim().toLowerCase();
}

export function isEgressAllowed(req: InferenceRequest, allowlist: EgressAllowlist): EgressDecision {
  const host = normalize(req.egressHost);
  // deny-by-default: an effectively-empty host can never be on the allowlist (and an empty entry
  // must never serve as a wildcard), so reject it explicitly.
  if (host.length === 0) {
    return { allowed: false, reason: `${GATE}: empty egress host` };
  }
  const onAllowlist = allowlist.some((entry) => normalize(entry) === host);
  if (!onAllowlist) {
    return { allowed: false, reason: `${GATE}: egress host not on allowlist` };
  }
  return { allowed: true };
}
