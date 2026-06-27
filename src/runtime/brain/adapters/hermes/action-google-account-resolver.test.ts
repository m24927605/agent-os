/**
 * SLICE-ACT3-live (RED-first) — the REAL {@link AccountResolver} unit tests, FAKE-PROVEN (no real network).
 *
 * `createGoogleAccountResolver(http)` issues a GET to Google's userinfo endpoint via the INJECTED
 * {@link HttpActionTransport} (carrying the same credential placeholder header the descriptor would), parses
 * the JSON `email` field, and returns it. FAIL-CLOSED: any non-2xx, missing/empty email, malformed JSON, or a
 * throwing transport => `undefined` (so the guard treats the account as not-resolvable => deny).
 *
 * The PARSE is proven with a FAKE http returning canned `{"email":"mrfed1913@gmail.com"}` — NO real network.
 */
import { describe, expect, it } from "vitest";
import type { ActionDescriptor } from "./action-closed-loop.js";
import { createGoogleAccountResolver } from "./action-google-account-resolver.js";
import type {
  HttpActionRequest,
  HttpActionResponse,
  HttpActionTransport,
} from "./action-http-transport.js";

const TEST_EMAIL = "mrfed1913@gmail.com";

/** A fake transport that records the request it received and returns a canned response (NO network). */
function fakeHttp(canned: HttpActionResponse | { throws: true }): {
  http: HttpActionTransport;
  requests: HttpActionRequest[];
} {
  const requests: HttpActionRequest[] = [];
  const http: HttpActionTransport = {
    request(req: HttpActionRequest): Promise<HttpActionResponse> {
      requests.push(req);
      if ("throws" in canned) return Promise.reject(new Error("transport blew up (fake)"));
      return Promise.resolve(canned);
    },
  };
  return { http, requests };
}

const descriptor: ActionDescriptor = {
  service: "gmail",
  method: "send",
  params: { to: TEST_EMAIL, subject: "s", body: "b" },
  env: { AGENTOS_GMAIL_OAUTH_KEY: "openshell:resolve:env:AGENTOS_GMAIL_OAUTH_KEY" },
};

describe("ACT3-live createGoogleAccountResolver — userinfo email parse (FAKE http, no network)", () => {
  it("2xx + {email} => resolves that email; the GET hit the userinfo endpoint carrying the placeholder", async () => {
    const { http, requests } = fakeHttp({
      status: 200,
      body: JSON.stringify({ email: TEST_EMAIL, sub: "123" }),
    });
    const resolver = createGoogleAccountResolver(http);
    const account = await resolver.resolveAccount({}, descriptor);
    expect(account).toBe(TEST_EMAIL);
    // Exactly one userinfo GET, carrying the descriptor's credential PLACEHOLDER (never a resolved token).
    expect(requests.length).toBe(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toContain("googleapis.com/oauth2/v3/userinfo");
    const auth = requests[0]?.headers.Authorization ?? "";
    expect(auth.includes("openshell:resolve:env:")).toBe(true);
  });

  it("non-2xx => undefined (fail-closed; guard will deny)", async () => {
    const { http } = fakeHttp({ status: 401, body: "unauthorized" });
    const resolver = createGoogleAccountResolver(http);
    expect(await resolver.resolveAccount({}, descriptor)).toBeUndefined();
  });

  it("2xx but NO email field => undefined", async () => {
    const { http } = fakeHttp({ status: 200, body: JSON.stringify({ sub: "123" }) });
    const resolver = createGoogleAccountResolver(http);
    expect(await resolver.resolveAccount({}, descriptor)).toBeUndefined();
  });

  it("2xx but EMPTY email => undefined", async () => {
    const { http } = fakeHttp({ status: 200, body: JSON.stringify({ email: "" }) });
    const resolver = createGoogleAccountResolver(http);
    expect(await resolver.resolveAccount({}, descriptor)).toBeUndefined();
  });

  it("2xx but malformed JSON body => undefined (parse failure is fail-closed)", async () => {
    const { http } = fakeHttp({ status: 200, body: "{not json" });
    const resolver = createGoogleAccountResolver(http);
    expect(await resolver.resolveAccount({}, descriptor)).toBeUndefined();
  });

  it("a throwing transport => undefined (never throws across the guard boundary)", async () => {
    const { http } = fakeHttp({ throws: true });
    const resolver = createGoogleAccountResolver(http);
    expect(await resolver.resolveAccount({}, descriptor)).toBeUndefined();
  });

  it("a 2xx body with no body string at all => undefined", async () => {
    const { http } = fakeHttp({ status: 200 }); // body undefined
    const resolver = createGoogleAccountResolver(http);
    expect(await resolver.resolveAccount({}, descriptor)).toBeUndefined();
  });
});
