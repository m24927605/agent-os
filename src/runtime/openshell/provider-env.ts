/**
 * Provider-env placeholder-only shape guard — slice P2R-R1-S5 (design §2.3 / §6).
 *
 * SINGLE responsibility: a PURE function (no I/O, no RPC, no logging) that asserts every value in a
 * provider-env record is a well-formed OpenShell `SecretResolver` placeholder, and THROWS fail-closed
 * on anything else. It holds NO credential, resolves NO placeholder (that is OpenShell's SecretResolver
 * at egress, secrets.rs:214), and reaches NO egress.
 *
 * WHY (moat constraint — "credentials never on disk"): OpenShell's `SecretResolver` rewrites
 * provider-env RAW values into placeholders BEFORE they leave the gateway
 * (`from_provider_env*` -> `child_env.insert(key, placeholder)`, secrets.rs:177-195) and resolves
 * them to real values only at egress. So a well-behaved gateway's `GetSandboxProviderEnvironment`
 * response carries ONLY placeholders. That "only placeholders" property is INFERRED from secrets.rs,
 * NOT a hard proto contract (proto only says `map<string,string>`), so this slice does NOT trust the
 * backend: it structurally REJECTS any value that is not a placeholder. Agent OS therefore never
 * carries (and never persists) a raw credential, even if the backend misbehaves.
 *
 * Grammar (VERIFIED — `placeholder_for_env_key_for_revision`, secrets.rs:487-493): a conservative
 * allowlist anchored on the shared prefix `openshell:resolve:env:` (secrets.rs:9 `PLACEHOLDER_PREFIX`):
 *   - revision 0   => `openshell:resolve:env:<KEY>`        (NO `v0_` segment)
 *   - revision N>0 => `openshell:resolve:env:v<N>_<KEY>`
 * Both forms MUST be accepted (anchoring only on the `v<rev>_` form would wrongly reject a legitimate
 * revision-0 placeholder and break the happy path); everything else is suspicious => fail-closed.
 */

/** Shared placeholder prefix (secrets.rs:9 `PLACEHOLDER_PREFIX`). */
const PLACEHOLDER_PREFIX = "openshell:resolve:env:";

/**
 * The EXACT SecretResolver placeholder grammar (secrets.rs:487-493), anchored `^…$` on the shared
 * prefix so a marker embedded mid-string (e.g. `prefix-openshell:resolve:env:…-suffix`) is NOT a
 * placeholder and is rejected. `<KEY>` is an env-var name `[A-Za-z0-9_]+`; the optional `v<N>_`
 * revision segment uses a positive integer with no leading zero (`v0_` is never EMITTED by
 * SecretResolver, so it is parsed as part of `<KEY>`, which is harmless — still a placeholder ref).
 */
const PLACEHOLDER_RE = /^openshell:resolve:env:(v[1-9][0-9]*_)?[A-Za-z0-9_]+$/;

/** True iff `value` is a well-formed SecretResolver placeholder (the ONLY accepted provider-env form). */
function isPlaceholder(value: string): boolean {
  return value.startsWith(PLACEHOLDER_PREFIX) && PLACEHOLDER_RE.test(value);
}

/**
 * Fail-closed shape guard. Returns `env` UNCHANGED iff EVERY value is a well-formed placeholder;
 * THROWS on the FIRST value that is not (one suspicious value denies the whole record). The error
 * message NEVER echoes the offending value (it could be a raw credential) — it names only the env KEY,
 * which is not a secret, so the caller can deny without ever logging the value.
 *
 * Unlike exec env (which tolerates plain literals), provider-env is placeholder-ONLY: a plain
 * non-placeholder literal is also rejected, because a well-behaved gateway never emits one here and a
 * misbehaving one might be smuggling a raw value.
 */
export function assertPlaceholderOnly(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isPlaceholder(value)) {
      // Name only the KEY (never the VALUE — it may be a raw secret). Fail-closed.
      throw new Error(
        `openshell provider-env: value for "${key}" is not a placeholder (fail-closed)`,
      );
    }
    out[key] = value;
  }
  return out;
}
