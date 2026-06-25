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
 *
 * SLICE-CAP5 — the deny-by-default exact-match matcher was EXTRACTED to the vendor-neutral policy core
 * (`src/policy/egress-allowlist.ts`, `matchEgressAllow`) as the SINGLE SOURCE OF TRUTH. This gate now
 * RE-USES it (imported via the policy barrel — `not-to-internal` holds), so the matching logic lives in
 * exactly one place. This gate keeps its OWN gate name + static reason text + `EgressDecision` shape, so
 * its observable behavior and its tests stay BYTE-IDENTICAL; only the host-membership test is delegated.
 */
import { matchEgressAllow } from "../policy/index.js";
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
  // must never serve as a wildcard), so reject it explicitly with this gate's static reason. The
  // EXTRACTED `matchEgressAllow` already fail-closes on an empty host, but we keep this branch so the
  // gate's empty-host reason text is byte-identical to before the extraction (the inference tests pin it).
  if (host.length === 0) {
    return { allowed: false, reason: `${GATE}: empty egress host` };
  }
  // Delegate the deny-by-default exact (case-insensitive) host-membership test to the SINGLE SOURCE OF
  // TRUTH. `matchEgressAllow` re-normalizes internally; `req.egressHost` (not the pre-normalized `host`)
  // is passed so the matcher owns normalization — behavior is identical (idempotent trim+lowercase).
  if (!matchEgressAllow(req.egressHost, allowlist)) {
    return { allowed: false, reason: `${GATE}: egress host not on allowlist` };
  }
  return { allowed: true };
}
