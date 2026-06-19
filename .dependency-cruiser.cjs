/**
 * Dependency-boundary rules — enforces HARD CONSTRAINT A (low coupling / high cohesion).
 * See AGENTS.md ("Low coupling, high cohesion") and docs/standards/engineering-standards.md.
 *
 * Wired into `pnpm run verify` via `deps:check` (SLICE-P0-003). Any violation exits non-zero,
 * so the constraint is enforced by command, not by eye.
 *
 * Scope note (SLICE-P0-003): `no-circular` and `inward-only-domain-pure` are enforced now and the
 * current scaffold already complies. `not-to-internal` forbids NEW cross-module deep imports; the
 * pre-barrel entry `src/iam/ids` is interim-allowlisted until the barrel-migration slice adds
 * `src/iam/index.ts` and removes the exemption. Top-level `src/index.ts` is the repo public
 * barrel and is intentionally exempt (it aggregates module surfaces).
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "No dependency cycles anywhere (low coupling).",
      from: {},
      to: { circular: true },
    },
    {
      name: "inward-only-domain-pure",
      severity: "error",
      comment:
        "Domain (src/iam) must not depend on any outer module — dependencies point inward " +
        "(domain <- application <- adapters).",
      from: { path: "^src/iam/" },
      to: { path: "^src/(?!iam/)[^/]+/" },
    },
    {
      name: "not-to-internal",
      severity: "error",
      comment:
        "Consume another module only via its public surface (its index barrel). No deep import " +
        "into a module's internals. Interim allowlist: src/iam/ids (removed in the barrel-migration slice).",
      from: { path: "^src/([^/]+)/" },
      to: {
        path: "^src/[^/]+/.+",
        pathNot: [
          "^src/$1/", // same module — intra-module imports are fine (cohesion)
          "^src/[^/]+/index\\.ts$", // a module's public barrel
          "^src/iam/ids\\.ts$", // interim pre-barrel entry; remove in barrel-migration slice
        ],
      },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    // Carve-out (review MINOR #1, tracked follow-up): test files are excluded so existing test
    // fixtures (e.g. audit test importing policy) do not trip the cross-module rules. This is an
    // EXPLICIT, intentional gap — not silent. Revisit: hold tests to `not-to-internal` with an
    // allowlist for legitimate test imports (see docs/guardrails.md follow-ups).
    exclude: { path: "\\.test\\.ts$" },
    doNotFollow: { dependencyTypes: ["npm", "npm-dev", "npm-peer", "npm-optional", "core"] },
  },
};
