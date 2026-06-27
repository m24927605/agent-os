/**
 * SLICE-ACT3-live — the REAL {@link AccountResolver}: resolves the ACTING Google account (the authenticated
 * mailbox the connector would send AS) by issuing a GET to Google's OpenID userinfo endpoint via the injected
 * {@link HttpActionTransport}, then parsing the JSON `email`. The resolved email is the value the ACT3a guard
 * compares against `AGENTOS_ACTION_TEST_ACCOUNT` (the test-account allowlist) — so the guard can only ever let
 * the connector act on an allowlisted account.
 *
 * The GET carries the SAME credential placeholder header the descriptor carries (`descriptor.env`) —
 * credential-blind here: the resolver forwards the placeholder VERBATIM; the REAL transport resolves it at
 * egress (the single resolution point). This resolver NEVER holds or logs a real token.
 *
 * FAIL-CLOSED (every non-happy path => `undefined`, which the guard treats as not-resolvable => deny):
 *   - a non-2xx userinfo response;
 *   - a 2xx with no `email` / an empty `email`;
 *   - a malformed JSON body / no body;
 *   - a throwing/rejecting transport.
 *
 * The PARSE is fully testable with a Fake http returning canned `{"email":"..."}` — NO real network in tests.
 * The real userinfo GET fires ONLY when wired to the real transport in the operator runner.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone alongside action-guard.ts / the transport;
 * imports ONLY the sibling AccountResolver / ActionDescriptor / HTTP transport types. No new dependency.
 * Re-exported via the hermes barrel.
 */
import type { ActionDescriptor } from "./action-closed-loop.js";
import type { AccountResolver } from "./action-guard.js";
import type { HttpActionTransport } from "./action-http-transport.js";

/** Google's OpenID Connect userinfo endpoint — returns the authenticated user's `{ email, sub, ... }`. */
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/**
 * Derive the credential PLACEHOLDER Authorization header from the descriptor's env. Mirrors the connector's
 * `authorizationFromEnv`: the FIRST non-empty env value (a placeholder) becomes `"Bearer <placeholder>"`. The
 * resolver is credential-BLIND — it forwards the placeholder VERBATIM (the transport resolves it at egress).
 * Absent/empty env => no Authorization header (the userinfo GET will then 401 => undefined => guard denies).
 */
function authorizationFromDescriptor(descriptor: ActionDescriptor): Record<string, string> {
  const env = descriptor.env;
  if (env === undefined) return {};
  for (const value of Object.values(env)) {
    if (typeof value === "string" && value.length > 0) {
      return { Authorization: `Bearer ${value}` };
    }
  }
  return {};
}

/**
 * Create the REAL {@link AccountResolver} over an injected {@link HttpActionTransport}. `resolveAccount`:
 *   1. build a GET to {@link USERINFO_URL} carrying the descriptor's credential PLACEHOLDER (Authorization);
 *   2. delegate to `http.request(...)` inside try/catch — a throw/reject => `undefined` (fail-closed);
 *   3. a non-2xx => `undefined`; a 2xx => `JSON.parse(body)` (fail-closed on malformed JSON / no body) and
 *      return a non-empty string `email`, else `undefined`.
 *
 * Pure over `http`; adds NO dependency; never holds/logs a real token (only the placeholder rides outbound).
 */
export function createGoogleAccountResolver(http: HttpActionTransport): AccountResolver {
  return {
    async resolveAccount(
      _context: unknown,
      descriptor: ActionDescriptor,
    ): Promise<string | undefined> {
      try {
        const response = await http.request({
          method: "GET",
          url: USERINFO_URL,
          headers: {
            Accept: "application/json",
            ...authorizationFromDescriptor(descriptor),
          },
        });
        if (response.status < 200 || response.status >= 300) {
          return undefined; // fail-closed: a non-2xx userinfo => not resolvable => guard denies.
        }
        if (typeof response.body !== "string" || response.body.length === 0) {
          return undefined;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(response.body);
        } catch {
          return undefined; // malformed JSON => fail-closed.
        }
        const email = (parsed as { email?: unknown } | null)?.email;
        if (typeof email === "string" && email.length > 0) {
          return email;
        }
        return undefined; // no/empty email => fail-closed.
      } catch {
        // Never throw across the guard boundary — an unresolvable account fails closed (=> deny).
        return undefined;
      }
    },
  };
}
