/**
 * SLICE-CAP9 (RED-first) — the vendor-neutral host-write-target matcher + the PDP defense-in-depth
 * decision. A precise PARALLEL to CAP5's `egress-allowlist` (matchEgressAllow + egressDecisionForProjection).
 *
 * `matchHostWriteTarget(path, allowedRoots)` is the SINGLE SOURCE OF TRUTH: deny-by-default, LEXICAL
 * canonicalization (normalize `.`/`..` segments WITHOUT touching the FS — no realpath, no I/O), then
 * UNDER-ROOT containment with a `/` boundary (so `/allowedX` is NOT under `/allowed`; `/allowed/x` IS).
 * A relative path, an empty allowlist, an empty path, OR a path that normalizes to escape its root all
 * DENY. The allowed roots are normalized the SAME way.
 *
 * `hostWriteDecisionForProjection(writeTargets, hostWriteAllow)` is the PDP-side defense-in-depth layer:
 * ANY target failing the matcher returns a `deny` PolicyDecision (STATIC reason, a COUNT only — never a
 * path echoed; credential-blind, mirroring egressDecisionForProjection); empty writeTargets or all-allowed
 * => `allow`.
 *
 * HONEST BOUNDARY (per the spec): the REAL host-write enforcement is a DEPLOY FACT (sandbox host-mount +
 * kernel realpath, symlink-resistant). This lexical check is BEST-EFFORT defense-in-depth — it catches
 * `..` traversal / sibling-prefix / non-root / relative, but a symlink INSIDE an allowed root would slip
 * the lexical check (the substrate is PRIMARY). The PDP remains the sole DENY authority: this decision is
 * FOLDED into authorize (any-deny-wins), not a second runtime path.
 *
 * NON-VACUITY (asserted by the test design; the source twin is exercised+reverted in the RED→GREEN drive):
 * a mutation using a raw `path.startsWith(root)` (NO lexical normalization, NO `/` boundary) flips BOTH
 * the `/allowed/../etc/passwd` traversal test AND the `/allowedX` sibling-prefix test from DENY to ALLOW.
 */
import { describe, expect, it } from "vitest";
import { hostWriteDecisionForProjection, matchHostWriteTarget } from "./host-write-target.js";

const roots = ["/allowed", "/data/out"] as const;

describe("matchHostWriteTarget — under-root containment (deny-by-default, lexical canonicalization)", () => {
  it("ALLOW: a path under an allowed root passes", () => {
    expect(matchHostWriteTarget("/allowed/x", roots)).toBe(true);
    expect(matchHostWriteTarget("/data/out/sub/file.txt", roots)).toBe(true);
  });

  it("ALLOW: the allowed root ITSELF (equal to a root) passes", () => {
    expect(matchHostWriteTarget("/allowed", roots)).toBe(true);
    expect(matchHostWriteTarget("/data/out", roots)).toBe(true);
  });

  it("ALLOW: a `.` / nested `.` segment normalizes away and still passes", () => {
    // /allowed/./sub/x normalizes to /allowed/sub/x => under /allowed.
    expect(matchHostWriteTarget("/allowed/./sub/x", roots)).toBe(true);
    expect(matchHostWriteTarget("/allowed/sub/./deeper/../x", roots)).toBe(true);
  });

  it("ALLOW: trailing-slash and `//` normalize consistently (still under the root)", () => {
    expect(matchHostWriteTarget("/allowed/", roots)).toBe(true);
    expect(matchHostWriteTarget("/allowed//x", roots)).toBe(true);
    expect(matchHostWriteTarget("/allowed/x/", roots)).toBe(true);
  });

  it("ALLOW: a root entry given with a trailing slash normalizes the SAME (consistency)", () => {
    expect(matchHostWriteTarget("/allowed/x", ["/allowed/"])).toBe(true);
    expect(matchHostWriteTarget("/allowed", ["/allowed/"])).toBe(true);
  });
});

describe("matchHostWriteTarget — traversal & sibling-prefix resistance (the core new invariant)", () => {
  it("DENY: a `..` traversal that escapes the root (/allowed/../etc/passwd => /etc/passwd) is rejected", () => {
    // NON-VACUITY: a raw `startsWith(root)` mutation (no normalization) would ALLOW this — it flips RED.
    expect(matchHostWriteTarget("/allowed/../etc/passwd", roots)).toBe(false);
  });

  it("DENY: a multi-level traversal (/allowed/../../x) is rejected", () => {
    expect(matchHostWriteTarget("/allowed/../../x", roots)).toBe(false);
  });

  it("DENY: a sibling-prefix path (/allowedX) is NOT under /allowed (boundary, not string prefix)", () => {
    // NON-VACUITY: a raw `startsWith("/allowed")` mutation would ALLOW "/allowedX" — it flips RED.
    expect(matchHostWriteTarget("/allowedX", roots)).toBe(false);
    expect(matchHostWriteTarget("/allowed-evil/x", roots)).toBe(false);
  });

  it("DENY: a path that normalizes to a leading `..` (escapes above the FS root) is rejected", () => {
    expect(matchHostWriteTarget("/../etc/passwd", roots)).toBe(false);
  });
});

describe("matchHostWriteTarget — deny-by-default (relative / empty / no-allowlist)", () => {
  it("DENY: a relative path (no leading /) is rejected (absolute required)", () => {
    expect(matchHostWriteTarget("allowed/x", roots)).toBe(false);
    expect(matchHostWriteTarget("./allowed/x", roots)).toBe(false);
    expect(matchHostWriteTarget("../allowed/x", roots)).toBe(false);
  });

  it("DENY: an empty path is rejected", () => {
    expect(matchHostWriteTarget("", roots)).toBe(false);
  });

  it("fail-closed on empty: an empty allowlist denies every path", () => {
    expect(matchHostWriteTarget("/allowed/x", [])).toBe(false);
    expect(matchHostWriteTarget("/allowed", [])).toBe(false);
  });

  it("fail-closed: an effectively-empty / relative allowed-root entry is never a wildcard", () => {
    // An "" or relative root entry must NOT serve as an allow-all. Even a normal path under nothing denies.
    expect(matchHostWriteTarget("/allowed/x", [""])).toBe(false);
    expect(matchHostWriteTarget("/allowed/x", ["relative-root"])).toBe(false);
  });
});

describe("hostWriteDecisionForProjection — PDP defense-in-depth (any-target-not-allowed => deny)", () => {
  it("ALLOW: empty writeTargets => allow (no host-write to gate)", () => {
    const d = hostWriteDecisionForProjection([], roots);
    expect(d.effect).toBe("allow");
    expect(d.auditRequired).toBe(true);
  });

  it("ALLOW: every target under an allowed root => allow", () => {
    const d = hostWriteDecisionForProjection(["/allowed/a.txt", "/data/out/b.log"], roots);
    expect(d.effect).toBe("allow");
  });

  it("DENY: any target not under a root => deny (static reason)", () => {
    const d = hostWriteDecisionForProjection(["/allowed/a.txt", "/etc/passwd"], roots);
    expect(d.effect).toBe("deny");
    expect(d.auditRequired).toBe(true);
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it("DENY (deny-all default): a non-empty target list against an EMPTY allowlist denies", () => {
    const d = hostWriteDecisionForProjection(["/allowed/a.txt"], []);
    expect(d.effect).toBe("deny");
  });

  it("DENY: a traversal target is denied by the decision too (/allowed/../etc/passwd)", () => {
    const d = hostWriteDecisionForProjection(["/allowed/../etc/passwd"], roots);
    expect(d.effect).toBe("deny");
  });

  it("credential-blind: the deny reason does NOT echo the offending path value (count only)", () => {
    const d = hostWriteDecisionForProjection(["/secret/topology/keys.pem"], roots);
    expect(d.effect).toBe("deny");
    expect(d.reason).not.toContain("/secret/topology/keys.pem");
    expect(d.reason).not.toContain("keys.pem");
  });
});
