#!/usr/bin/env bash
# Guard the VENDORED SpendGuard SidecarAdapter proto subset + its generated types-only TS stub
# against drift.
#
# Two fail-closed checks (mirrors scripts/openshell-proto-check.sh + the TS gate in
# scripts/proto-check.sh):
#   1. PIN: src/runtime/spendguard/proto/sidecar_adapter.subset.proto must match the committed
#      sha256 manifest (sidecar_adapter.subset.sha256). Editing the subset without re-pinning (or
#      vice versa) => RED.
#   2. STUB DRIFT: if the protoc + ts-proto toolchain is present, regenerate the TS stub to a temp
#      dir and diff against the committed src/runtime/spendguard/_generated/sidecar_adapter.ts.
#      Proto changed but stub did not (or stub missing) => RED. Toolchain absent (CI provisioning)
#      => skip the regen check cleanly, same as scripts/proto-check.sh.
#
# Drift is caught by the universal `pnpm run verify` exit code, not by anyone remembering to look.
# SPENDGUARD_PROTO_DIR overrides the proto dir (test isolation): pointing it at an empty dir proves
# the gate fails closed when the vendored subset / manifest is missing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROTO_DIR="${SPENDGUARD_PROTO_DIR:-$ROOT/src/runtime/spendguard/proto}"
PROTO_FILE="$PROTO_DIR/sidecar_adapter.subset.proto"
MANIFEST="$PROTO_DIR/sidecar_adapter.subset.sha256"
STUB="$ROOT/src/runtime/spendguard/_generated/sidecar_adapter.ts"

if [ ! -f "$PROTO_FILE" ]; then
  echo "spendguard:proto:check: FAIL — vendored subset missing: $PROTO_FILE" >&2; exit 1
fi
if [ ! -f "$MANIFEST" ]; then
  echo "spendguard:proto:check: FAIL — pin manifest missing: $MANIFEST" >&2; exit 1
fi
if [ ! -f "$STUB" ]; then
  echo "spendguard:proto:check: FAIL — generated TS stub missing: $STUB (run: pnpm run spendguard:proto:gen)" >&2
  exit 1
fi

# --- (1) PIN check ---
if command -v sha256sum >/dev/null 2>&1; then
  HASH_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  HASH_CMD="shasum -a 256"
else
  echo "spendguard:proto:check: skip — no sha256 tool present"
  exit 0
fi

ACTUAL="$($HASH_CMD "$PROTO_FILE" | awk '{print $1}')"
EXPECTED="$(awk '{print $1}' "$MANIFEST")"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "spendguard:proto:check: FAIL — vendored proto subset drifted from pin" >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $ACTUAL" >&2
  echo "  (re-pin intentionally with: pnpm run spendguard:proto:gen)" >&2
  exit 1
fi
echo "spendguard:proto:check: pin ok"

# --- (2) STUB DRIFT check (regenerate + diff) ---
TS_PLUGIN="$ROOT/node_modules/.bin/protoc-gen-ts_proto"
if ! command -v protoc >/dev/null 2>&1 || [ ! -x "$TS_PLUGIN" ]; then
  echo "spendguard:proto:check: skip stub-regen — protoc/ts-proto toolchain not present"
  echo "spendguard:proto:check: ok"
  exit 0
fi

WKT_INCLUDE=""
for cand in /opt/homebrew/include /usr/local/include /usr/include; do
  if [ -f "$cand/google/protobuf/timestamp.proto" ]; then WKT_INCLUDE="$cand"; break; fi
done
if [ -z "$WKT_INCLUDE" ]; then
  echo "spendguard:proto:check: FAIL — google/protobuf/timestamp.proto not found (fail-closed)" >&2; exit 1
fi

export PATH="$ROOT/node_modules/.bin:$PATH"
TS_TMP="$(mktemp -d)"
trap 'rm -rf "$TS_TMP"' EXIT
if ! protoc \
  --proto_path="$PROTO_DIR" \
  --proto_path="$WKT_INCLUDE" \
  --ts_proto_out="$TS_TMP" \
  --ts_proto_opt='onlyTypes=true,esModuleInterop=true,oneof=unions,importSuffix=.js,useDate=string' \
  "$PROTO_FILE"; then
  echo "spendguard:proto:check: FAIL — TS stub generation failed (fail-closed)" >&2; exit 1
fi
if ! diff -q "$TS_TMP/sidecar_adapter.subset.ts" "$STUB" >/dev/null 2>&1; then
  echo "spendguard:proto:check: FAIL — sidecar_adapter.ts drifted from the vendored subset (run: pnpm run spendguard:proto:gen)" >&2
  exit 1
fi
echo "spendguard:proto:check: stub ok"
echo "spendguard:proto:check: ok"
