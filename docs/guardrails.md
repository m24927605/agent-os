# Guardrails

Recurring failures and the guardrails that prevent them.

**Rule (Guardrails Learning Loop):** if the same failure appears **twice**, add an entry here —
symptom → root cause → guardrail — **before** continuing. See `AGENTS.md` and `docs/dev-loops.md`.

| Date | Symptom | Root cause | Guardrail (how we prevent recurrence) |
|------|---------|------------|----------------------------------------|
| 2026-06-19 | Cyclic deps / cross-module deep imports could erode low coupling unnoticed | HARD CONSTRAINT A was eye-enforced only | `deps:check` (dependency-cruiser: `no-circular`, `inward-only-domain-pure`, `not-to-internal`) is wired into `pnpm run verify` (SLICE-P0-003); violations exit non-zero. `src/iam/ids` is interim-allowlisted until the iam barrel-migration slice. |
| 2026-06-19 | `go build/test` fails: `compile: version "go1.24.3" does not match go tool version "go1.22.4"` | gvm exports `GOROOT` (go1.24.3 stdlib) in the shell profile, but the `go` first on PATH is brew's 1.22.4 → compiler/stdlib mismatch | Run Go under `env -u GOROOT` so `go` uses its own bundled GOROOT. `verify:go` (package.json) is `env -u GOROOT CGO_ENABLED=0 bash scripts/verify-go.sh`; all P1 Go commands use `env -u GOROOT`. golangci-lint v1.60.3 installed as a PREBUILT binary (not `go install`, which hits the same mismatch). Fix the env properly (align gvm/PATH) when convenient. |
| 2026-06-20 | Go test binary crashes at load: `dyld: missing LC_UUID load command / abort trap` (e.g. the `chain` test importing `crypto/x509`) | On macOS `crypto/x509` pulls in cgo (Security.framework) → external linker, which under this broken toolchain emits a binary without `LC_UUID` that modern dyld rejects | Build/test Go with `CGO_ENABLED=0` (pure-Go x509 + internal linker; we don't use system roots). It is set in the `verify:go` script env and in all P1 Go commands. |

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
- **S0.8 review MINOR — Go cascade empty-plane guard (for the P1 kernel slice).** `scripts/verify-go.sh`
  relies on `go vet ./...` exiting non-zero for a zero-package plane to prevent fake-green; this is
  Go-version-dependent. When the P1 Go kernel slice lands the real gate, add an explicit
  "packages exist" assertion + a real `.golangci.yml` + ensure `golangci-lint` is required.
- **S0.8 review MINOR — py cascade `uvx`/`ruff` diagnostic (for the P3 SDK slice).** `scripts/verify-py.sh`
  accepts `uvx` in the toolchain check but the gate invokes bare `ruff`; still fail-closed (safe), but
  the failure message is misleading. Fix when the P3 Python gate is implemented (invoke via `uvx ruff`
  when only `uvx` is present).
