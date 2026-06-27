/**
 * SLICE-ACT3-live (RED-first) — the LIVE-RUNNER WIRING, exercised through the REAL `runGovernedToolCall`
 * with a FAKE transport + FAKE resolver (NO real network). This is the importable, testable CORE of
 * scripts/act-live-gmail.mjs: `runGmailSelfSend(opts)` builds the FULL governed pipeline for gmail.send
 * (the action-join.test.ts shape) with `deps.effect = bindingWrappedActionEffect(createGuardedActionConnector(
 * createGoogleActionConnector(transport), { live, testAccounts, resolveAccount }), seedActionBindings(...))`,
 * an in-memory WORM appender, and runs ONE self-send. It returns the governance trace + the appended WORM
 * events so the test (and the operator runner) can assert the invariants.
 *
 * Proven here (FAKE transport + FAKE resolver, no network):
 *   - guard LIVE-ON + account ∈ allowlist + egress allows the gmail host => connector => the (fake) transport
 *     receives a POST to gmail.googleapis.com carrying Authorization with the RESOLVED-from-fake-env value;
 *   - guard LIVE-OFF => NOT sent (transport never receives a request);
 *   - account NOT in the allowlist => NOT sent;
 *   - egress not the gmail host => denied@policy;
 *   - CREDENTIAL-BLIND end-to-end: a canary token in the fake env => the WORM events (intent + boundary) +
 *     the projection contain NO canary (only the placeholder); ONLY the transport's outbound header carries
 *     the resolved value.
 */
import { describe, expect, it } from "vitest";
import {
  type CapturedHttp,
  liveGmailPreflight,
  runGmailSelfSend,
} from "./action-live-gmail-runner.js";

const TEST_EMAIL = "mrfed1913@gmail.com";

/** A runtime-built OAuth-shaped canary token (NOT a source literal; never a real token). */
function tokenCanary(): string {
  return `ya29.${"Qx7m".repeat(8)}`;
}

/**
 * Base opts for a fully-permitted self-send: live on, account in allowlist, gmail host allowed, the OAuth
 * KEY configured (so the descriptor env is a non-empty placeholder), and a fake env carrying the canary.
 */
function permittedOpts(over: Partial<Parameters<typeof runGmailSelfSend>[0]> = {}) {
  const canary = tokenCanary();
  return {
    live: true,
    testAccount: TEST_EMAIL,
    egressAllow: ["gmail.googleapis.com"],
    oauthKey: "AGENTOS_GMAIL_OAUTH_KEY",
    // The fake process-env the REAL transport would read at egress. Carries the canary token.
    env: { AGENTOS_GMAIL_OAUTH_KEY: canary } as Record<string, string>,
    // Fake resolver answer (the live resolver would GET userinfo; here it is canned, no network).
    useFakeResolver: true,
    resolvedAccount: TEST_EMAIL as string | undefined,
    canary,
    ...over,
  };
}

describe("ACT3-live runner wiring — fully permitted self-send (FAKE transport + FAKE resolver)", () => {
  it("live + account allowlisted + egress allows gmail => POST gmail host with RESOLVED Authorization", async () => {
    const opts = permittedOpts();
    const out = await runGmailSelfSend(opts);

    expect(out.outcome.status).toBe("executed");
    // The connector reached the fake transport with a POST to the gmail host.
    const captured = out.http as CapturedHttp;
    expect(captured.requests.length).toBe(1);
    const req = captured.requests[0];
    expect(req?.method).toBe("POST");
    expect(req?.url).toContain("gmail.googleapis.com");
    // CREDENTIAL: the outbound header carries the RESOLVED-from-fake-env canary (egress is the only point).
    expect(req?.headers.Authorization).toBe(`Bearer ${opts.canary}`);
  });

  it("CREDENTIAL-BLIND end-to-end: the canary appears ONLY at the transport egress, never in the WORM", async () => {
    const opts = permittedOpts();
    const out = await runGmailSelfSend(opts);
    expect(out.outcome.status).toBe("executed");

    // The WORM events (commit-before-effect intent + post-effect boundary) carry NO canary.
    const wormBlob = JSON.stringify(out.appended);
    expect(wormBlob).toContain("effect.boundary-crossed");
    expect(wormBlob).toContain("gmail.googleapis.com");
    expect(wormBlob).not.toContain(opts.canary);
    // Only the PLACEHOLDER ever rides the governance path — never the resolved token.
    expect(wormBlob.includes("openshell:resolve:env:")).toBe(false); // not even the placeholder is logged

    // The projection on the trace is host-only — no canary, no token.
    const traceBlob = JSON.stringify(out.trace);
    expect(traceBlob).not.toContain(opts.canary);

    // The ONLY place the resolved canary appears is the transport's outbound header.
    const captured = out.http as CapturedHttp;
    expect(captured.requests[0]?.headers.Authorization).toBe(`Bearer ${opts.canary}`);
  });
});

describe("ACT3-live runner wiring — fail-closed gates (no send)", () => {
  it("guard LIVE-OFF => NOT sent (transport never receives a request)", async () => {
    const out = await runGmailSelfSend(permittedOpts({ live: false }));
    const captured = out.http as CapturedHttp;
    expect(captured.requests.length).toBe(0);
    // The effect ran (commit happened) but the guard refused before the connector => not executed-as-sent.
    if (out.outcome.status === "executed") {
      expect(out.outcome.detail ?? "").toContain("deny");
    }
  });

  it("account NOT in the allowlist (resolver yields a different email) => NOT sent", async () => {
    const out = await runGmailSelfSend(
      permittedOpts({ resolvedAccount: "someone-else@gmail.com" }),
    );
    const captured = out.http as CapturedHttp;
    expect(captured.requests.length).toBe(0);
  });

  it("resolver yields undefined (e.g. userinfo failed) => NOT sent (fail-closed)", async () => {
    const out = await runGmailSelfSend(permittedOpts({ resolvedAccount: undefined }));
    const captured = out.http as CapturedHttp;
    expect(captured.requests.length).toBe(0);
  });

  it("egress NOT the gmail host => denied@policy; transport never receives a request", async () => {
    const out = await runGmailSelfSend(permittedOpts({ egressAllow: [] }));
    expect(out.outcome.status).toBe("denied");
    if (out.outcome.status === "denied") expect(out.outcome.stage).toBe("policy");
    const captured = out.http as CapturedHttp;
    expect(captured.requests.length).toBe(0);
  });
});

// ================================================================================================
// SLICE-CRED-LEAK-FIX — liveGmailPreflight: a credential-blind, fixed-reason env gate. The reason
// is assembled from FIXED string literals ONLY; it NEVER interpolates any env VALUE (so a user who
// mis-pastes a token into AGENTOS_GMAIL_OAUTH_KEY can never have it echoed by the operator script's
// diagnostic). These tests pin BOTH the status logic AND the zero-env-value-leak invariant.
// ================================================================================================

/** A runtime-built OAuth-shaped canary (NOT a source literal; never a real token). */
function preflightCanary(): string {
  return `ya29.${"Zk9p".repeat(8)}`;
}

/** A fully-populated, correctly-two-level-configured env (AGENTOS_GMAIL_OAUTH_KEY names GMAIL_TOKEN). */
function okEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    AGENTOS_ACTION_LIVE: "true",
    AGENTOS_ACTION_TEST_ACCOUNT: TEST_EMAIL,
    AGENTOS_EGRESS_ALLOW: "gmail.googleapis.com",
    AGENTOS_GMAIL_OAUTH_KEY: "GMAIL_TOKEN",
    GMAIL_TOKEN: "a-token-value",
    ...over,
  };
}

describe("liveGmailPreflight — status logic (fake env, no network)", () => {
  it('all four gate vars set + key names a SET token env => "ok"', () => {
    const r = liveGmailPreflight(okEnv());
    expect(r.status).toBe("ok");
  });

  it('AGENTOS_ACTION_LIVE unset => "skip"', () => {
    const r = liveGmailPreflight(okEnv({ AGENTOS_ACTION_LIVE: undefined }));
    expect(r.status).toBe("skip");
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('AGENTOS_ACTION_LIVE blank => "skip"', () => {
    expect(liveGmailPreflight(okEnv({ AGENTOS_ACTION_LIVE: "" })).status).toBe("skip");
  });

  it('AGENTOS_ACTION_TEST_ACCOUNT / AGENTOS_EGRESS_ALLOW / AGENTOS_GMAIL_OAUTH_KEY unset => "skip"', () => {
    expect(liveGmailPreflight(okEnv({ AGENTOS_ACTION_TEST_ACCOUNT: undefined })).status).toBe(
      "skip",
    );
    expect(liveGmailPreflight(okEnv({ AGENTOS_EGRESS_ALLOW: undefined })).status).toBe("skip");
    expect(liveGmailPreflight(okEnv({ AGENTOS_GMAIL_OAUTH_KEY: undefined })).status).toBe("skip");
  });

  it('AGENTOS_GMAIL_OAUTH_KEY is a token-shape (not a valid env-var NAME) => "blocked" + teaching reason', () => {
    const canary = preflightCanary();
    const r = liveGmailPreflight(okEnv({ AGENTOS_GMAIL_OAUTH_KEY: canary }));
    expect(r.status).toBe("blocked");
    // The teaching reason points the operator to the TWO-LEVEL setup (name the env var, not the token).
    expect(r.reason).toContain("must be the NAME");
    expect(r.reason).toContain("GMAIL_TOKEN");
  });

  it('AGENTOS_GMAIL_OAUTH_KEY names an UNSET token env => "blocked" (token-not-set)', () => {
    const r = liveGmailPreflight(
      okEnv({ AGENTOS_GMAIL_OAUTH_KEY: "GMAIL_TOKEN", GMAIL_TOKEN: undefined }),
    );
    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("not set");
  });

  it('AGENTOS_GMAIL_OAUTH_KEY names a BLANK token env => "blocked" (token-not-set)', () => {
    const r = liveGmailPreflight(
      okEnv({ AGENTOS_GMAIL_OAUTH_KEY: "GMAIL_TOKEN", GMAIL_TOKEN: "" }),
    );
    expect(r.status).toBe("blocked");
  });
});

describe("liveGmailPreflight — ZERO env-value leak invariant (the heart of the slice)", () => {
  it("token-shaped key => reason contains NO part of the canary (and not 'ya29')", () => {
    const canary = preflightCanary();
    const r = liveGmailPreflight(okEnv({ AGENTOS_GMAIL_OAUTH_KEY: canary }));
    expect(r.status).toBe("blocked");
    // ⚠️ The offending VALUE must NEVER appear in the diagnostic reason.
    expect(r.reason.includes(canary)).toBe(false);
    expect(r.reason.includes("ya29")).toBe(false);
  });

  it("token-not-set path => reason contains NO part of the resolved-key-name value nor the (absent) token", () => {
    const keyNameCanary = `MYSECRETKEYNAME_${"X9".repeat(8)}`;
    // A valid env-var NAME shape, but a canary so we can assert it is never echoed.
    const r = liveGmailPreflight(
      okEnv({ AGENTOS_GMAIL_OAUTH_KEY: keyNameCanary, GMAIL_TOKEN: undefined }),
    );
    expect(r.status).toBe("blocked");
    expect(r.reason.includes(keyNameCanary)).toBe(false);
  });

  it("GENERAL: a canary placed in EACH relevant env value never appears in preflight.reason", () => {
    const canary = preflightCanary();
    const slots: (keyof ReturnType<typeof okEnv>)[] = [
      "AGENTOS_ACTION_LIVE",
      "AGENTOS_ACTION_TEST_ACCOUNT",
      "AGENTOS_EGRESS_ALLOW",
      "AGENTOS_GMAIL_OAUTH_KEY",
      "GMAIL_TOKEN",
    ];
    for (const slot of slots) {
      const r = liveGmailPreflight(okEnv({ [slot]: canary }));
      // Whatever the status, the reason must never carry the canary value.
      expect(r.reason.includes(canary)).toBe(false);
    }
  });
});
