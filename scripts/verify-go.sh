#!/usr/bin/env bash
# verify:go — polyglot cascade leg (FAIL-CLOSED). See docs/slices/phase-0/S0.8-verify-cascade.md.
#
# No Go plane yet  => skip (exit 0).
# Go plane present but gate unconfigured (toolchain / go.mod / lint config missing) => FAIL (exit 1).
# Never no-op-green: a silent pass is indistinguishable from a real gate pass and would hide a gap.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLANE="${VERIFY_GO_PLANE:-$ROOT/kernel}"

if [ ! -d "$PLANE" ]; then
  echo "verify:go: skip — no Go plane (${PLANE} absent)"
  exit 0
fi

echo "verify:go: Go plane present (${PLANE}) — gate must be configured (fail-closed)"
fail=0
command -v go >/dev/null 2>&1 || { echo "  FAIL: 'go' toolchain not installed" >&2; fail=1; }
[ -f "${PLANE}/go.mod" ] || { echo "  FAIL: go.mod missing" >&2; fail=1; }
{ [ -f "${PLANE}/.golangci.yml" ] || [ -f "${PLANE}/.golangci.yaml" ]; } ||
  { echo "  FAIL: lint gate (.golangci.yml) missing" >&2; fail=1; }
if [ "$fail" -ne 0 ]; then
  echo "verify:go: FAIL — Go plane present but gate unconfigured (configure it in the P1 kernel slice)" >&2
  exit 1
fi

# Fully configured: run the language gate.
( cd "$PLANE" && go vet ./... && go test ./... && golangci-lint run ) ||
  { echo "verify:go: FAIL — Go gate failed" >&2; exit 1; }
echo "verify:go: ok"
