/**
 * SLICE-ACT3-live (RED-first) — the REAL {@link HttpActionTransport} unit tests, FAKE-PROVEN (no real
 * network). Two surfaces under test:
 *   - `resolveCredentialHeaders(headers, env)` — PURE. The ONLY place a placeholder
 *     (`openshell:resolve:env:<KEY>`, optionally `"Bearer "`-prefixed) is resolved against env. A missing
 *     /empty env value FAILS CLOSED (returns an error; the transport must NOT call fetch). A non-placeholder
 *     header passes verbatim.
 *   - `createHttpActionTransport({ env, fetchImpl })`.request(req) — with an INJECTED fake fetch (NEVER the
 *     global): 2xx => the response; non-2xx => the response (mapped to ok:false upstream by the connector);
 *     a credential-resolution error => the transport returns a non-2xx WITHOUT calling fetch (fail-closed).
 *
 * NON-VACUITY: a mutation that SKIPS the missing-env fail-closed (resolves to `""` and proceeds) flips the
 * "missing env => error, fetch NOT called" test RED.
 *
 * No real network anywhere: the fetch is always the injected fake. The real `globalThis.fetch` is exercised
 * ONLY by the operator-run runner (scripts/act-live-gmail.mjs), never by vitest.
 */
import { describe, expect, it } from "vitest";
import { createHttpActionTransport, resolveCredentialHeaders } from "./action-http-transport.js";

/** A runtime-built OAuth-shaped canary token (NOT a source literal; never a real token). */
function tokenCanary(): string {
  return `ya29.${"Ab9Z".repeat(8)}`;
}

describe("ACT3-live resolveCredentialHeaders — placeholder resolution at egress (PURE, fail-closed)", () => {
  it("resolves a `Bearer openshell:resolve:env:KEY` header to `Bearer <env[KEY]>`", () => {
    const canary = tokenCanary();
    const out = resolveCredentialHeaders(
      { Authorization: "Bearer openshell:resolve:env:GKEY" },
      { GKEY: canary },
    );
    expect("headers" in out).toBe(true);
    if ("headers" in out) {
      expect(out.headers.Authorization).toBe(`Bearer ${canary}`);
    }
  });

  it("resolves a bare `openshell:resolve:env:KEY` header value (no Bearer prefix)", () => {
    const canary = tokenCanary();
    const out = resolveCredentialHeaders(
      { Authorization: "openshell:resolve:env:GKEY" },
      { GKEY: canary },
    );
    expect("headers" in out).toBe(true);
    if ("headers" in out) {
      expect(out.headers.Authorization).toBe(canary);
    }
  });

  it("FAILS CLOSED when env[KEY] is MISSING — returns an error (so the transport never calls fetch)", () => {
    const out = resolveCredentialHeaders(
      { Authorization: "Bearer openshell:resolve:env:GKEY" },
      {}, // GKEY absent
    );
    expect("error" in out).toBe(true);
    expect("headers" in out).toBe(false);
  });

  it("FAILS CLOSED when env[KEY] is EMPTY string — returns an error", () => {
    const out = resolveCredentialHeaders(
      { Authorization: "Bearer openshell:resolve:env:GKEY" },
      { GKEY: "" },
    );
    expect("error" in out).toBe(true);
    expect("headers" in out).toBe(false);
  });

  it("passes a NON-placeholder header through VERBATIM (no resolution attempted)", () => {
    const out = resolveCredentialHeaders(
      { Accept: "application/json", "Content-Type": "application/json" },
      {},
    );
    expect("headers" in out).toBe(true);
    if ("headers" in out) {
      expect(out.headers.Accept).toBe("application/json");
      expect(out.headers["Content-Type"]).toBe("application/json");
    }
  });

  it("NEVER echoes the resolved token in the error path (error is static; canary absent)", () => {
    const canary = tokenCanary();
    const out = resolveCredentialHeaders(
      { Authorization: "Bearer openshell:resolve:env:GKEY" },
      {}, // missing => error
    );
    // The canary was never even in env here, but assert the error carries no env-derived value.
    expect(JSON.stringify(out)).not.toContain(canary);
  });
});

describe("ACT3-live createHttpActionTransport.request — injected FAKE fetch only (NO real network)", () => {
  /** A recording fake fetch — captures the (url, init) and returns a scripted Response-like object. */
  function fakeFetch(status: number, body = "") {
    const calls: { url: string; init: unknown }[] = [];
    const impl = (url: string, init: unknown) => {
      calls.push({ url, init });
      return Promise.resolve({
        status,
        text: () => Promise.resolve(body),
      } as unknown as Response);
    };
    return { impl, calls };
  }

  it("2xx => returns { status, body } from the fake fetch (fetch received the resolved header)", async () => {
    const canary = tokenCanary();
    const fetch = fakeFetch(200, "{}");
    const transport = createHttpActionTransport({
      env: { GKEY: canary },
      fetchImpl: fetch.impl,
    });
    const res = await transport.request({
      method: "POST",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer openshell:resolve:env:GKEY",
      },
      body: JSON.stringify({ raw: "x" }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("{}");
    expect(fetch.calls.length).toBe(1);
    // The RESOLVED value reached the outbound header (transport egress is the ONLY resolution point).
    const init = fetch.calls[0]?.init as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe(`Bearer ${canary}`);
  });

  it("non-2xx => returns the non-2xx status (mapped to ok:false by the connector)", async () => {
    const fetch = fakeFetch(403, "forbidden");
    const transport = createHttpActionTransport({
      env: { GKEY: tokenCanary() },
      fetchImpl: fetch.impl,
    });
    const res = await transport.request({
      method: "GET",
      url: "https://www.googleapis.com/x",
      headers: { Authorization: "Bearer openshell:resolve:env:GKEY" },
    });
    expect(res.status).toBe(403);
    expect(fetch.calls.length).toBe(1);
  });

  it("missing env => FAIL CLOSED: returns a non-2xx status and the fake fetch is NEVER called", async () => {
    const fetch = fakeFetch(200, "should-not-be-returned");
    const transport = createHttpActionTransport({
      env: {}, // GKEY absent
      fetchImpl: fetch.impl,
    });
    const res = await transport.request({
      method: "POST",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      headers: { Authorization: "Bearer openshell:resolve:env:GKEY" },
      body: "{}",
    });
    // Fail-closed: a non-2xx status (the connector maps it to ok:false), and fetch was NEVER reached.
    expect(res.status >= 200 && res.status < 300).toBe(false);
    expect(fetch.calls.length).toBe(0);
  });

  it("a throwing fetch is mapped to a non-2xx (transport never throws across the boundary)", async () => {
    const transport = createHttpActionTransport({
      env: { GKEY: tokenCanary() },
      fetchImpl: () => {
        throw new Error("network down (fake)");
      },
    });
    const res = await transport.request({
      method: "GET",
      url: "https://www.googleapis.com/x",
      headers: { Authorization: "Bearer openshell:resolve:env:GKEY" },
    });
    expect(res.status >= 200 && res.status < 300).toBe(false);
  });
});
