/**
 * SLICE-CAP5 (RED-first) — the EXTRACTED, vendor-neutral egress-allowlist matcher + the PDP
 * defense-in-depth decision.
 *
 * `matchEgressAllow(host, allowlist)` is the SINGLE SOURCE OF TRUTH lifted VERBATIM from the inference
 * second-chokepoint gate (`src/inference/egress-allowlist.ts`): deny-by-default, EXACT match
 * (case-insensitive after normalize), fail-closed on an empty host / empty allowlist / unknown host,
 * NO suffix/substring matching. The inference gate now re-uses it, so its observable behavior + tests
 * stay byte-identical (proven in src/inference/egress-allowlist.test.ts).
 *
 * `egressDecisionForProjection(networkHosts, egressAllow)` is the PDP-side defense-in-depth layer: if
 * ANY projected network host fails the matcher it returns a `deny` `PolicyDecision` (STATIC reason, no
 * host echoed beyond a count — credential-blind); empty `networkHosts` or all-allowed => `allow`. The
 * substrate seal is PRIMARY; this is a best-effort secondary check folded into the bin's authorize.
 */
import { describe, expect, it } from "vitest";
import { egressDecisionForProjection, matchEgressAllow } from "./egress-allowlist.js";

const allowlist = ["api.allowed.example", "models.other.example"] as const;

describe("matchEgressAllow — deny-by-default exact match (extracted single source of truth)", () => {
  it("ALLOW: an exact-match allowlisted host passes", () => {
    expect(matchEgressAllow("api.allowed.example", allowlist)).toBe(true);
  });

  it("ALLOW: case-insensitive — a differently-cased host normalizes and matches", () => {
    expect(matchEgressAllow("API.Allowed.Example", allowlist)).toBe(true);
  });

  it("ALLOW: a differently-cased allowlist ENTRY still matches a lowercase host", () => {
    expect(matchEgressAllow("api.allowed.example", ["API.ALLOWED.EXAMPLE"])).toBe(true);
  });

  it("deny-by-default: an unknown host denies", () => {
    expect(matchEgressAllow("api.unknown.example", allowlist)).toBe(false);
  });

  it("fail-closed on empty: an empty allowlist denies every host", () => {
    expect(matchEgressAllow("api.allowed.example", [])).toBe(false);
    expect(matchEgressAllow("models.other.example", [])).toBe(false);
  });

  it("fail-closed on empty host: an empty / whitespace-only host denies", () => {
    expect(matchEgressAllow("", allowlist)).toBe(false);
    expect(matchEgressAllow("   ", allowlist)).toBe(false);
  });

  it("fail-closed: an empty/whitespace allowlist ENTRY is never a wildcard (even an empty host denies)", () => {
    // An effectively-empty entry normalizes to "" and would EXACTLY equal a normalized empty host via
    // `.some()`. Only the explicit empty-host guard prevents that ALLOW. Removing the guard MUST flip RED.
    const wildcardish = ["api.allowed.example", "  "];
    expect(matchEgressAllow("", wildcardish)).toBe(false);
    expect(matchEgressAllow("   ", wildcardish)).toBe(false);
  });
});

describe("matchEgressAllow — bypass resistance (exact host match only, never suffix/substring/dot)", () => {
  const bypasses: ReadonlyArray<readonly [string, string]> = [
    ["subdomain prefix (evil-...)", "evil-api.allowed.example"],
    ["suffix attack (...evil.com)", "api.allowed.example.evil.com"],
    ["embedded substring", "xapi.allowed.examplex"],
    ["bare parent without dot", "allowed.example"],
    ["leading dot", ".api.allowed.example"],
    ["trailing dot", "api.allowed.example."],
  ];
  for (const [label, host] of bypasses) {
    it(`denies a partial/near match: ${label}`, () => {
      expect(matchEgressAllow(host, allowlist)).toBe(false);
    });
  }
});

describe("egressDecisionForProjection — PDP defense-in-depth (any-host-not-allowed => deny)", () => {
  it("ALLOW: empty networkHosts => allow (no egress to gate)", () => {
    const d = egressDecisionForProjection([], allowlist);
    expect(d.effect).toBe("allow");
    expect(d.auditRequired).toBe(true);
  });

  it("ALLOW: every projected host is on the allowlist => allow", () => {
    const d = egressDecisionForProjection(
      ["api.allowed.example", "models.other.example"],
      allowlist,
    );
    expect(d.effect).toBe("allow");
  });

  it("DENY: any projected host not on the allowlist => deny (static reason)", () => {
    const d = egressDecisionForProjection(["api.allowed.example", "evil.com"], allowlist);
    expect(d.effect).toBe("deny");
    expect(d.auditRequired).toBe(true);
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it("DENY (deny-all default): a non-empty host list against an EMPTY allowlist denies", () => {
    const d = egressDecisionForProjection(["api.allowed.example"], []);
    expect(d.effect).toBe("deny");
  });

  it("credential-blind: the deny reason does NOT echo the offending host value", () => {
    const d = egressDecisionForProjection(["secret-internal.evil.example"], allowlist);
    expect(d.effect).toBe("deny");
    expect(d.reason).not.toContain("secret-internal.evil.example");
  });
});
