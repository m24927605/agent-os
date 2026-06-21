/**
 * RED-first tests for SLICE-P2R-R1-S5 — GetSandboxProviderEnvironment placeholder-only shape guard.
 *
 * These assert the behaviours + security invariants of §5 of the slice spec
 * (docs/slices/phase-2-remaining/P2R-R1-S5-provider-env-placeholder-fail-closed.md) BEFORE the
 * `assertPlaceholderOnly` pure function exists. They MUST be SEEN to fail first
 * (./provider-env.js has no `assertPlaceholderOnly` export yet).
 *
 * Credential non-leak invariant (CLAUDE.md / design §2.3): OpenShell's `SecretResolver` rewrites
 * provider-env raw values into `openshell:resolve:env:<KEY>` (rev 0) / `openshell:resolve:env:v<rev>_<KEY>`
 * (rev != 0) placeholders BEFORE they leave the gateway, and resolves them to real values only at
 * egress. R1 only ever carries placeholder-shaped values; `assertPlaceholderOnly` is a fail-closed
 * shape guard that THROWS on ANY value that does not match that exact placeholder grammar — so a raw
 * secret accidentally (or maliciously) placed in `environment` is structurally rejected, never
 * carried by Agent OS.
 *
 * The raw-secret canary used by the adversarial probes is ASSEMBLED AT RUNTIME (no secret-like
 * literal in this source file) so the secret-scan gate stays clean (phase-2 INDEX iron law).
 */
import { describe, expect, it } from "vitest";
import { assertPlaceholderOnly } from "./provider-env.js";

/**
 * Build a raw-secret-shaped canary at runtime (NEVER a source literal). The shape mimics a provider
 * API token (`sk-live-…`) that the secret-scan gate would otherwise flag; assembling it from parts
 * keeps the source file scan-clean while still exercising the fail-closed guard with a value that
 * looks like a real credential.
 */
function rawSecretCanary(): string {
  return ["sk", "live", "x".repeat(24)].join("-");
}

describe("assertPlaceholderOnly — accepts the exact SecretResolver placeholder grammar", () => {
  it("passes a revision!=0 placeholder and returns it unchanged", () => {
    const env = { A: "openshell:resolve:env:v3_TOKEN" };
    expect(assertPlaceholderOnly(env)).toEqual(env);
  });

  it("passes a revision==0 placeholder (no v0_ segment) — must not over-reject (regression)", () => {
    // SecretResolver omits `v0_` for revision 0 (secrets.rs:487-493). A guard that only accepts the
    // `v<rev>_` form would wrongly reject this legitimate placeholder and break the happy path.
    const env = { A: "openshell:resolve:env:TOKEN" };
    expect(assertPlaceholderOnly(env)).toEqual(env);
  });

  it("passes an empty env unchanged (nothing suspicious to reject)", () => {
    expect(assertPlaceholderOnly({})).toEqual({});
  });

  it("passes multiple placeholder values and returns an equal record", () => {
    const env = {
      A: "openshell:resolve:env:TOKEN",
      B: "openshell:resolve:env:v12_MY_KEY_2",
    };
    expect(assertPlaceholderOnly(env)).toEqual(env);
  });
});

describe("assertPlaceholderOnly — fail-closed on anything that is not a placeholder", () => {
  it("THROWS on a value that looks like a raw secret (adversarial, fail-closed)", () => {
    const secret = rawSecretCanary();
    expect(() => assertPlaceholderOnly({ A: secret })).toThrow();
    // The guard must reject and must not echo the raw value back to the caller in any form.
    try {
      assertPlaceholderOnly({ A: secret });
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(secret);
    }
  });

  it("THROWS on a value carrying a reserved credential marker that is NOT a well-formed placeholder", () => {
    // Alias marker form (secrets.rs:10 PROVIDER_ALIAS_MARKER) — looks credential-bearing but is not a
    // clean `openshell:resolve:env:` placeholder, so it must be denied (fail-closed).
    expect(() => assertPlaceholderOnly({ A: "X-OPENSHELL-RESOLVE-ENV-TOKEN" })).toThrow();
  });

  it("THROWS on the prefix embedded mid-string (not a clean anchored placeholder)", () => {
    expect(() =>
      assertPlaceholderOnly({ A: "prefix-openshell:resolve:env:v1_TOKEN-suffix" }),
    ).toThrow();
  });

  it("THROWS on a plain non-placeholder literal (conservative allowlist — only placeholders pass)", () => {
    // Unlike exec env (which tolerates plain literals), provider-env must be placeholder-ONLY: any
    // value that is not a well-formed placeholder is treated as suspicious and rejected.
    expect(() => assertPlaceholderOnly({ A: "plaintext-value" })).toThrow();
  });

  it("THROWS if ANY value in the record is suspicious (one bad value denies the whole env)", () => {
    expect(() =>
      assertPlaceholderOnly({
        A: "openshell:resolve:env:TOKEN",
        B: rawSecretCanary(),
      }),
    ).toThrow();
  });
});
