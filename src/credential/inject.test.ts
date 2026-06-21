import { describe, expect, it } from "vitest";
import { redactSecrets } from "../audit/redact.js";
import type { CredentialLease } from "./index.js";
import { placeholderForKey, toProviderEnv } from "./index.js";

const validCtx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
  sandboxId: "sbx-1",
};

const farFuture = 4_102_444_800_000; // 2100-01-01, comfortably in the future.
const fixedNow = () => 1_000_000;

// Canary: a secret-SHAPED value assembled at RUNTIME so no literal secret touches source/scan.
// Matches audit/redact SECRET_VALUE (`sk-[A-Za-z0-9]{16,}`).
const secretCanary = `sk-${"a".repeat(24)}`;

/** Build an `injected` lease directly (S3 only ever projects an already-injected lease). */
function injectedLease(overrides: Partial<CredentialLease> = {}): CredentialLease {
  return {
    bundleRef: "anthropic-prod",
    context: validCtx,
    keys: ["ANTHROPIC_API_KEY", "CUSTOM_TOKEN"],
    expiresAtMs: farFuture,
    state: "injected",
    ...overrides,
  } as CredentialLease;
}

describe("placeholderForKey — OpenShell grammar (secrets.rs:483-493)", () => {
  it("no revision (undefined) -> canonical openshell:resolve:env:<KEY>", () => {
    expect(placeholderForKey("ANTHROPIC_API_KEY")).toBe("openshell:resolve:env:ANTHROPIC_API_KEY");
  });

  it("revision 0 -> canonical (aligns with secrets.rs:487-493 revision==0 branch)", () => {
    expect(placeholderForKey("CUSTOM_TOKEN", 0)).toBe("openshell:resolve:env:CUSTOM_TOKEN");
  });

  it("revision 2 -> revision form openshell:resolve:env:v2_<KEY>", () => {
    expect(placeholderForKey("ANTHROPIC_API_KEY", 2)).toBe(
      "openshell:resolve:env:v2_ANTHROPIC_API_KEY",
    );
  });
});

describe("toProviderEnv — injected lease -> provider-env placeholder map", () => {
  it("injected lease, no revision -> KEY -> canonical placeholder (secrets.rs:483-485)", () => {
    const out = toProviderEnv(injectedLease(), fixedNow);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.env).toEqual({
      ANTHROPIC_API_KEY: "openshell:resolve:env:ANTHROPIC_API_KEY",
      CUSTOM_TOKEN: "openshell:resolve:env:CUSTOM_TOKEN",
    });
  });

  it("injected lease with revision=2 -> revision-form placeholders (secrets.rs:487-493)", () => {
    const out = toProviderEnv(injectedLease({ revision: 2 }), fixedNow);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.env).toEqual({
      ANTHROPIC_API_KEY: "openshell:resolve:env:v2_ANTHROPIC_API_KEY",
      CUSTOM_TOKEN: "openshell:resolve:env:v2_CUSTOM_TOKEN",
    });
  });

  describe("fail-closed: only `injected` state may project (adversarial)", () => {
    it.each(["issued", "used", "revoked", "expired"] as const)(
      "state=%s -> denied, no env produced",
      (state) => {
        const out = toProviderEnv(injectedLease({ state }), fixedNow);
        expect(out.status).toBe("denied");
        if (out.status !== "denied") return;
        expect(out).not.toHaveProperty("env");
      },
    );
  });

  describe("expiry fail-closed (clock-injected) — design §2.2 expiry window", () => {
    it("injected lease whose expiresAtMs <= now -> denied (reason flags expired), no env", () => {
      // state is injected but expiresAtMs (500_000) <= now (1_000_000): must fail-closed,
      // closing the "injected but not yet expire()'d" window before any placeholder is produced.
      const out = toProviderEnv(injectedLease({ expiresAtMs: 500_000 }), fixedNow);
      expect(out.status).toBe("denied");
      if (out.status !== "denied") return;
      expect(out.reason.toLowerCase()).toContain("expire");
      expect(out).not.toHaveProperty("env");
    });

    it("boundary expiresAtMs === now is treated as expired (<=, not <)", () => {
      const out = toProviderEnv(injectedLease({ expiresAtMs: fixedNow() }), fixedNow);
      expect(out.status).toBe("denied");
    });
  });

  describe("no literal secret — output is placeholder-only", () => {
    it("every value is a placeholder; redactSecrets is a no-op and no secret canary appears", () => {
      const out = toProviderEnv(injectedLease(), fixedNow);
      expect(out.status).toBe("ok");
      if (out.status !== "ok") return;
      // Keys are the KEY NAMES; values are placeholder strings.
      for (const [key, value] of Object.entries(out.env)) {
        expect(value.startsWith("openshell:resolve:env:")).toBe(true);
        // The placeholder is built from the KEY name, never a value.
        expect(value).toContain(key);
      }
      // The VALUES carry no secret SHAPE: the by-VALUE redactor pass (scanned over the values
      // alone, away from their secret-NAMED keys) is a no-op. (The by-KEY pass legitimately
      // redacts the values BECAUSE the keys are env vars like ANTHROPIC_API_KEY — that is the
      // redactor doing its job, not a leak; the leak invariant is value-shape, asserted here.)
      const values = Object.values(out.env);
      expect(redactSecrets(values)).toEqual(values);
      // And no secret canary shape appears anywhere in the projection.
      expect(JSON.stringify(out.env)).not.toContain(secretCanary);
    });
  });

  describe("malformed -> deny (no throw that lets it through)", () => {
    it("a non-lease (missing state) is denied, not thrown", () => {
      const notALease = {
        bundleRef: "x",
        context: validCtx,
        keys: ["A"],
        expiresAtMs: farFuture,
      };
      expect(() => toProviderEnv(notALease as unknown as CredentialLease, fixedNow)).not.toThrow();
      expect(toProviderEnv(notALease as unknown as CredentialLease, fixedNow).status).toBe(
        "denied",
      );
    });

    it("null/garbage input is denied, not thrown", () => {
      expect(toProviderEnv(null as unknown as CredentialLease, fixedNow).status).toBe("denied");
      expect(toProviderEnv("nope" as unknown as CredentialLease, fixedNow).status).toBe("denied");
    });
  });
});
