/**
 * SLICE-CRED-LEAK-FIX (RED-first) — the OPERATOR driver scripts/act-live-gmail.mjs must NEVER echo any
 * env VALUE in its diagnostics. The historical leak: when a user mis-pasted a token into
 * AGENTOS_GMAIL_OAUTH_KEY (which is meant to hold the NAME of the token env var, two-level), the BLOCKED
 * diagnostic echoed `env[${oauthKey}]` — leaking the token into stdout/stderr.
 *
 * This test SPAWNS the real .mjs with a runtime-built token-shaped CANARY in AGENTOS_GMAIL_OAUTH_KEY
 * (+ the minimal gate env so it reaches the BLOCKED preflight branch — NEVER a real send, NO network),
 * captures the COMBINED stdout+stderr, and asserts it contains NO part of the canary. The .mjs must
 * fail-closed (blocked) on the misconfig and print only the FIXED preflight reason.
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

describe("act-live-gmail.mjs — operator driver never echoes an env value (CRED-LEAK-FIX)", () => {
  it("token mis-pasted into AGENTOS_GMAIL_OAUTH_KEY => BLOCKED, NO send, canary NOT in output", () => {
    // Requires the compiled dist (verify runs build first). If absent, fail loudly (deny, not skip).
    expect(existsSync(dist)).toBe(true);

    const canary = tokenCanary();
    // Minimal gate env so the .mjs PASSES the "all set" check and reaches the key-name VALIDATION
    // (the blocked path) — a token-shaped key is not a valid env-var NAME, so it blocks BEFORE any send.
    const env = {
      // A clean, synthetic env — NOT the operator's ~/.env. No real credentials.
      PATH: process.env.PATH ?? "",
      AGENTOS_ACTION_LIVE: "true",
      AGENTOS_ACTION_TEST_ACCOUNT: "throwaway@example.test",
      AGENTOS_EGRESS_ALLOW: "gmail.googleapis.com",
      AGENTOS_GMAIL_OAUTH_KEY: canary,
    };

    const res = spawnSync("node", [driver], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });

    const combined = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    // ⚠️ The mis-pasted token VALUE must NEVER appear anywhere in the driver's output.
    expect(combined.includes(canary)).toBe(false);
    expect(combined.includes("ya29")).toBe(false);
    // Fail-closed: a misconfig blocks (non-zero exit), it must NOT proceed to a send.
    expect(res.status).not.toBe(0);
    // It must NOT have reached the "ABOUT TO SEND" gate (no send attempted).
    expect(combined.includes("ABOUT TO SEND")).toBe(false);
  });
});
