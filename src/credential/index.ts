/**
 * Credential module public surface (the depth-1 barrel cross-module consumers import through).
 *
 * The OS governance front for ITEM R4 (CredentialLease lifecycle). Cross-module imports MUST go
 * through this barrel, not a module-internal file (dependency-cruiser `not-to-internal`). This
 * module is vendor-neutral: it never names or imports a vendor (no-vendor-in-core) and never imports
 * the audit layer (the redact detector is injected in tests only). See docs/design/credential-lease.md.
 */
export { CredentialLease, LeaseState, parseCredentialLease } from "./lease.js";
export {
  type LeaseTransition,
  LeaseEvent,
  LeaseSpec,
  LeaseTransitionKind,
  expire,
  inject,
  mint,
  revoke,
  use,
} from "./fsm.js";
export { type ProviderEnvResult, placeholderForKey, toProviderEnv } from "./inject.js";
