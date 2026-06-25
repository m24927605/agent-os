#!/usr/bin/env bash
# Guard OUR AGT AgtDecision proto + its generated types-only TS stub against drift. Mirrors
# scripts/spendguard-proto-check.sh (this is OUR contract, not a vendored subset — the pin guards our
# own contract against accidental edits).
#
# Two fail-closed checks:
#   1. PIN: src/runtime/agt/proto/agt_decision.subset.proto must match the committed sha256 manifest
#      (agt_decision.subset.sha256). Editing the proto without re-pinning (or vice versa) => RED.
#   2. STUB DRIFT: if the protoc + ts-proto toolchain is present, regenerate the TS stub to a temp dir
#      and diff against the committed src/runtime/agt/_generated/agt_decision.ts. Proto changed but
#      stub did not (or stub missing) => RED. Toolchain absent (CI provisioning) => skip the regen
#      check cleanly, same as scripts/spendguard-proto-check.sh.
#
# Drift is caught by the universal `pnpm run verify` exit code, not by anyone remembering to look.
# AGT_PROTO_DIR overrides the proto dir (test isolation): pointing it at an empty dir proves the gate
# fails closed when the proto / manifest is missing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROTO_DIR="${AGT_PROTO_DIR:-$ROOT/src/runtime/agt/proto}"
PROTO_FILE="$PROTO_DIR/agt_decision.subset.proto"
MANIFEST="$PROTO_DIR/agt_decision.subset.sha256"
STUB="$ROOT/src/runtime/agt/_generated/agt_decision.ts"

if [ ! -f "$PROTO_FILE" ]; then
  echo "agt:proto:check: FAIL — AGT proto missing: $PROTO_FILE" >&2; exit 1
fi
if [ ! -f "$MANIFEST" ]; then
  echo "agt:proto:check: FAIL — pin manifest missing: $MANIFEST" >&2; exit 1
fi
if [ ! -f "$STUB" ]; then
  echo "agt:proto:check: FAIL — generated TS stub missing: $STUB (run: pnpm run agt:proto:gen)" >&2
  exit 1
fi

# --- (1) PIN check ---
if command -v sha256sum >/dev/null 2>&1; then
  HASH_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  HASH_CMD="shasum -a 256"
else
  echo "agt:proto:check: skip — no sha256 tool present"
  exit 0
fi

ACTUAL="$($HASH_CMD "$PROTO_FILE" | awk '{print $1}')"
EXPECTED="$(awk '{print $1}' "$MANIFEST")"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "agt:proto:check: FAIL — AGT proto drifted from pin" >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $ACTUAL" >&2
  echo "  (re-pin intentionally with: pnpm run agt:proto:gen)" >&2
  exit 1
fi
echo "agt:proto:check: pin ok"

# --- (2) STUB DRIFT check (regenerate + diff) ---
TS_PLUGIN="$ROOT/node_modules/.bin/protoc-gen-ts_proto"
if ! command -v protoc >/dev/null 2>&1 || [ ! -x "$TS_PLUGIN" ]; then
  echo "agt:proto:check: skip stub-regen — protoc/ts-proto toolchain not present"
  echo "agt:proto:check: ok"
  exit 0
fi

export PATH="$ROOT/node_modules/.bin:$PATH"
TS_TMP="$(mktemp -d)"
trap 'rm -rf "$TS_TMP"' EXIT
if ! protoc \
  --proto_path="$PROTO_DIR" \
  --ts_proto_out="$TS_TMP" \
  --ts_proto_opt='onlyTypes=true,esModuleInterop=true,oneof=unions,importSuffix=.js,useDate=string' \
  "$PROTO_FILE"; then
  echo "agt:proto:check: FAIL — TS stub generation failed (fail-closed)" >&2; exit 1
fi
if ! diff -q "$TS_TMP/agt_decision.subset.ts" "$STUB" >/dev/null 2>&1; then
  echo "agt:proto:check: FAIL — agt_decision.ts drifted from the proto (run: pnpm run agt:proto:gen)" >&2
  exit 1
fi
echo "agt:proto:check: stub ok"
echo "agt:proto:check: ok"
