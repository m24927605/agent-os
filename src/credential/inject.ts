/**
 * SecretResolver injection seam — ITEM R4 (CredentialLease lifecycle), SLICE-P2R-R4-S3.
 *
 * The single typed contact point between the OS governance front and OpenShell's `SecretResolver`.
 * It projects an `injected` (and not-yet-expired) `CredentialLease` into a provider-env map
 * `{ KEY -> placeholder }` whose shape is BYTE-FOR-BYTE compatible with OpenShell's child_env
 * output (`child_env.insert(key, placeholder)`, secrets.rs:188). The seam ONLY assembles
 * placeholder strings — it never touches a literal secret, never queries a secret store, and never
 * resolves a placeholder back to a value (that is `SecretResolver::resolve_placeholder`'s job).
 *
 * Fail-closed (deny-by-default) is the law:
 *  - only `state === "injected"` may project; any other state -> denied (no env).
 *  - expiry is checked here independently of state (design §2.2 expiry window): an `injected` lease
 *    with `expiresAtMs <= now` -> denied, closing the "injected but not yet expire()'d" window
 *    BEFORE any placeholder is produced. This mirrors `SecretResolver::resolve_placeholder`
 *    returning `None` on `expires_at_ms <= now_ms()` (secrets.rs:222-228); R4 is the governance-side
 *    first line, OpenShell the last.
 *  - malformed input -> denied, never a throw that lets the operation through.
 *
 * Vendor-neutral: the placeholder prefix is a LOCAL constant copy of OpenShell's
 * `PLACEHOLDER_PREFIX` (secrets.rs:9) — we deliberately do NOT import the vendor package, to keep
 * no-vendor-in-core green. The grammar is grounded in secrets.rs:483-493.
 */
import { CredentialLease } from "./lease.js";

/**
 * Local constant copy of OpenShell `PLACEHOLDER_PREFIX` (secrets.rs:9:
 * `const PLACEHOLDER_PREFIX: &str = "openshell:resolve:env:";`). Copied (not imported) so the core
 * never names or links a vendor; this string IS the cross-boundary contract.
 */
const PLACEHOLDER_PREFIX = "openshell:resolve:env:";

/**
 * Build the placeholder string for an env KEY, aligned with OpenShell's grammar
 * (secrets.rs:483-493). `revision` undefined or 0 -> canonical `openshell:resolve:env:<KEY>`;
 * otherwise the revision form `openshell:resolve:env:v<revision>_<KEY>`.
 *
 * Pure string assembly — it consults no secret store and never sees a value.
 */
export function placeholderForKey(key: string, revision?: number): string {
  if (revision === undefined || revision === 0) {
    return `${PLACEHOLDER_PREFIX}${key}`;
  }
  return `${PLACEHOLDER_PREFIX}v${revision}_${key}`;
}

/** The seam result: a placeholder env map on success, or a fail-closed denial reason. */
export type ProviderEnvResult =
  | { status: "ok"; env: Record<string, string> }
  | { status: "denied"; reason: string };

/**
 * Project an `injected`, not-yet-expired CredentialLease into an OpenShell-compatible provider-env
 * placeholder map. Returns `denied` (never throws through) for any non-injected state, an expired
 * lease, or malformed input. The output values are ALWAYS placeholder strings — never a secret.
 */
export function toProviderEnv(input: unknown, now: () => number = Date.now): ProviderEnvResult {
  const parsed = CredentialLease.safeParse(input);
  if (!parsed.success) {
    return { status: "denied", reason: "malformed lease" };
  }
  const lease = parsed.data;

  if (lease.state !== "injected") {
    return { status: "denied", reason: `not injectable: state is ${lease.state}` };
  }

  // Expiry window invariant (design §2.2): fail-closed even when state === "injected".
  if (lease.expiresAtMs <= now()) {
    return { status: "denied", reason: "lease is expired (fail-closed)" };
  }

  const env: Record<string, string> = {};
  for (const key of lease.keys) {
    env[key] = placeholderForKey(key, lease.revision);
  }
  return { status: "ok", env };
}
