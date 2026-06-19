# Guardrails

Recurring failures and the guardrails that prevent them.

**Rule (Guardrails Learning Loop):** if the same failure appears **twice**, add an entry here —
symptom → root cause → guardrail — **before** continuing. See `AGENTS.md` and `docs/dev-loops.md`.

| Date | Symptom | Root cause | Guardrail (how we prevent recurrence) |
|------|---------|------------|----------------------------------------|
| 2026-06-19 | Cyclic deps / cross-module deep imports could erode low coupling unnoticed | HARD CONSTRAINT A was eye-enforced only | `deps:check` (dependency-cruiser: `no-circular`, `inward-only-domain-pure`, `not-to-internal`) is wired into `pnpm run verify` (SLICE-P0-003); violations exit non-zero. `src/iam/ids` is interim-allowlisted until the iam barrel-migration slice. |

## Tracked follow-ups (from adversarial review)

Non-blocking findings recorded for later slices (do not let them recur silently):

- **S0.3 review MINOR #1 — test files exempt from `not-to-internal`.** `.dependency-cruiser.cjs`
  excludes `*.test.ts`, so cross-module deep imports in tests are not gated (one benign instance
  exists today: `src/audit/event.test.ts` imports `../policy/evaluate.js`). Follow-up: either hold
  tests to the boundary rules with an allowlist for legitimate test imports, or keep the carve-out
  but assert it explicitly. Carve-out is documented in `.dependency-cruiser.cjs` (not silent).
- **S0.3 review MINOR #2 — top-barrel laundering.** `src/index.ts` does `export *` of module
  internals, so a sibling module could reach another module's behavior via `../index.js` and bypass
  `not-to-internal` (top-barrel is exempt). Follow-up: replace blanket `export *` with a curated
  public surface. Pairs naturally with the iam barrel-migration slice.
