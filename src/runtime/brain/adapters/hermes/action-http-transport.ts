/**
 * SLICE-ACT3-live — the REAL {@link HttpActionTransport}: the runtime-direct ACTOR at the network egress
 * boundary. It implements the ACT3a `HttpActionTransport` port by (1) resolving the credential PLACEHOLDER
 * (`openshell:resolve:env:<KEY>`) into a real token FROM ENV — the single, last-mile resolution point — and
 * (2) issuing the HTTP exchange via Node's built-in global `fetch`. PURE ADDITION: it touches NOTHING in the
 * pipeline / guard / ACT1/ACT2/ACT3a connector logic — those see ONLY the placeholder; this transport is the
 * ONE place the real token is read, and only at egress.
 *
 * HONEST BOUNDARY (runtime-direct posture): the runner process resolves + holds the token at egress to call
 * Google. This is credential-blind-to-brain/audit/WORM/projection (only THIS actor resolves the placeholder),
 * which is the reasonable, honest first live path for a throwaway test account. The PRODUCTION-strongest
 * posture is a sandbox SecretResolver (EXEC2) where the runtime never holds the token at all.
 *
 * Two surfaces, with the egress strictly separated from the verify gate:
 *   - {@link resolveCredentialHeaders} — PURE, TESTABLE, NO network. Resolves the placeholder against an env
 *     map; FAILS CLOSED (returns an error, so the transport never calls fetch) when the env value is
 *     missing/empty. The resolved token is NEVER logged or echoed in any error.
 *   - {@link createHttpActionTransport}`.request` — resolve creds (fail-closed on error => a non-2xx WITHOUT
 *     calling fetch); else `fetch(url, {method, headers, body})` => `{status, body}`. The `fetch` call is
 *     LIVE-ONLY: it defaults to `globalThis.fetch` but the unit tests INJECT a fake fetch, so vitest NEVER
 *     touches the network. The real `globalThis.fetch` is exercised ONLY by the operator-run runner.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone alongside action-google-connector.ts; imports
 * ONLY the sibling transport port types + the neutral orchestration type. No new dependency — Node's built-in
 * global `fetch` (engines.node >= 22). Re-exported via the hermes barrel.
 */
import type { MaybePromise } from "../../../../orchestration/index.js";
import type {
  HttpActionRequest,
  HttpActionResponse,
  HttpActionTransport,
} from "./action-google-connector.js";

// Re-export the port shapes so the transport's siblings (the account resolver, the runner) can import the
// HTTP types from this module without reaching back into the connector module for the same contract.
export type { HttpActionRequest, HttpActionResponse, HttpActionTransport };

/**
 * The placeholder grammar the transport resolves — OpenShell's `openshell:resolve:env:<KEY>` (mirrors
 * `placeholderForKey`'s output). A LOCAL constant copy (NOT imported) so the adapter never deep-imports a
 * non-barrel internal; this string IS the cross-boundary contract.
 */
const PLACEHOLDER_PREFIX = "openshell:resolve:env:";

/** The successful resolution result — the headers with every placeholder replaced by its real value. */
export interface ResolvedHeaders {
  readonly headers: Readonly<Record<string, string>>;
}

/** The fail-closed result — a STATIC reason (NEVER a resolved value / env-derived string). */
export interface ResolveCredentialError {
  readonly error: string;
}

/**
 * Resolve credential placeholders in a header map against `env` — PURE, NO network. For each header VALUE:
 *   - a value that IS (or, after an optional leading `"Bearer "`, contains) `openshell:resolve:env:<KEY>` is
 *     resolved: `env[KEY]` must be a NON-EMPTY string, else => {@link ResolveCredentialError} (FAIL-CLOSED —
 *     the transport must NOT call fetch). The resolved value re-applies the `"Bearer "` prefix iff it was
 *     present, so `"Bearer openshell:resolve:env:K"` => `"Bearer <token>"` and a bare placeholder => `<token>`.
 *   - a NON-placeholder value passes through VERBATIM.
 *
 * CREDENTIAL-BLIND: this is the ONLY place a real token is materialized (from env, the actor at egress). The
 * error path is a STATIC string — it NEVER includes the KEY's value or any env-derived text.
 */
export function resolveCredentialHeaders(
  headers: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedHeaders | ResolveCredentialError {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    // Allow an optional `"Bearer "` prefix in front of the placeholder.
    const bearerPrefix = "Bearer ";
    const hasBearer = value.startsWith(bearerPrefix);
    const inner = hasBearer ? value.slice(bearerPrefix.length) : value;

    if (inner.startsWith(PLACEHOLDER_PREFIX)) {
      const key = inner.slice(PLACEHOLDER_PREFIX.length);
      const resolved = env[key];
      if (typeof resolved !== "string" || resolved.length === 0) {
        // FAIL-CLOSED: a missing/empty env value => error (static reason; NEVER echo the value). The KEY
        // name is the operator's OWN config (not a secret), but to be conservative we do not echo it either.
        return { error: "credential placeholder could not be resolved from env (fail-closed)" };
      }
      out[name] = hasBearer ? `${bearerPrefix}${resolved}` : resolved;
    } else {
      out[name] = value;
    }
  }
  return { headers: out };
}

/** The minimal `fetch` surface the transport needs — a subset of the global `fetch` signature. */
export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => MaybePromise<{ status: number; text: () => MaybePromise<string> }>;

/** Options for {@link createHttpActionTransport}. */
export interface HttpActionTransportOptions {
  /** The env the transport resolves credential placeholders against (typically `process.env`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * The fetch implementation. DEFAULTS to Node's built-in `globalThis.fetch` (LIVE — used only by the
   * operator runner). Unit tests INJECT a fake so vitest NEVER hits the network.
   */
  readonly fetchImpl?: FetchImpl;
}

/** A status that maps to `{ok:false}` upstream without echoing any body — the fail-closed sentinel. */
const FAIL_CLOSED_STATUS = 0;

/**
 * Create the REAL {@link HttpActionTransport}. `request(req)`:
 *   1. {@link resolveCredentialHeaders} against `opts.env`. On error => return `{status:0}` (a non-2xx the
 *      connector maps to `{ok:false}`) WITHOUT calling fetch (FAIL-CLOSED — no token, no egress).
 *   2. else `fetch(url, {method, headers, body})` => `{status, body: await text}`. A thrown/rejected fetch is
 *      caught and mapped to `{status:0}` (the transport never throws across the effect boundary).
 *
 * ⚠️ The `fetch` call is LIVE-ONLY (default `globalThis.fetch`). vitest injects a fake `fetchImpl`, so no test
 * touches the network. The resolved token is NEVER logged.
 */
export function createHttpActionTransport(opts: HttpActionTransportOptions): HttpActionTransport {
  const doFetch: FetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);

  return {
    async request(req: HttpActionRequest): Promise<HttpActionResponse> {
      const resolved = resolveCredentialHeaders(req.headers, opts.env);
      if ("error" in resolved) {
        // FAIL-CLOSED: the credential could not be materialized => never call fetch.
        return { status: FAIL_CLOSED_STATUS };
      }
      try {
        const response = await doFetch(req.url, {
          method: req.method,
          headers: { ...resolved.headers },
          ...(req.body !== undefined ? { body: req.body } : {}),
        });
        const body = await response.text();
        return { status: response.status, body };
      } catch {
        // Never throw across the boundary — a network/fetch error is a fail-closed non-2xx.
        return { status: FAIL_CLOSED_STATUS };
      }
    },
  };
}
