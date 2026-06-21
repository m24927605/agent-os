/**
 * CredentialLease — the bundleRef-only domain object for ITEM R4 (CredentialLease lifecycle).
 *
 * A lease answers "which credentials is an agent authorized to use, in which sandbox, until when"
 * — strictly BY REFERENCE. It NEVER holds a literal secret. The real secret materializes ONLY in
 * the OpenShell `SecretResolver` egress proxy (design doc docs/design/credential-lease.md §1.2);
 * a lease carries an opaque `bundleRef` (e.g. "anthropic-prod") plus the declared env KEY *names*
 * (not values). The `.strict()` boundary structurally rejects any secret-shaped or out-of-scope
 * input — fail-closed (deny-by-default).
 *
 * Scope (SLICE-P2R-R4-S1): this slice defines the schema, the LeaseState type, and the fail-closed
 * `parseCredentialLease`. The FSM transitions (mint/inject/use/revoke/expire) are S2; the injection
 * seam (lease -> provider-env placeholder map) is S3.
 */
import { z } from "zod";
import { AgentContext } from "../iam/ids.js";

/**
 * Lease lifecycle states. `issued` is the only state a freshly minted lease may declare (the FSM in
 * S2 owns transitions; deny-by-default rejects any other initial state here).
 */
export const LeaseState = z.enum(["issued", "injected", "used", "revoked", "expired"]);
export type LeaseState = z.infer<typeof LeaseState>;

/**
 * A POSIX-shell-compatible environment variable name: a leading letter or underscore followed by
 * letters, digits, or underscores. This deliberately admits ONLY a name — never a value — so a raw
 * secret (which contains `-`, `.`, etc.) cannot survive as a `keys` element.
 */
const EnvKeyName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "keys must be valid env-key NAMES, not values");

/**
 * `.strict()` CredentialLease schema. Any undeclared field (e.g. `secret`, `value`, `apiKey`) is a
 * parse error — the structural defense against smuggling a literal secret into the lease.
 */
export const CredentialLease = z
  .object({
    /** Opaque reference to a credential bundle. NOT a secret, NOT a placeholder value. */
    bundleRef: z.string().trim().min(1),
    /** The authorization subject this lease is bound to. */
    context: AgentContext,
    /** Declared env-key NAMES (non-empty) the bundle is expected to expose. Values live in OpenShell. */
    keys: z.array(EnvKeyName).min(1),
    /** Expiry as epoch milliseconds; must be a positive integer. */
    expiresAtMs: z.number().int().positive(),
    /** Optional secret revision (drives revision-form placeholders downstream in S3). */
    revision: z.number().int().nonnegative().optional(),
    /** A freshly minted lease is `issued`; the FSM (S2) owns every later transition. */
    state: LeaseState,
  })
  .strict();
export type CredentialLease = z.infer<typeof CredentialLease>;

/** Validate untrusted input into a CredentialLease. Fail-closed: bad/extra/secret-shaped input throws. */
export function parseCredentialLease(input: unknown): CredentialLease {
  return CredentialLease.parse(input);
}
