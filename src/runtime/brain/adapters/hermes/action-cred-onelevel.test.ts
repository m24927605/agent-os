/**
 * SLICE-CRED-ONELEVEL (RED-first) — the ONE-LEVEL credential chain: `AGENTOS_GMAIL_OAUTH_KEY` DIRECTLY
 * HOLDS the token (a secret), not the NAME of another env var.
 *
 * The two-level footgun (the binding's `toCredentialEnv(process.env[GMAIL_OAUTH_KEY_ENV])` read the
 * VALUE as the key NAME) is removed: the binding now passes the CONSTANT NAME `GMAIL_OAUTH_KEY_ENV`
 * (= "AGENTOS_GMAIL_OAUTH_KEY") to `toCredentialEnv`, so the descriptor env is ALWAYS
 * `{ AGENTOS_GMAIL_OAUTH_KEY: "openshell:resolve:env:AGENTOS_GMAIL_OAUTH_KEY" }` — and the transport
 * resolves `env["AGENTOS_GMAIL_OAUTH_KEY"]` = the token directly at egress. ONE LEVEL.
 *
 * Proven here (PURE units + a FAKE transport; NO network, NO ~/.env):
 *   - the gmail.send / gmail.search / calendar.events.create bindings' `toCredentialEnv()` => the
 *     placeholder keyed by the CONSTANT NAME (NOT by any env value);
 *   - end-to-end resolution: `resolveCredentialHeaders` of that placeholder against
 *     `{ AGENTOS_GMAIL_OAUTH_KEY: "ya29.<canary>" }` => `Authorization: "Bearer ya29.<canary>"`;
 *   - NON-VACUITY: a mutation that re-reads the env VALUE as the key NAME (the old two-level shape)
 *     flips the one-level resolution RED.
 */
import { describe, expect, it } from "vitest";
import { resolveCredentialHeaders } from "./action-http-transport.js";
import {
  calendarEventsCreateBinding,
  gmailSearchBinding,
  gmailSendBinding,
} from "./action-seed-tools.js";

/** A runtime-built OAuth-shaped canary token (NOT a source literal; never a real token). */
function tokenCanary(): string {
  return `ya29.${"Qx7m".repeat(8)}`;
}

/** The constant env NAME the one-level placeholder is keyed by (NEVER the token value). */
const GMAIL_KEY_NAME = "AGENTOS_GMAIL_OAUTH_KEY";
const GCAL_KEY_NAME = "AGENTOS_GCAL_OAUTH_KEY";
const PLACEHOLDER_PREFIX = "openshell:resolve:env:";

describe("CRED-ONELEVEL — toCredentialEnv keyed by the CONSTANT NAME (not the env value)", () => {
  it("gmail.send binding's toCredentialEnv() => { AGENTOS_GMAIL_OAUTH_KEY: openshell:resolve:env:AGENTOS_GMAIL_OAUTH_KEY }", () => {
    const env = gmailSendBinding.toCredentialEnv?.({
      to: "a@b.com",
      subject: "hi",
      body: "x",
    });
    expect(env).toEqual({
      [GMAIL_KEY_NAME]: `${PLACEHOLDER_PREFIX}${GMAIL_KEY_NAME}`,
    });
  });

  it("gmail.search binding's toCredentialEnv() => the same one-level placeholder keyed by the constant", () => {
    const env = gmailSearchBinding.toCredentialEnv?.({ query: "q" });
    expect(env).toEqual({
      [GMAIL_KEY_NAME]: `${PLACEHOLDER_PREFIX}${GMAIL_KEY_NAME}`,
    });
  });

  it("calendar.events.create binding's toCredentialEnv() => one-level placeholder keyed by the GCAL constant", () => {
    const env = calendarEventsCreateBinding.toCredentialEnv?.({
      summary: "s",
      start: "a",
      end: "b",
    });
    expect(env).toEqual({
      [GCAL_KEY_NAME]: `${PLACEHOLDER_PREFIX}${GCAL_KEY_NAME}`,
    });
  });

  it("the placeholder key does NOT depend on process.env (one-level: it is the CONSTANT, never the value)", () => {
    const prev = process.env[GMAIL_KEY_NAME];
    // A token-shaped value in the env (the user's real one-level config) must NOT change the placeholder
    // KEY — the binding keys by the CONSTANT NAME, never by the value.
    process.env[GMAIL_KEY_NAME] = tokenCanary();
    try {
      const env = gmailSendBinding.toCredentialEnv?.({ to: "a@b.com", subject: "h", body: "x" });
      expect(env).toEqual({
        [GMAIL_KEY_NAME]: `${PLACEHOLDER_PREFIX}${GMAIL_KEY_NAME}`,
      });
      // The token value never leaks into the descriptor env (placeholder-only).
      expect(JSON.stringify(env)).not.toContain("ya29");
    } finally {
      if (prev === undefined) delete process.env[GMAIL_KEY_NAME];
      else process.env[GMAIL_KEY_NAME] = prev;
    }
  });
});

describe("CRED-ONELEVEL — end-to-end resolution: AGENTOS_GMAIL_OAUTH_KEY holds the token directly", () => {
  it("resolveCredentialHeaders(one-level placeholder, env={KEY: token}) => Authorization Bearer <token>", () => {
    const canary = tokenCanary();
    // The binding's descriptor env is the SOURCE of the header value.
    const credEnv = gmailSendBinding.toCredentialEnv?.({
      to: "a@b.com",
      subject: "h",
      body: "x",
    }) as Record<string, string>;
    const placeholder = credEnv[GMAIL_KEY_NAME];
    expect(placeholder).toBe(`${PLACEHOLDER_PREFIX}${GMAIL_KEY_NAME}`);

    // The transport resolves the placeholder against the env where AGENTOS_GMAIL_OAUTH_KEY = the TOKEN.
    const resolved = resolveCredentialHeaders(
      { Authorization: `Bearer ${placeholder}` },
      { [GMAIL_KEY_NAME]: canary },
    );
    expect("error" in resolved).toBe(false);
    if (!("error" in resolved)) {
      // ONE-LEVEL: the env value IS the token => it rides straight into Authorization.
      expect(resolved.headers.Authorization).toBe(`Bearer ${canary}`);
    }
  });

  it("NON-VACUITY: the OLD two-level shape (key by the env VALUE) does NOT resolve to the token", () => {
    const canary = tokenCanary();
    // Simulate the OLD two-level placeholder: keyed by the env VALUE (a name), resolved against an env
    // where AGENTOS_GMAIL_OAUTH_KEY holds the TOKEN directly. Under one-level config there is NO env var
    // NAMED by the token, so this fails closed (cannot resolve) — proving the one-level test is non-vacuous.
    const oldStyleKeyName = canary; // the env VALUE used as the key name (two-level read)
    const oldPlaceholder = `${PLACEHOLDER_PREFIX}${oldStyleKeyName}`;
    const resolved = resolveCredentialHeaders(
      { Authorization: `Bearer ${oldPlaceholder}` },
      { [GMAIL_KEY_NAME]: canary },
    );
    // env[<token>] is undefined => fail-closed error; the two-level read can NOT produce the token here.
    expect("error" in resolved).toBe(true);
  });
});
