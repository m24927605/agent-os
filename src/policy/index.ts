/**
 * Policy module public surface — the deny-by-default PDP, its dedup merge law, and the policy types.
 * Cross-module consumers (e.g. `src/tools/authorize.ts`) import ONLY from here, never deep into the
 * module's internals (enforced by dep-cruiser `not-to-internal`).
 */
export * from "./types.js";
export * from "./evaluate.js";
export * from "./dedup.js";
// SLICE-R9b-2b — the credential-blind governance projection (R9b-1) is now part of the policy public
// surface: the autonomous-path projector + the AGT adapter consume `GovernanceProjection` /
// `buildExecRunProjection` via this barrel (never a deep import). `GovernanceProjectionSchema` is the
// same schema `types.ts` folds into `PolicyRequest.governanceProjection`.
export * from "./governance-projection.js";
// SLICE-CAP5 — the vendor-neutral egress-allowlist PRIMITIVE: `matchEgressAllow` (the single source of
// truth the inference second-chokepoint gate re-uses) + `egressDecisionForProjection` (the PDP-side
// defense-in-depth decision the bin's authorize folds in for a tool whose projection carries networkHosts).
export * from "./egress-allowlist.js";
// SLICE-CAP9 — the vendor-neutral host-write-target PRIMITIVE (precise PARALLEL to egress-allowlist):
// `matchHostWriteTarget` (lexical canonicalization + deny-by-default under-root containment) +
// `hostWriteDecisionForProjection` (the PDP-side defense-in-depth decision the bin's authorize folds in
// for a tool whose projection carries writeTargets). The REAL host-write enforcement is a deploy fact
// (sandbox host-mount + kernel realpath); this lexical check is best-effort defense-in-depth.
export * from "./host-write-target.js";
