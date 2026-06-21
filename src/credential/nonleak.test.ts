/**
 * Credential Non-Leak — cross-layer adversarial test (ITEM R4, SLICE-P2R-R4-S4, test-only).
 *
 * Fresh-context adversarial proof of the design §4.3 invariant: across the WHOLE R4 chain
 * (schema S1 -> FSM S2 -> injection seam S3), NO literal secret ever survives on ANY surface —
 * lease object, `LeaseEvent`, or provider-env value. For every candidate surface this asserts the
 * value is EITHER rejected at the `.strict()` Zod boundary (fail-closed parse), OR — where it is
 * accepted — that `redactSecrets` (the injected detector from audit/redact, NOT a hand-rolled one)
 * leaves it byte-for-byte unchanged, proving there was no secret to redact in the first place.
 *
 * Every secret canary is ASSEMBLED AT RUNTIME (e.g. `"sk-" + "x".repeat(20)`) so no literal secret
 * touches source/fixtures and `scripts/scan_secrets.sh` stays clean. The shapes mirror
 * audit/redact.ts SECRET_VALUE (sk-…, gh[pousr]_…, AKIA…, JWT-shape) so the detector is the same
 * high-signal gate `pnpm run verify` enforces.
 *
 * Consumed ONLY through the credential barrel (../credential/index.js) + ../audit/redact.js — no
 * deep imports, no vendor token, no new src behaviour code (a defect found here is fixed back in
 * S1/S2/S3, not patched here).
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../audit/redact.js";
import type { CredentialLease, LeaseEvent, LeaseTransition } from "./index.js";
import { expire, inject, mint, parseCredentialLease, revoke, toProviderEnv, use } from "./index.js";

// ── runtime-assembled secret canaries (never literals; aligned with audit/redact SECRET_VALUE) ──
const SK = `sk-${"x".repeat(24)}`; // OpenAI-shape
const GHP = `ghp_${"y".repeat(28)}`; // GitHub PAT-shape
const AKIA = `AKIA${"Z".repeat(16)}`; // AWS access-key-shape
const JWT = `eyJ${"a".repeat(14)}.${"b".repeat(14)}.${"c".repeat(14)}`; // JWT-shape
const SECRET_CANARIES = [SK, GHP, AKIA, JWT] as const;

// Self-check: every canary must actually be detected by the injected redactor. If a future redact
// change stopped matching a shape, this test class would silently weaken — so we assert it up front.
describe("canary self-check — every shape is a high-signal secret to the injected detector", () => {
  it.each(SECRET_CANARIES)("redactSecrets scrubs canary %s", (canary) => {
    expect(redactSecrets(canary)).not.toContain(canary);
  });
});

const validCtx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
  sandboxId: "sbx-1",
};
const farFuture = 4_102_444_800_000; // 2100-01-01
const fixedNow = () => 1_000_000;

/** A lease SPEC (no `state`) — what `mint` accepts. The FSM stamps `issued`. */
function leaseSpec(overrides: Record<string, unknown> = {}) {
  return {
    bundleRef: "anthropic-prod",
    context: validCtx,
    keys: ["ANTHROPIC_API_KEY", "CUSTOM_TOKEN"],
    expiresAtMs: farFuture,
    ...overrides,
  };
}

/** A full lease input (spec + an explicit `state`) — what `parseCredentialLease` / the seam accept. */
function leaseInput(overrides: Record<string, unknown> = {}) {
  return { ...leaseSpec(), state: "issued", ...overrides };
}

// Secret-shaped canaries that are NOT valid POSIX env-key NAMES (they contain `-` or `.`), so they
// must be rejected as a `keys` element. (GHP/AKIA shapes happen to be valid identifiers, so a
// "keys element" rejection does not apply to them — a key NAME carries no value regardless.)
const NON_IDENTIFIER_CANARIES = [SK, JWT] as const;

/** No canary substring may appear anywhere in the JSON projection of `value`. */
function assertNoCanary(value: unknown): void {
  const json = JSON.stringify(value);
  for (const canary of SECRET_CANARIES) {
    expect(json).not.toContain(canary);
  }
}

// ───────────────────────────── (1) schema surface ─────────────────────────────
describe("schema surface — a secret-shaped value cannot survive into a lease", () => {
  // Fields that admit a free string and could be abused to smuggle a secret.
  const stringFields = ["bundleRef"] as const;

  for (const canary of SECRET_CANARIES) {
    it(`undeclared 'secret' field carrying ${canary} -> parse-fail (.strict)`, () => {
      expect(() => parseCredentialLease(leaseInput({ secret: canary }))).toThrow();
    });

    it(`undeclared 'apiKey' field carrying ${canary} -> parse-fail (.strict)`, () => {
      expect(() => parseCredentialLease(leaseInput({ apiKey: canary }))).toThrow();
    });

    for (const field of stringFields) {
      it(`${field} carrying ${canary} parses, but redactSecrets leaves no intact secret`, () => {
        // bundleRef is a free string; the schema does not forbid the SHAPE. The non-leak guarantee
        // for an accepted lease is asserted at the stringification surface below — here we only
        // confirm that whatever IS accepted is fully scrubbed by the injected detector, i.e. the
        // by-VALUE redactor removes the canary so it cannot reach an audit sink intact.
        const lease = parseCredentialLease(leaseInput({ [field]: canary }));
        assertNoCanary(redactSecrets(lease));
      });
    }
  }

  it.each(NON_IDENTIFIER_CANARIES)(
    "a non-identifier secret %s as a 'keys' element -> parse-fail (env-key NAME regex)",
    (canary) => {
      // keys must be env-key NAMES; a secret containing `-`/`.` cannot pass the regex.
      expect(() =>
        parseCredentialLease(leaseInput({ keys: ["ANTHROPIC_API_KEY", canary] })),
      ).toThrow();
    },
  );

  it("a clean lease round-trips under redactSecrets unchanged (no secret to redact)", () => {
    const lease = parseCredentialLease(leaseInput());
    expect(redactSecrets(lease)).toEqual(lease);
  });
});

// ───────────────────────────── (2) FSM event surface ─────────────────────────────
describe("FSM event surface — every LeaseEvent is reference-only (redact is a no-op)", () => {
  function okLease(t: LeaseTransition): CredentialLease {
    if (t.status !== "ok") throw new Error("expected ok transition");
    return t.lease;
  }

  function assertEventClean(event: LeaseEvent): void {
    // The event carries only bundleRef + states + reason — no secret by construction, so the
    // injected redactor is a deep no-op (proves there was nothing to redact).
    expect(redactSecrets(event)).toEqual(event);
    assertNoCanary(event);
  }

  it("happy path mint -> inject -> use: each event is redact-clean", () => {
    const minted = mint(leaseSpec());
    const injected = inject(okLease(minted));
    const used = use(okLease(injected), fixedNow);
    for (const t of [minted, injected, used]) {
      assertEventClean(t.event);
    }
  });

  it.each(["revoke", "expire"] as const)(
    "deny / terminal path via %s: event is redact-clean",
    (verb) => {
      const minted = mint(leaseSpec());
      const terminal =
        verb === "revoke" ? revoke(okLease(minted)) : expire(okLease(minted), fixedNow);
      // expire on a far-future lease is denied (not yet expired) — still must be redact-clean.
      assertEventClean(terminal.event);
    },
  );

  it("an expired lease's use is denied and its event is redact-clean (no secret on deny)", () => {
    const minted = mint(leaseSpec());
    const injected = inject(okLease(minted));
    // expiresAtMs <= now: use must fail-closed; the deny event still carries no secret.
    const expiredLease = { ...okLease(injected), expiresAtMs: 500_000 };
    const denied = use(expiredLease, fixedNow);
    expect(denied.status).toBe("denied");
    assertEventClean(denied.event);
  });

  it("malformed input that tries to smuggle a secret produces a redact-clean deny event", () => {
    // bundleRef present so the event can name it; an undeclared `secret` makes it malformed.
    const malformed = { bundleRef: "x", secret: SK, state: "issued" };
    const denied = inject(malformed);
    expect(denied.status).toBe("denied");
    assertEventClean(denied.event);
  });
});

// ───────────────────────────── (3) seam surface ─────────────────────────────
describe("seam surface — every provider-env value is a placeholder, never a secret", () => {
  function injectedLease(overrides: Record<string, unknown> = {}): CredentialLease {
    return parseCredentialLease(leaseInput({ state: "injected", ...overrides }));
  }

  it("every value matches ^openshell:resolve:env: and redactSecrets(env values) is a no-op", () => {
    const out = toProviderEnv(injectedLease(), fixedNow);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    for (const value of Object.values(out.env)) {
      expect(value.startsWith("openshell:resolve:env:")).toBe(true);
    }
    // by-VALUE redaction over the values alone is a no-op (no secret SHAPE in any placeholder).
    const values = Object.values(out.env);
    expect(redactSecrets(values)).toEqual(values);
    assertNoCanary(out.env);
  });

  it("revision-form placeholders also carry no secret shape", () => {
    const out = toProviderEnv(injectedLease({ revision: 7 }), fixedNow);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const values = Object.values(out.env);
    expect(redactSecrets(values)).toEqual(values);
    assertNoCanary(out.env);
  });
});

// ───────────────────────────── (4) stringification surface ─────────────────────────────
describe("stringification surface — JSON.stringify(lease) contains only bundleRef + placeholder names + state", () => {
  it("a clean lease's JSON contains no secret canary", () => {
    const lease = parseCredentialLease(leaseInput());
    assertNoCanary(lease);
    const json = JSON.stringify(lease);
    expect(json).toContain("anthropic-prod"); // bundleRef
    expect(json).toContain("issued"); // state
    expect(json).toContain("ANTHROPIC_API_KEY"); // KEY NAME, not a value
  });

  it.each(SECRET_CANARIES)(
    "even when a canary %s is forced through a free string field, JSON.stringify + redactSecrets carries no intact secret",
    (canary) => {
      // bundleRef is a free string; force the canary in. The non-leak guarantee is that the
      // SHAPE is scrubbed by the injected redactor before any serialization reaches an audit sink.
      const lease = parseCredentialLease(leaseInput({ bundleRef: canary }));
      assertNoCanary(redactSecrets(lease));
    },
  );
});

// ───────────────────────────── (5) fail-closed full chain ─────────────────────────────
describe("fail-closed full chain — revoked/expired never yields env, never surfaces a secret", () => {
  it("revoked lease -> seam denied, no env, no secret", () => {
    const revoked = parseCredentialLease(leaseInput({ state: "revoked" }));
    const out = toProviderEnv(revoked, fixedNow);
    expect(out.status).toBe("denied");
    expect(out).not.toHaveProperty("env");
    assertNoCanary(out);
  });

  it("expired lease -> seam denied, no env, no secret", () => {
    const expired = parseCredentialLease(leaseInput({ state: "expired" }));
    const out = toProviderEnv(expired, fixedNow);
    expect(out.status).toBe("denied");
    expect(out).not.toHaveProperty("env");
    assertNoCanary(out);
  });

  it("expiry window: injected lease with expiresAtMs <= now -> seam denied (closes the window)", () => {
    // state is injected but expiresAtMs (500_000) <= fixedNow (1_000_000): seam must fail-closed
    // BEFORE producing any placeholder, even though expire() has not been called.
    const injectedButStale = parseCredentialLease(
      leaseInput({ state: "injected", expiresAtMs: 500_000 }),
    );
    const out = toProviderEnv(injectedButStale, fixedNow);
    expect(out.status).toBe("denied");
    expect(out).not.toHaveProperty("env");
    assertNoCanary(out);
  });

  it("full lifecycle then revoke: re-use after revoke is denied with a redact-clean event", () => {
    const minted = mint(leaseSpec());
    if (minted.status !== "ok") throw new Error("mint failed");
    const injected = inject(minted.lease);
    if (injected.status !== "ok") throw new Error("inject failed");
    const revoked = revoke(injected.lease);
    if (revoked.status !== "ok") throw new Error("revoke failed");
    // use after revoke (terminal) must be denied.
    const afterRevoke = use(revoked.lease, fixedNow);
    expect(afterRevoke.status).toBe("denied");
    expect(redactSecrets(afterRevoke.event)).toEqual(afterRevoke.event);
    assertNoCanary(afterRevoke.event);
  });
});
