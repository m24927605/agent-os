/**
 * SLICE-CRED-ONELEVEL (RED-first) — the OPERATOR driver scripts/act-live-gmail.mjs must NEVER echo any
 * env VALUE in its diagnostics. Under ONE-LEVEL, AGENTOS_GMAIL_OAUTH_KEY DIRECTLY HOLDS the token (a
 * secret), so the zero-echo invariant is even more load-bearing: the token value sits in that env var on
 * every run and must never reach stdout/stderr.
 *
 * This test SPAWNS the real .mjs with a runtime-built token-shaped CANARY in AGENTOS_GMAIL_OAUTH_KEY and a
 * deliberately INCOMPLETE gate env (AGENTOS_EGRESS_ALLOW omitted) so the preflight returns "skip" and the
 * driver exits fail-closed WITHOUT any send — NEVER a real network call. It captures the COMBINED
 * stdout+stderr and asserts it contains NO part of the canary and that the driver never reached the
 * "ABOUT TO SEND" gate. (We use the skip path rather than a real "ok" so the test never touches the
 * network; the one-level "ok" path's zero-echo is covered by the unit tests on liveGmailPreflight.)
 *
 * The .mjs imports the COMPILED dist (../dist/...), so this test depends on `pnpm run build` having run
 * (verify runs build before test). The canary is assembled at runtime (never a committed literal), so the
 * repo secret-scan stays clean.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/act-live-gmail.test.ts -> repo root is one level up.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const driver = fileURLToPath(new URL("./act-live-gmail.mjs", import.meta.url));
const dist = fileURLToPath(new URL("../dist/runtime/brain/adapters/hermes/index.js", import.meta.url));

/** A runtime-built OAuth-shaped canary (NOT a source literal; never a real token). */
function tokenCanary(): string {
  return `ya29.${"Wd3k".repeat(8)}`;
}

describe("act-live-gmail.mjs — operator driver never echoes an env value (CRED-ONELEVEL)", () => {
  it("token in AGENTOS_GMAIL_OAUTH_KEY + incomplete gate => SKIP, NO send, canary NOT in output", () => {
    // Requires the compiled dist (verify runs build first). If absent, fail loudly (deny, not skip).
    expect(existsSync(dist)).toBe(true);

    const canary = tokenCanary();
    // ONE-LEVEL: AGENTOS_GMAIL_OAUTH_KEY holds the TOKEN directly. We OMIT AGENTOS_EGRESS_ALLOW so the
    // preflight returns "skip" — the driver exits fail-closed WITHOUT a send (NO network) while the token
    // canary still sits in the env on this run. This pins the zero-echo invariant with no network call.
    const env = {
      // A clean, synthetic env — NOT the operator's ~/.env. No real credentials.
      PATH: process.env.PATH ?? "",
      AGENTOS_ACTION_LIVE: "true",
      AGENTOS_ACTION_TEST_ACCOUNT: "throwaway@example.test",
      // AGENTOS_EGRESS_ALLOW intentionally omitted => preflight "skip" => no send.
      AGENTOS_GMAIL_OAUTH_KEY: canary,
    };

    const res = spawnSync("node", [driver], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });

    const combined = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    // ⚠️ The token VALUE (held DIRECTLY in AGENTOS_GMAIL_OAUTH_KEY) must NEVER appear in the output.
    expect(combined.includes(canary)).toBe(false);
    expect(combined.includes("ya29")).toBe(false);
    // It must NOT have reached the "ABOUT TO SEND" gate (no send attempted, no network).
    expect(combined.includes("ABOUT TO SEND")).toBe(false);
  });

  // SLICE-REPORT-FIX — the HONEST-reporting invariant: on a NON-SEND the driver prints "NOT SENT" and
  // exits NON-ZERO, and NEVER prints "ok … executed". We force a NON-SEND that touches NO network by
  // setting AGENTOS_EGRESS_ALLOW to a NON-gmail host: the preflight passes ("ok", non-blank), but the
  // governed pipeline DENIES at the policy stage (egress fold) BEFORE the effect/resolver/transport ever
  // run — so the real userinfo GET and the real send NEVER happen (no network). The pipeline outcome is
  // "denied@policy", classifyLiveOutcome => { sent:false }, and the driver must report NOT SENT + exit 1.
  it("non-gmail egress => DENIED@policy (no network) => prints NOT SENT, exits non-zero, never 'ok … executed'", () => {
    expect(existsSync(dist)).toBe(true);

    const canary = tokenCanary();
    const env = {
      PATH: process.env.PATH ?? "",
      AGENTOS_ACTION_LIVE: "true",
      AGENTOS_ACTION_TEST_ACCOUNT: "throwaway@example.test",
      // A NON-gmail host: preflight is "ok" (non-blank) but the egress fold denies at policy BEFORE the
      // effect — so the resolver/transport never run (NO network), yet we exercise the real driver path.
      AGENTOS_EGRESS_ALLOW: "example.test",
      AGENTOS_GMAIL_OAUTH_KEY: canary,
    };

    const res = spawnSync("node", [driver], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });

    const combined = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    // HONEST: a non-send must report NOT SENT and exit non-zero — NEVER the misleading "ok … executed".
    expect(combined.includes("NOT SENT")).toBe(true);
    expect(combined.includes("ok — governed live self-send executed")).toBe(false);
    expect(combined.includes("OUTCOME executed")).toBe(false);
    expect(res.status).not.toBe(0);
    // The captured outbound egress list is empty (the effect never ran), so no Authorization line either.
    // CREDENTIAL-BLIND: the token canary must not appear anywhere in the driver output.
    expect(combined.includes(canary)).toBe(false);
    expect(combined.includes("ya29")).toBe(false);
  });
});
