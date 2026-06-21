import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { redactSecrets } from "../audit/redact.js";
import { type CredentialLease, LeaseState, parseCredentialLease } from "./index.js";

const validCtx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
  sandboxId: "sbx-1",
};

const farFuture = 4_102_444_800_000; // 2100-01-01, comfortably in the future.

const validLease = {
  bundleRef: "anthropic-prod",
  context: validCtx,
  keys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  expiresAtMs: farFuture,
  state: "issued",
};

// Canary: a secret-SHAPED value assembled at RUNTIME so no literal secret touches source/scan.
// Matches audit/redact SECRET_VALUE (`sk-[A-Za-z0-9]{16,}`).
const secretCanary = `sk-${"a".repeat(24)}`;

describe("parseCredentialLease — .strict() bundleRef-only, fail-closed", () => {
  it("accepts a valid lease and lands in the issued state", () => {
    const lease = parseCredentialLease(validLease);
    expect(lease.bundleRef).toBe("anthropic-prod");
    expect(lease.state).toBe("issued");
    expect(lease.keys).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(lease.expiresAtMs).toBe(farFuture);
    expect(`${lease.context.tenantId}`).toBe("tenant-a");
    expect(lease.revision).toBeUndefined();
  });

  it("accepts an optional revision", () => {
    const lease = parseCredentialLease({ ...validLease, revision: 3 });
    expect(lease.revision).toBe(3);
  });

  it("exposes LeaseState enum members", () => {
    expect(LeaseState.options).toEqual(["issued", "injected", "used", "revoked", "expired"]);
  });

  it(".strict(): rejects an undeclared (secret-shaped) field — fail-closed", () => {
    expect(() => parseCredentialLease({ ...validLease, secret: "x" })).toThrow(ZodError);
    expect(() => parseCredentialLease({ ...validLease, value: "x" })).toThrow(ZodError);
    expect(() => parseCredentialLease({ ...validLease, apiKey: "x" })).toThrow(ZodError);
  });

  it("rejects a key that is not a valid env-key name (fail-closed)", () => {
    expect(() => parseCredentialLease({ ...validLease, keys: ["bad-key"] })).toThrow(ZodError);
    expect(() => parseCredentialLease({ ...validLease, keys: ["1LEADING_DIGIT"] })).toThrow(
      ZodError,
    );
    expect(() => parseCredentialLease({ ...validLease, keys: [""] })).toThrow(ZodError);
    expect(() => parseCredentialLease({ ...validLease, keys: [] })).toThrow(ZodError);
  });

  it("a secret-shaped value cannot survive as a declared key name (adversarial)", () => {
    // A raw secret pushed into `keys` is structurally rejected because it is not a valid env-key name.
    expect(() => parseCredentialLease({ ...validLease, keys: [secretCanary] })).toThrow(ZodError);
  });

  it("the parsed lease projection carries NO literal secret (redact detector finds none)", () => {
    // A secret pushed anywhere extra is .strict()-rejected; prove the legitimate projection is clean.
    const lease = parseCredentialLease(validLease);
    const projection = JSON.stringify(lease);
    // Injecting redactSecrets as a detector (same module audit/redact uses for the leak gate):
    // redaction is a no-op IFF the projection contains no secret SHAPE. A literal secret anywhere
    // in the lease would be rewritten to [REDACTED] and this would fail.
    expect(redactSecrets(projection)).toBe(projection);
    expect(projection).not.toContain(secretCanary);
  });

  it("rejects a bad context (missing tenantId) — fail-closed via parseAgentContext", () => {
    const { tenantId: _omit, ...badCtx } = validCtx;
    expect(() => parseCredentialLease({ ...validLease, context: badCtx })).toThrow(ZodError);
  });

  it("rejects an empty-string id inside context (fail-closed)", () => {
    expect(() =>
      parseCredentialLease({ ...validLease, context: { ...validCtx, actorId: "  " } }),
    ).toThrow(ZodError);
  });

  it("rejects a non-positive / non-integer / non-numeric expiresAtMs (fail-closed)", () => {
    expect(() => parseCredentialLease({ ...validLease, expiresAtMs: 0 })).toThrow(ZodError);
    expect(() => parseCredentialLease({ ...validLease, expiresAtMs: -1 })).toThrow(ZodError);
    expect(() => parseCredentialLease({ ...validLease, expiresAtMs: 1.5 })).toThrow(ZodError);
    expect(() => parseCredentialLease({ ...validLease, expiresAtMs: "soon" })).toThrow(ZodError);
  });

  it("rejects a non-object / null input (fail-closed)", () => {
    expect(() => parseCredentialLease(null)).toThrow(ZodError);
    expect(() => parseCredentialLease("nope")).toThrow(ZodError);
  });

  it("rejects a missing required field (fail-closed)", () => {
    const { bundleRef: _omit, ...noBundle } = validLease;
    expect(() => parseCredentialLease(noBundle)).toThrow(ZodError);
  });

  it("type surface: a parsed lease is assignable to CredentialLease", () => {
    const lease: CredentialLease = parseCredentialLease(validLease);
    expect(lease.state satisfies CredentialLease["state"]).toBe("issued");
  });
});
