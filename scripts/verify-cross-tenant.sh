#!/usr/bin/env bash
# verify:cross-tenant — RELEASE-BLOCKING cross-tenant conformance gate (R8-S6).
#
# Re-proves the R8 multi-tenant spine's isolation invariants on EVERY commit, across BOTH planes:
#   - TS plane: src/tenant/conformance/cross-tenant.conformance.test.ts
#       (boundary 1 routing R8-S1, boundary 2 persistence R8-S2, boundary 3 maker-checker R8-S5)
#   - Go plane: kernel/internal/partition  -run Conformance
#       (boundary 3 per-tenant kernel partition R8-S3: chains-do-not-entangle + wrong-key-rejected)
#
# ANY single boundary leaking => a failing test => this script exits != 0 => `pnpm run verify` exits
# != 0 => the pre-commit guard blocks the merge. FAIL-CLOSED: any leg failing fails the whole gate.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLANE="${VERIFY_GO_PLANE:-$ROOT/kernel}"

# Self-defend the Go leg against a stale host GOROOT / toolchain-version skew (mirror verify:go's
# invocation contract) so a DIRECT `bash scripts/verify-cross-tenant.sh` — e.g. from CI or an
# independent verifier — does not FALSE-FAIL on a GOROOT-vs-PATH-`go` mismatch and misreport it as a
# kernel partition leak. The pnpm `verify:cross-tenant` wrapper already sets these; make the script robust on its own.
export GOTOOLCHAIN=local
export CGO_ENABLED=0
unset GOROOT

echo "verify:cross-tenant: TS plane — cross-tenant.conformance"
( cd "$ROOT" && node_modules/.bin/vitest run src/tenant/conformance ) ||
  { echo "verify:cross-tenant: FAIL — TS cross-tenant conformance failed (a TS boundary leaked)" >&2; exit 1; }

# The Go partition plane is part of the kernel Go module; mirror verify:go's skip-when-absent shape.
if [ ! -d "$PLANE" ]; then
  echo "verify:cross-tenant: skip Go plane — no kernel ($PLANE absent)"
  echo "verify:cross-tenant: ok"
  exit 0
fi

command -v go >/dev/null 2>&1 ||
  { echo "verify:cross-tenant: FAIL — 'go' toolchain not installed (Go partition conformance unrunnable)" >&2; exit 1; }

echo "verify:cross-tenant: Go plane — internal/partition -run Conformance"
( cd "$PLANE" && go test ./internal/partition -run Conformance ) ||
  { echo "verify:cross-tenant: FAIL — Go partition conformance failed (kernel partition leaked)" >&2; exit 1; }

echo "verify:cross-tenant: ok"
