/**
 * SLICE-ACT3a-live-structure (RED-first) — the `GoogleActionConnector` STRUCTURE: it maps an
 * {@link ActionDescriptor} into a Google REST request (method/url/headers/body) per the DOCUMENTED Google
 * API, with the host PER-SERVICE PINNED (a constant map — the descriptor CANNOT retarget the host), the
 * credential carried as the PLACEHOLDER only (the connector NEVER holds/synthesizes a real token), and the
 * response mapped fail-closed. It proves the connector against a {@link FakeHttpActionTransport} (NO real
 * network / OAuth / token) — the Fake records every request + returns a canned `{status, body?}`.
 *
 * HONEST BOUNDARY (restated in the slice doc): this is the connector STRUCTURE. The Google REST shapes
 * follow the documented API and the Fake transport proves ONLY that the connector BUILDS that shape. The
 * REAL network to googleapis.com (via egress), the REAL token resolution (OAuth / SecretResolver / EXEC2),
 * the GCP OAuth app, and the real send are BLOCKED (ACT3a-live-real). This file asserts SHAPE + invariants,
 * never live acceptance.
 *
 * Invariants proven here:
 *   - HOST-PIN (substrate-PRIMARY): the host is taken from a per-service constant map; an unknown service =>
 *     refuse and the transport is NEVER called. NON-VACUITY: a mutant that derives the host from the
 *     descriptor instead of the pin flips the unknown-service test RED.
 *   - per-(service,method) BUILDER: gmail.send -> POST .../messages/send with a base64url RFC822 body;
 *     drive.read -> GET .../files/<id>?alt=media; an unknown (service,method) => refuse, transport NEVER called.
 *   - CREDENTIAL-BLIND: Authorization carries the PLACEHOLDER value from descriptor.env, never a real token;
 *     a real-token-shaped / canary value placed in env is forwarded VERBATIM (the connector does not resolve
 *     it) and never appears beyond what the descriptor supplied.
 *   - DENY-BY-DEFAULT through the guard: createGuardedActionConnector(google, {live:false}) => refuse, the
 *     GoogleActionConnector + transport NEVER called; live + an allowlisted test account => reaches the
 *     connector => transport called once.
 *   - FAIL-CLOSED: a transport throw => {ok:false}; a non-2xx (e.g. 403) => {ok:false}, no body echoed.
 */
import { describe, expect, it } from "vitest";
import type { ActionConnector, ActionDescriptor } from "./action-closed-loop.js";
import {
  FakeHttpActionTransport,
  type HttpActionRequest,
  type HttpActionTransport,
  createGoogleActionConnector,
} from "./action-google-connector.js";
import { FakeAccountResolver, createGuardedActionConnector } from "./action-guard.js";

const ctx = { actorId: "agent:hermes", tenantId: "tenant-a", taskId: "task-1" };

/** The credential PLACEHOLDER the composer would build (`openshell:resolve:env:<KEY>`). NOT a real token. */
const GMAIL_PLACEHOLDER = "openshell:resolve:env:AGENTOS_GMAIL_OAUTH_KEY";

/** A gmail.send descriptor with the placeholder credential env (as bindingWrappedActionEffect would build). */
const gmailSendDescriptor: ActionDescriptor = {
  service: "gmail",
  method: "send",
  params: { to: "someone@example.com", subject: "Subject Line", body: "Hello there body." },
  env: { AGENTOS_GMAIL_OAUTH_KEY: GMAIL_PLACEHOLDER },
};

/** A drive.read descriptor (no credential env => unauthenticated-to-allowlisted; no Authorization header). */
const driveReadDescriptor: ActionDescriptor = {
  service: "drive",
  method: "read",
  params: { fileId: "abc 123/weird?id" },
};

/**
 * A runtime-BUILT string that LOOKS like a leaked OAuth/Bearer token canary. NOT a source secret (assembled
 * at runtime from fragments so the repo's secret-scan stays clean). Used to prove the connector forwards
 * ONLY what the descriptor supplied and never synthesizes/leaks a real token.
 */
function canaryToken(): string {
  return ["ya29", ".", "A0CANARY", "-", "z".repeat(20)].join("");
}

/** Decode a base64url (no padding) string to a UTF-8 string (test-side, mirrors the connector's encode). */
function decodeBase64Url(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, "base64").toString("utf8");
}

// ==================================================================================================
// RED1 — gmail.send: the transport receives the DOCUMENTED POST; body parses to {raw:<base64url>} whose
// decode is an RFC822 message carrying to/subject/body; Authorization carries the placeholder.
// ==================================================================================================
describe("createGoogleActionConnector — gmail.send request builder (documented Gmail API v1)", () => {
  it("POSTs to gmail.googleapis.com/.../messages/send with a base64url RFC822 body + placeholder auth", async () => {
    const http = new FakeHttpActionTransport();
    const connector = createGoogleActionConnector(http);

    const result = await connector.invoke(ctx, gmailSendDescriptor);

    expect(result.ok).toBe(true);
    expect(http.requests.length).toBe(1);
    const req = http.requests[0] as HttpActionRequest;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");

    // Body is {raw: <base64url>} and the decoded raw is an RFC822 message with to/subject/body.
    const parsed = JSON.parse(req.body ?? "") as { raw: string };
    expect(typeof parsed.raw).toBe("string");
    // base64url (url-safe, no padding): contains no '+' '/' '='.
    expect(parsed.raw).not.toMatch(/[+/=]/);
    const rfc822 = decodeBase64Url(parsed.raw);
    expect(rfc822).toContain("To: someone@example.com");
    expect(rfc822).toContain("Subject: Subject Line");
    expect(rfc822).toContain("Hello there body.");

    // Authorization carries the PLACEHOLDER value (never a real token).
    expect(req.headers.Authorization).toContain(GMAIL_PLACEHOLDER);
  });
});

// ==================================================================================================
// RED2 — drive.read: GET www.googleapis.com/drive/v3/files/<encoded id>?alt=media.
// ==================================================================================================
describe("createGoogleActionConnector — drive.read request builder (documented Drive API v3)", () => {
  it("GETs www.googleapis.com/drive/v3/files/<encodeURIComponent(fileId)>?alt=media", async () => {
    const http = new FakeHttpActionTransport();
    const connector = createGoogleActionConnector(http);

    const result = await connector.invoke(ctx, driveReadDescriptor);

    expect(result.ok).toBe(true);
    expect(http.requests.length).toBe(1);
    const req = http.requests[0] as HttpActionRequest;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent("abc 123/weird?id")}?alt=media`,
    );
    // No credential env => no Authorization header (unauthenticated-to-allowlisted).
    expect(req.headers.Authorization).toBeUndefined();
  });
});

// ==================================================================================================
// RED3 — HOST-PIN (substrate-PRIMARY): an unknown service => refuse, transport NEVER called. The descriptor
// CANNOT retarget the host. NON-VACUITY: a mutant deriving the host from descriptor.service flips this RED.
// ==================================================================================================
describe("createGoogleActionConnector — host pin (unknown service => refuse, transport NEVER called)", () => {
  it('descriptor.service="evil" => refuse, FakeHttpActionTransport NEVER called', async () => {
    const http = new FakeHttpActionTransport();
    const connector = createGoogleActionConnector(http);

    const result = await connector.invoke(ctx, {
      service: "evil",
      method: "send",
      params: {},
      env: { AGENTOS_GMAIL_OAUTH_KEY: GMAIL_PLACEHOLDER },
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("unsupported action service");
    expect(http.requests.length).toBe(0);
  });

  it('descriptor.service="http://attacker" (a host-shaped string) => refuse, transport NEVER called', async () => {
    const http = new FakeHttpActionTransport();
    const connector = createGoogleActionConnector(http);

    const result = await connector.invoke(ctx, {
      service: "http://attacker",
      method: "read",
      params: { fileId: "x" },
    });

    expect(result.ok).toBe(false);
    expect(http.requests.length).toBe(0);
  });

  it('a prototype-chain key as service ("constructor"/"__proto__"/"toString") => refuse at the SERVICE gate, transport NEVER called', async () => {
    // Defense-in-depth: the host-pin lookup must be OWN-PROPERTY only — a prototype-chain key must NOT
    // resolve to an inherited member (Object.prototype.constructor/toString are truthy on a plain object).
    // Each such service has NO pinned host => refuse at gate 1 with the SERVICE reason (NOT gate 2's method
    // reason), and the transport is NEVER called. This pins gate 1 specifically, not gate 2's catch.
    for (const evilService of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
    ]) {
      const http = new FakeHttpActionTransport();
      const connector = createGoogleActionConnector(http);

      const result = await connector.invoke(ctx, {
        service: evilService,
        method: "send",
        params: {},
      });

      expect(result.ok).toBe(false);
      expect(result.detail).toBe("unsupported action service");
      expect(http.requests.length).toBe(0);
    }
  });
});

// ==================================================================================================
// RED4 — unknown (service,method) pair => refuse, transport NEVER called (deny-by-default).
// ==================================================================================================
describe("createGoogleActionConnector — unknown method (deny-by-default)", () => {
  it("a known service + unknown method => refuse, transport NEVER called", async () => {
    const http = new FakeHttpActionTransport();
    const connector = createGoogleActionConnector(http);

    const result = await connector.invoke(ctx, {
      service: "gmail",
      method: "deleteEverything",
      params: {},
      env: { AGENTOS_GMAIL_OAUTH_KEY: GMAIL_PLACEHOLDER },
    });

    expect(result.ok).toBe(false);
    expect(http.requests.length).toBe(0);
  });
});

// ==================================================================================================
// RED5 — CREDENTIAL-BLIND: Authorization is the PLACEHOLDER the descriptor supplied; a real-token-shaped /
// canary value is forwarded VERBATIM (the connector never resolves/synthesizes a token), and a canary in the
// descriptor NEVER appears in the transport request beyond what the descriptor itself carried.
// ==================================================================================================
describe("createGoogleActionConnector — credential-blind (placeholder-only; never holds a real token)", () => {
  it("Authorization header value derives ONLY from the descriptor's placeholder (not a synthesized token)", async () => {
    const http = new FakeHttpActionTransport();
    const connector = createGoogleActionConnector(http);

    await connector.invoke(ctx, gmailSendDescriptor);

    const req = http.requests[0] as HttpActionRequest;
    // The Authorization value is the placeholder itself (optionally with a "Bearer " prefix) — never a token.
    expect(req.headers.Authorization).toContain(GMAIL_PLACEHOLDER);
    expect(req.headers.Authorization?.replace("Bearer ", "")).toBe(GMAIL_PLACEHOLDER);
  });

  it("a real-token-shaped value injected into env is forwarded VERBATIM (connector does not synthesize)", async () => {
    const http = new FakeHttpActionTransport();
    const connector = createGoogleActionConnector(http);
    const canary = canaryToken();

    await connector.invoke(ctx, {
      service: "gmail",
      method: "send",
      params: { to: "a@b.c", subject: "s", body: "b" },
      // The connector is credential-BLIND: it forwards whatever value the descriptor.env carries. It NEVER
      // resolves a placeholder into a token, so a canary placed here is the ONLY place it could appear.
      env: { AGENTOS_GMAIL_OAUTH_KEY: canary },
    });

    const req = http.requests[0] as HttpActionRequest;
    // The connector forwarded exactly what it was given (no synthesis). It still appears NOWHERE except the
    // single Authorization header the connector built from the supplied env value.
    expect(req.headers.Authorization).toContain(canary);
    expect(req.url).not.toContain(canary);
    expect(req.body ?? "").not.toContain(canary);
    expect(req.method).not.toContain(canary);
  });
});

// ==================================================================================================
// RED6 — through the GUARD (ACT3a-guard): live-off => refuse, GoogleActionConnector + transport NEVER
// called; live-on + allowlisted test account => reaches the connector => transport called once.
// ==================================================================================================
describe("createGuardedActionConnector(googleConnector, config) — guard gating", () => {
  it("live:false => refuse, the GoogleActionConnector + transport NEVER called", async () => {
    const http = new FakeHttpActionTransport();
    const google = createGoogleActionConnector(http);
    const guarded = createGuardedActionConnector(google, {
      live: false,
      testAccounts: ["test@x"],
      resolveAccount: new FakeAccountResolver("test@x"),
    });

    const result = await guarded.invoke(ctx, gmailSendDescriptor);

    expect(result.ok).toBe(false);
    expect(http.requests.length).toBe(0);
  });

  it('live:true + testAccounts=["test@x"] + resolver->"test@x" => reaches the connector => transport called once', async () => {
    const http = new FakeHttpActionTransport();
    const google = createGoogleActionConnector(http);
    const guarded = createGuardedActionConnector(google, {
      live: true,
      testAccounts: ["test@x"],
      resolveAccount: new FakeAccountResolver("test@x"),
    });

    const result = await guarded.invoke(ctx, gmailSendDescriptor);

    expect(result.ok).toBe(true);
    expect(http.requests.length).toBe(1);
  });
});

// ==================================================================================================
// RED7 — FAIL-CLOSED: a transport throw => {ok:false}; a non-2xx (e.g. 403) => {ok:false} with no body echoed.
// ==================================================================================================
describe("createGoogleActionConnector — fail-closed response mapping", () => {
  it("a transport that THROWS => {ok:false} (fail-closed; never crashes the loop)", async () => {
    const throwing: HttpActionTransport = {
      request() {
        throw new Error("transport boom");
      },
    };
    const connector = createGoogleActionConnector(throwing);

    const result = await connector.invoke(ctx, driveReadDescriptor);

    expect(result.ok).toBe(false);
  });

  it("a non-2xx status (403) => {ok:false}, and the response BODY is NOT echoed into detail", async () => {
    const secretBody = "FORBIDDEN: secret-detail-do-not-echo-7f3a";
    const http = new FakeHttpActionTransport({ status: 403, body: secretBody });
    const connector = createGoogleActionConnector(http);

    const result = await connector.invoke(ctx, driveReadDescriptor);

    expect(result.ok).toBe(false);
    expect(result.detail ?? "").not.toContain(secretBody);
    // The request WAS attempted (it is a real refusal from the server, not a pre-flight deny).
    expect(http.requests.length).toBe(1);
  });

  it("a 2xx status (200) => {ok:true}", async () => {
    const http = new FakeHttpActionTransport({ status: 200, body: "{}" });
    const connector = createGoogleActionConnector(http);

    const result = await connector.invoke(ctx, driveReadDescriptor);

    expect(result.ok).toBe(true);
  });
});

// ==================================================================================================
// RED8 — port contracts: the connector satisfies ActionConnector; the Fake transport satisfies the port.
// ==================================================================================================
describe("HttpActionTransport port + FakeHttpActionTransport + ActionConnector conformance", () => {
  it("createGoogleActionConnector returns an ActionConnector", () => {
    const connector: ActionConnector = createGoogleActionConnector(new FakeHttpActionTransport());
    expect(typeof connector.invoke).toBe("function");
  });

  it("FakeHttpActionTransport records every request and returns its canned response (default 200)", async () => {
    const http: HttpActionTransport = new FakeHttpActionTransport();
    const res = await http.request({ method: "GET", url: "https://x", headers: {} });
    expect(res.status).toBe(200);
    expect((http as FakeHttpActionTransport).requests.length).toBe(1);
  });
});
