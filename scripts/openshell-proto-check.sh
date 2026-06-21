#!/usr/bin/env bash
# Guard the VENDORED OpenShell proto subset (Strategy B, no fork) against drift.
#
# The subset src/runtime/openshell/proto/openshell.subset.proto is pinned to an upstream OpenShell
# revision; its committed sha256 manifest (openshell.subset.sha256) is the contract. If the vendored
# subset is edited without re-pinning the manifest (or vice versa), this gate is RED — so drift is
# caught by the universal `pnpm run verify` exit code, not by anyone remembering to look.
#
# Mirrors scripts/proto-check.sh's skip/diff philosophy: if NO sha256 tool is present (sha256sum or
# shasum), skip cleanly (exit 0) — same as the verify:go cascade. Both tools are standard on
# Linux/macOS, so in practice this gate always runs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROTO_DIR="$ROOT/src/runtime/openshell/proto"
PROTO_FILE="$PROTO_DIR/openshell.subset.proto"
MANIFEST="$PROTO_DIR/openshell.subset.sha256"

if [ ! -f "$PROTO_FILE" ]; then
  echo "openshell:proto:check: FAIL — vendored subset missing: $PROTO_FILE" >&2; exit 1
fi
if [ ! -f "$MANIFEST" ]; then
  echo "openshell:proto:check: FAIL — pin manifest missing: $MANIFEST" >&2; exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  HASH_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  HASH_CMD="shasum -a 256"
else
  echo "openshell:proto:check: skip — no sha256 tool present"
  exit 0
fi

ACTUAL="$($HASH_CMD "$PROTO_FILE" | awk '{print $1}')"
EXPECTED="$(awk '{print $1}' "$MANIFEST")"

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "openshell:proto:check: FAIL — vendored proto subset drifted from pin" >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $ACTUAL" >&2
  echo "  (re-pin intentionally with: $HASH_CMD $PROTO_FILE, update $MANIFEST)" >&2
  exit 1
fi

echo "openshell:proto:check: ok"
