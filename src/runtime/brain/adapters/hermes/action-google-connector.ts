/**
 * SLICE-ACT3a-live-structure — the `GoogleActionConnector` STRUCTURE: it implements the {@link ActionConnector}
 * port by mapping an {@link ActionDescriptor} `{service, method, params, env?}` into a Google REST request
 * (method / url / headers / body), per the DOCUMENTED Google API, and delegating that request to an injected
 * {@link HttpActionTransport}. It is a PURE ADDITION: it touches NOTHING in the ACT1/ACT2 effect, the ACT3a
 * guard, the pipeline, or the authorize edge — and it is NOT wired into the production bin's live deps.
 *
 * Three invariants are baked into the STRUCTURE (each provable against a Fake transport, no network):
 *   - HOST-PIN (substrate-PRIMARY): the host comes from a PER-SERVICE CONSTANT MAP — never from the
 *     descriptor. An unknown `descriptor.service` => refuse and `http.request` is NEVER called. The descriptor
 *     cannot retarget the host (the realization of ACT1's "the connector only ever talks to the host it pinned").
 *   - PER-(service,method) BUILDER: only a registered (service,method) pair builds a request (gmail.send /
 *     drive.read here); an unknown pair => refuse, `http.request` NEVER called (deny-by-default).
 *   - CREDENTIAL-BLIND: the Authorization header carries the descriptor.env PLACEHOLDER VERBATIM (the OAuth
 *     KEY's `openshell:resolve:env:<KEY>` string). The connector NEVER resolves a placeholder into a real
 *     token, NEVER holds a real token, and NEVER logs one. Absent/empty env => NO Authorization header
 *     (unauthenticated-to-allowlisted). The REAL token resolution at egress is EXEC2-class, BLOCKED.
 *
 * FAIL-CLOSED response mapping: a 2xx transport status => `{ok:true}`; any other status => `{ok:false}` with a
 * STATIC detail (status only — the response BODY is NEVER echoed). A thrown/rejected transport => `{ok:false}`.
 *
 * HONEST BOUNDARY: this is the connector STRUCTURE. The REST shapes follow the documented Google API and the
 * Fake transport proves ONLY that the connector BUILDS that shape. The REAL transport (to googleapis.com via
 * egress), the REAL token resolution (OAuth / SecretResolver / EXEC2), the GCP OAuth app, and the real send are
 * BLOCKED (ACT3a-live-real). Connecting an account to claude.ai enables the SESSION's MCP tools — NOT this
 * runtime connector. The REAL {@link HttpActionTransport} (egress to googleapis.com) is deliberately NOT built
 * here; this module ships ONLY the in-repo {@link FakeHttpActionTransport}.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone alongside `action-closed-loop.ts` /
 * `action-guard.ts`; imports ONLY the neutral orchestration type (`MaybePromise`) + the sibling
 * ActionConnector/ActionDescriptor/ActionResult types. No vendor named, no deep cross-module import, NO new
 * dependency (a hand-rolled base64url + an RFC822 string builder — never a package). Re-exported via the
 * hermes barrel.
 */
import type { MaybePromise } from "../../../../orchestration/index.js";
import type { ActionConnector, ActionDescriptor, ActionResult } from "./action-closed-loop.js";

// ------------------------------------------------------------------------------------------------
// HttpActionTransport port + the in-repo FakeHttpActionTransport (NO network).
// ------------------------------------------------------------------------------------------------

/** The request the connector hands the transport — method / url / headers / optional body. PLAIN data. */
export interface HttpActionRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The response the transport returns — a status + optional body. The connector reads ONLY the status. */
export interface HttpActionResponse {
  readonly status: number;
  readonly body?: string;
}

/**
 * The HTTP TRANSPORT port the {@link createGoogleActionConnector} delegates to. An implementation turns a
 * built {@link HttpActionRequest} into a real HTTP exchange. This module ships ONLY the in-repo
 * {@link FakeHttpActionTransport}; the REAL transport (egress to googleapis.com) is ACT3a-live-real (BLOCKED).
 */
export interface HttpActionTransport {
  request(req: HttpActionRequest): MaybePromise<HttpActionResponse>;
}

/** The Fake's default canned response — a 200 (so a happy-path builder test goes green without scripting). */
const DEFAULT_FAKE_HTTP_RESPONSE: HttpActionResponse = { status: 200 };

/**
 * In-repo {@link HttpActionTransport} test double (the mandatory in-tree substrate, modeled on
 * {@link import("./action-closed-loop.js").FakeActionConnector}): RECORDS every {@link HttpActionRequest} it
 * receives and returns a constructor-configurable canned {@link HttpActionResponse} (default 200). NO real
 * network — a pure in-memory record so the connector's request-SHAPE can be proven WITHOUT a live API.
 */
export class FakeHttpActionTransport implements HttpActionTransport {
  readonly requests: HttpActionRequest[] = [];
  private readonly canned: HttpActionResponse;

  constructor(canned: HttpActionResponse = DEFAULT_FAKE_HTTP_RESPONSE) {
    this.canned = canned;
  }

  request(req: HttpActionRequest): HttpActionResponse {
    this.requests.push(req);
    return this.canned;
  }
}

// ------------------------------------------------------------------------------------------------
// HOST PIN — the per-service constant map. The host is NEVER taken from the descriptor (substrate-PRIMARY).
// ------------------------------------------------------------------------------------------------

/**
 * The PER-SERVICE host pin. The host the connector ever talks to is read from THIS map keyed by the
 * descriptor's `service` — it is NEVER derived from the descriptor's content. A `service` not present here
 * has NO pinned host => refuse before any request (the descriptor cannot retarget the host).
 */
const SERVICE_HOST_PIN: Readonly<Record<string, string>> = {
  gmail: "gmail.googleapis.com",
  drive: "www.googleapis.com",
  calendar: "www.googleapis.com",
};

/** STATIC refusal reasons — credential-blind (never echo the descriptor params, env, or a response body). */
const REFUSE_UNSUPPORTED_SERVICE = "unsupported action service";
const REFUSE_UNSUPPORTED_METHOD = "unsupported action method";

// ------------------------------------------------------------------------------------------------
// base64url + RFC822 — hand-rolled (NO new dependency). url-safe, no padding.
// ------------------------------------------------------------------------------------------------

/**
 * Encode a UTF-8 string as base64url (url-safe alphabet, NO padding) — exactly the encoding the Gmail API v1
 * `messages.send` `raw` field requires. Hand-rolled over Node's Buffer (a runtime built-in, NOT a new
 * dependency): standard base64, then `+`->`-`, `/`->`_`, and strip the `=` padding.
 */
function base64UrlEncode(utf8: string): string {
  return Buffer.from(utf8, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Build a minimal, well-formed RFC822 message from `to`/`subject`/`body`. Header lines are CRLF-separated,
 * a blank CRLF line separates the headers from the body. Shape per Google Gmail API v1 docs
 * (`users.messages.send` consumes a base64url-encoded RFC822 message); live acceptance is BLOCKED
 * (ACT3a-live-real) — the Fake transport proves ONLY that the connector BUILDS this shape.
 */
function buildRfc822(to: string, subject: string, body: string): string {
  const headers = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=UTF-8"];
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

// ------------------------------------------------------------------------------------------------
// Per-(service,method) request builders — DOCUMENTED Google REST shapes. The host is the PINNED host
// passed in (never the descriptor's). A builder returns a request WITHOUT credential headers; the auth
// header is added uniformly afterward from descriptor.env (credential-blind).
// ------------------------------------------------------------------------------------------------

/** What a builder yields before the uniform Authorization step is applied — method / url / optional body. */
interface BuiltRequest {
  readonly method: string;
  readonly url: string;
  readonly body?: string;
}

/**
 * Build a `gmail.send` request per the documented Gmail API v1: `POST https://<host>/gmail/v1/users/me/
 * messages/send` with a JSON body `{ raw: base64url(RFC822) }`. The RFC822 message is assembled from the
 * declared `to`/`subject`/`body` params (already STRICT-validated by the ACT1 binding). `host` is the PINNED
 * Gmail host — never the descriptor's. (Shape per Google Gmail API v1 docs; live acceptance is BLOCKED.)
 */
function buildGmailSend(host: string, params: Record<string, unknown>): BuiltRequest {
  const to = String(params.to ?? "");
  const subject = String(params.subject ?? "");
  const body = String(params.body ?? "");
  const raw = base64UrlEncode(buildRfc822(to, subject, body));
  return {
    method: "POST",
    url: `https://${host}/gmail/v1/users/me/messages/send`,
    body: JSON.stringify({ raw }),
  };
}

/**
 * Build a `drive.read` request per the documented Drive API v3: `GET https://<host>/drive/v3/files/
 * <encodeURIComponent(fileId)>?alt=media`. `host` is the PINNED Drive host — never the descriptor's. The
 * `fileId` is `encodeURIComponent`-escaped so it stays in the path segment (it cannot inject a host/path).
 */
function buildDriveRead(host: string, params: Record<string, unknown>): BuiltRequest {
  const fileId = String(params.fileId ?? "");
  return {
    method: "GET",
    url: `https://${host}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
  };
}

/** The registered per-(service,method) builders. An unregistered key => no builder => refuse (deny-by-default). */
const REQUEST_BUILDERS: Readonly<
  Record<string, (host: string, params: Record<string, unknown>) => BuiltRequest>
> = {
  "gmail.send": buildGmailSend,
  "drive.read": buildDriveRead,
};

// ------------------------------------------------------------------------------------------------
// Credential — read the PLACEHOLDER from descriptor.env (the connector NEVER resolves/holds a real token).
// ------------------------------------------------------------------------------------------------

/**
 * Derive the Authorization header VALUE from the descriptor's credential env — the PLACEHOLDER VERBATIM. The
 * connector is credential-BLIND: it forwards `"Bearer " + <the single placeholder value>` and NEVER resolves
 * it into a real token. An absent/empty env => `undefined` (NO Authorization header). When multiple env keys
 * are present the FIRST non-empty value is used (the composer builds a single per-service credential KEY).
 */
function authorizationFromEnv(
  env: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (env === undefined) return undefined;
  for (const value of Object.values(env)) {
    if (typeof value === "string" && value.length > 0) {
      // The VALUE is a placeholder (`openshell:resolve:env:<KEY>`), never a real token. The connector just
      // forwards it — the real resolution at egress is EXEC2-class (BLOCKED).
      return `Bearer ${value}`;
    }
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------
// createGoogleActionConnector — the ActionConnector that maps a descriptor to a pinned Google REST request.
// ------------------------------------------------------------------------------------------------

/**
 * Create a {@link GoogleActionConnector}: an {@link ActionConnector} that maps an {@link ActionDescriptor}
 * into a Google REST request and delegates it to the injected {@link HttpActionTransport}.
 *
 * `invoke(context, descriptor)`:
 *   1. HOST-PIN: look up `SERVICE_HOST_PIN[descriptor.service]`. UNKNOWN service => `{ok:false, detail:<static
 *      "unsupported action service">}` and `http.request` is NEVER called (the descriptor cannot retarget the
 *      host).
 *   2. BUILDER: look up `REQUEST_BUILDERS["<service>.<method>"]`. UNKNOWN pair => `{ok:false, detail:<static>}`,
 *      `http.request` NEVER called (deny-by-default). Build the request against the PINNED host.
 *   3. CREDENTIAL: derive the Authorization header from `descriptor.env` (the placeholder, VERBATIM). No env
 *      => no Authorization header. The connector NEVER resolves/holds a real token.
 *   4. DELEGATE to `http.request(...)` inside try/catch; map the response: 2xx => `{ok:true}`; else =>
 *      `{ok:false, detail:<static, status only — NO body echoed>}`; a thrown/rejected transport => `{ok:false}`
 *      (FAIL-CLOSED).
 *
 * Pure over `http` + the constant pin/builders; adds NO dependency; does NOT touch the pipeline / guard / ACT1
 * effect. Wrap it with `createGuardedActionConnector` in composition (the guard is the live-safety ring).
 */
export function createGoogleActionConnector(http: HttpActionTransport): ActionConnector {
  return {
    async invoke(_context: unknown, descriptor: ActionDescriptor): Promise<ActionResult> {
      // (1) HOST-PIN — the host is read from the per-service constant map, NEVER from the descriptor. An
      // unknown service has no pinned host => refuse BEFORE building/sending (http.request never called).
      // OWN-PROPERTY only (`Object.hasOwn`): a PROTOTYPE-CHAIN key (`constructor`/`__proto__`/`toString`/…)
      // must NOT resolve to an inherited member of the plain-object map — defense-in-depth so gate 1 alone
      // refuses every non-pinned service (not relying on gate 2's catch). The descriptor cannot retarget.
      if (!Object.hasOwn(SERVICE_HOST_PIN, descriptor.service)) {
        return { ok: false, detail: REFUSE_UNSUPPORTED_SERVICE };
      }
      const host = SERVICE_HOST_PIN[descriptor.service] as string;

      // (2) BUILDER — only a registered (service,method) pair builds a request. An unknown pair => refuse
      // (http.request never called). OWN-PROPERTY only, mirroring gate 1. The builder receives the PINNED
      // host (not the descriptor's).
      const builderKey = `${descriptor.service}.${descriptor.method}`;
      if (!Object.hasOwn(REQUEST_BUILDERS, builderKey)) {
        return { ok: false, detail: REFUSE_UNSUPPORTED_METHOD };
      }
      const builder = REQUEST_BUILDERS[builderKey] as (
        host: string,
        params: Record<string, unknown>,
      ) => BuiltRequest;
      const built = builder(host, descriptor.params);

      // (3) CREDENTIAL — the Authorization header carries the descriptor.env PLACEHOLDER VERBATIM. The
      // connector NEVER resolves a placeholder into a token; absent env => no Authorization header.
      const authorization = authorizationFromEnv(descriptor.env);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(authorization !== undefined ? { Authorization: authorization } : {}),
      };

      // (4) DELEGATE + map the response, FAIL-CLOSED. A throw/reject => {ok:false}; a non-2xx => {ok:false}
      // with a STATIC status-only detail (the response BODY is NEVER echoed — it could carry server PII).
      try {
        const response = await http.request({
          method: built.method,
          url: built.url,
          headers,
          ...(built.body !== undefined ? { body: built.body } : {}),
        });
        if (response.status >= 200 && response.status < 300) {
          return { ok: true };
        }
        return { ok: false, detail: `google action http status ${response.status}` };
      } catch {
        // The connector must never throw across the effect boundary — fail closed.
        return { ok: false, detail: "google action transport error (fail-closed)" };
      }
    },
  };
}
