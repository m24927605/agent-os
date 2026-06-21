/**
 * RED-first: egress host deny-by-default + fail-closed + bypass-resistance assertions.
 *
 * SLICE-P2R-R6-S2 (see docs/slices/phase-2-remaining/P2R-R6-S2-egress-allowlist-interim.md,
 * docs/design/inference-routing-gate.md §2.1 / §4.1 / §5). `isEgressAllowed` is the SECOND
 * chokepoint gate: only an explicitly-allowlisted egress host (exact match, case-insensitive)
 * may pass; everything else denies. Aligns with OpenShell deny-by-default egress as an interim
 * core-side guard before the real adapter (R1/R11) lands.
 */
import { describe, expect, it } from "vitest";
import { isEgressAllowed } from "./egress-allowlist.js";
import { type EgressAllowlist, InferenceRequest } from "./types.js";

const ctx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
} as const;

const allowlist: EgressAllowlist = ["api.allowed.example", "models.other.example"];

// Parse through the schema so branded id fields are produced and `egressHost` round-trips exactly
// as a downstream (already-validated) request would reach this second-chokepoint gate.
const req = (egressHost: string): InferenceRequest =>
  InferenceRequest.parse({
    model: "m1",
    providerType: "p1",
    egressHost,
    estimatedTokens: 100,
    ...ctx,
  });

describe("isEgressAllowed — egress host deny-by-default (second chokepoint)", () => {
  it("ALLOW: an exact-match allowlisted host passes", () => {
    const out = isEgressAllowed(req("api.allowed.example"), allowlist);
    expect(out.allowed).toBe(true);
  });

  it("deny-by-default: an unknown host denies", () => {
    const out = isEgressAllowed(req("api.unknown.example"), allowlist);
    expect(out.allowed).toBe(false);
  });

  it("deny-by-default: an effectively-empty (whitespace-only) host denies (defense-in-depth)", () => {
    // The schema forbids an empty host, so such a value cannot arrive via parse. We assert the
    // gate's own fail-closed guard directly: even if a malformed-but-typed request reached it, an
    // empty/whitespace host must deny, never be treated as a wildcard.
    const empty = { ...req("api.allowed.example"), egressHost: "   " } as InferenceRequest;
    expect(isEgressAllowed(empty, allowlist).allowed).toBe(false);
    const blank = { ...req("api.allowed.example"), egressHost: "" } as InferenceRequest;
    expect(isEgressAllowed(blank, allowlist).allowed).toBe(false);
  });

  it("deny-by-default: an empty allowlist denies every host", () => {
    expect(isEgressAllowed(req("api.allowed.example"), []).allowed).toBe(false);
    expect(isEgressAllowed(req("models.other.example"), []).allowed).toBe(false);
  });

  it("fail-closed: an empty/whitespace allowlist ENTRY is never a wildcard — even an empty/whitespace host denies", () => {
    // Locks the empty-host guard against a non-vacuous mutation: an effectively-empty allowlist
    // entry normalizes to "" and would EXACTLY equal a normalized empty/whitespace host via the
    // `.some()` branch. Only the explicit empty-host guard prevents that from ALLOWING egress, so
    // removing the guard (e.g. `if (host.length === 0)` -> `if (false)`) MUST turn this RED.
    const wildcardish: EgressAllowlist = ["api.allowed.example", "  "];
    const blank = { ...req("api.allowed.example"), egressHost: "" } as InferenceRequest;
    const ws = { ...req("api.allowed.example"), egressHost: "   " } as InferenceRequest;
    expect(isEgressAllowed(blank, wildcardish).allowed).toBe(false);
    expect(isEgressAllowed(ws, wildcardish).allowed).toBe(false);
  });
});

describe("isEgressAllowed — bypass resistance (fail-closed, exact host match only)", () => {
  const bypasses: ReadonlyArray<readonly [string, string]> = [
    ["subdomain prefix (evil-... )", "evil-api.allowed.example"],
    ["suffix attack (...evil.com)", "api.allowed.example.evil.com"],
    ["embedded substring", "xapi.allowed.examplex"],
    ["bare suffix without dot", "allowed.example"],
    ["leading dot", ".api.allowed.example"],
    ["trailing dot", "api.allowed.example."],
  ];

  for (const [label, host] of bypasses) {
    it(`denies a partial/near match: ${label}`, () => {
      expect(isEgressAllowed(req(host), allowlist).allowed).toBe(false);
    });
  }
});

describe("isEgressAllowed — case-insensitive exact match", () => {
  it("ALLOW: differently-cased host normalizes and matches", () => {
    expect(isEgressAllowed(req("API.Allowed.Example"), allowlist).allowed).toBe(true);
  });

  it("ALLOW: a differently-cased allowlist entry still matches a lowercase host", () => {
    expect(isEgressAllowed(req("api.allowed.example"), ["API.ALLOWED.EXAMPLE"]).allowed).toBe(true);
  });
});

describe("isEgressAllowed — reason does not leak the request payload", () => {
  it("a deny reason names the gate / static text and does not echo the whole request object", () => {
    const out = isEgressAllowed(req("api.secret.host"), allowlist);
    expect(out.allowed).toBe(false);
    if (!out.allowed) {
      expect(out.reason.length).toBeGreaterThan(0);
      // reason may name the gate but must not echo other request fields (e.g. the model id).
      expect(out.reason).not.toContain("agent:claude");
      expect(out.reason).not.toContain("tenant-a");
    }
  });
});
