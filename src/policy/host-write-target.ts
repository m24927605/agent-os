/**
 * SLICE-CAP9 — the vendor-neutral host-write-target PRIMITIVE: the SINGLE SOURCE OF TRUTH for the
 * deny-by-default, LEXICAL, fail-closed host write-target matcher, plus the PDP-side defense-in-depth
 * decision built on it. A precise PARALLEL to CAP5's `egress-allowlist` (matchEgressAllow +
 * egressDecisionForProjection).
 *
 * Where CAP5 made "network egress" an explicit per-tool deny-all primitive, CAP9 does the same for
 * "host disk write" (a sandbox writing to the host persistence layer, escaping the ephemeral sandbox):
 * an explicit, per-tool, canonical-path-allowlist, deny-all-by-default primitive. Two invariants hold by
 * construction:
 *   - deny-by-default: only a path that, after LEXICAL canonicalization, is EQUAL TO or UNDER an allowed
 *     root (with a `/` boundary) passes. An empty allowlist, a relative path, an empty path, OR a path
 *     that normalizes to escape its root (a leading `..`) all DENY.
 *   - traversal / sibling-prefix resistance: matching is on the CANONICAL path under a `/` boundary —
 *     NOT a raw string prefix. `/allowed/../etc/passwd` (normalizes to `/etc/passwd`), `/allowedX` (a
 *     sibling whose name merely shares the `/allowed` prefix), and `/allowed/../../x` must NOT match an
 *     allowed root of `/allowed`. `/allowed/./sub/x` (normalizes to `/allowed/sub/x`) DOES.
 *
 * LEXICAL ONLY (the honest boundary, per the spec): canonicalization normalizes `.`/`..`/`//`/trailing
 * slash WITHOUT touching the filesystem — NO `fs`, NO `realpath`. So a SYMLINK inside an allowed root
 * would slip this lexical check. The REAL host-write enforcement is a DEPLOY FACT (sandbox host-mount +
 * kernel realpath, symlink-resistant); the substrate seal is PRIMARY. This lexical check is BEST-EFFORT
 * defense-in-depth — it catches `..` traversal / sibling-prefix / non-root / relative, never claims to
 * resolve symlinks. The PDP remains the sole DENY authority: the decision is FOLDED into authorize
 * (any-deny-wins), not a second runtime path.
 *
 * VENDOR-NEUTRALITY: lives in the policy core zone. Imports ONLY the neutral `PolicyDecision` type from
 * this module's own `types.ts` — no vendor token, so `no-vendor-in-core` holds and the substrate/bin
 * layers can re-use it via the policy barrel.
 *
 * PURE: no I/O, no throw on normal input.
 */
import type { PolicyDecision } from "./types.js";

/** The PDP host-write defense-in-depth reason — STATIC gate text; it never echoes a path value. */
const HOST_WRITE_GATE = "policy.host-write-target";

/**
 * LEXICAL path canonicalization — a PURE, FS-free normalize. Splits on `/`, drops empty (`//`, trailing
 * slash) and `.` segments, and resolves `..` against a segment STACK. Returns:
 *   - `undefined` when the input is NOT an absolute POSIX path (no leading `/`) OR is empty — a relative
 *     path can never be matched (deny-by-default; the caller treats `undefined` as a non-match);
 *   - `undefined` when the path normalizes to ESCAPE the filesystem root (a `..` that pops past `/`) —
 *     a path that climbs above `/` is rejected, never silently clamped;
 *   - otherwise the canonical absolute path: `/` for the root, else `/seg1/seg2/...` with NO trailing
 *     slash (so two forms that mean the same place canonicalize to the SAME string).
 *
 * Examples: `/allowed//x` -> `/allowed/x`; `/allowed/` -> `/allowed`; `/allowed/./sub/x` ->
 * `/allowed/sub/x`; `/allowed/../etc/passwd` -> `/etc/passwd`; `/../x` -> `undefined` (escapes root);
 * `allowed/x` -> `undefined` (relative).
 */
function canonicalizeAbsolute(path: string): string | undefined {
  // Absolute-only: a relative path (or empty) can never be a host-write target (deny-by-default).
  if (path.length === 0 || path[0] !== "/") return undefined;
  const stack: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      // Empty (from a leading `/`, `//`, or trailing `/`) and `.` contribute no path component.
      continue;
    }
    if (segment === "..") {
      // Climb up one component. A `..` with no parent on the stack escapes the FS root => reject.
      if (stack.length === 0) return undefined;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  // The FS root canonicalizes to "/"; otherwise join with a single leading "/" and NO trailing slash.
  return stack.length === 0 ? "/" : `/${stack.join("/")}`;
}

/**
 * Deny-by-default under-root containment check. `true` iff `path` LEXICALLY canonicalizes to an absolute
 * path that EQUALS some allowed root (also canonicalized) OR is UNDER it with a `/` boundary. NO raw
 * string-prefix matching (so `/allowedX` is NOT under `/allowed`); NO filesystem / realpath (lexical
 * only — a symlink inside a root slips this, see the module header). A relative / empty / root-escaping
 * path, OR an empty allowlist, all DENY.
 */
export function matchHostWriteTarget(path: string, allowedRoots: readonly string[]): boolean {
  const target = canonicalizeAbsolute(path);
  // deny-by-default: a relative / empty / root-escaping path can never be on the allowlist.
  if (target === undefined) return false;
  return allowedRoots.some((rawRoot) => {
    const root = canonicalizeAbsolute(rawRoot);
    // An effectively-empty / relative root entry is never a wildcard (canonicalizeAbsolute => undefined).
    if (root === undefined) return false;
    // Exact match: the target IS the root.
    if (target === root) return true;
    // Under-root with a `/` boundary. The FS root "/" already ends in "/", so do not double-append it;
    // otherwise the boundary is `${root}/` — `/allowedX` fails this (`/allowed/` is not its prefix).
    const prefix = root === "/" ? "/" : `${root}/`;
    return target.startsWith(prefix);
  });
}

/**
 * The PDP-side host-write defense-in-depth decision (SLICE-CAP9). For a tool whose credential-blind
 * governance projection carries `writeTargets`, the bin's authorize closure folds THIS decision in
 * alongside the PDP + egress + advisory secondaries (any-deny-wins):
 *   - empty `writeTargets` => `allow` (no host-write to gate);
 *   - EVERY target under an allowed root (via `matchHostWriteTarget`) => `allow`;
 *   - ANY target NOT under an allowed root => `deny` with a STATIC reason that names a COUNT of
 *     unallowed targets only — never the offending path value (credential-blind; a path may carry
 *     sensitive deployment topology). An empty allowlist + a non-empty target list therefore denies
 *     (deny-all).
 *
 * HONEST BOUNDARY: the substrate seal (sandbox host-mount + kernel realpath) is the PRIMARY host-write
 * enforcement (symlink-resistant). This is a BEST-EFFORT secondary check — a symlink inside an allowed
 * root could slip the LEXICAL matcher — so it strengthens, never replaces, the substrate. The PDP
 * remains the sole DENY authority: this decision is FOLDED INTO authorize (any-deny-wins), not a second
 * runtime path.
 *
 * PURE: no I/O, no throw.
 */
export function hostWriteDecisionForProjection(
  writeTargets: readonly string[],
  hostWriteAllow: readonly string[],
): PolicyDecision {
  const unallowed = writeTargets.filter((p) => !matchHostWriteTarget(p, hostWriteAllow));
  if (unallowed.length > 0) {
    return {
      // STATIC reason: a COUNT only (never the path value) — credential-blind, deny-by-default.
      effect: "deny",
      reason: `${HOST_WRITE_GATE}: ${unallowed.length} write target(s) not under an allowed root (deny-by-default)`,
      auditRequired: true,
    };
  }
  return {
    effect: "allow",
    reason: `${HOST_WRITE_GATE}: all ${writeTargets.length} write target(s) under an allowed root`,
    auditRequired: true,
  };
}
