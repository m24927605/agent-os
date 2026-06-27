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
import { type CapturedHttp, runGmailSelfSend } from "./action-live-gmail-runner.js";

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
