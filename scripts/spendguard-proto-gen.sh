#!/usr/bin/env bash
# Regenerate the SpendGuard SidecarAdapter types-only TS stub from the PINNED vendored proto subset
# and (re-)pin its sha256 manifest.
#
#   in  : src/runtime/spendguard/proto/sidecar_adapter.subset.proto   (vendored subset; source of truth)
#   out : src/runtime/spendguard/_generated/sidecar_adapter.ts        (GENERATED types-only; DO NOT EDIT)
#         src/runtime/spendguard/proto/sidecar_adapter.subset.sha256  (pin manifest of the proto)
#
# The stub is a TYPE-ONLY contract (onlyTypes=true): zero runtime imports, no RPC client — it only
# fixes the TS face of the SidecarAdapter session-reservation lifecycle so R11-S6's real grpc-js
# transport (confined to src/runtime/spendguard/) can import it. Timestamps map to ISO strings
# (useDate=string) so the generated file is self-sufficient with NO cross-proto imports.
#
# Run this intentionally to re-pin after a deliberate proto subset change. Drift is then caught by
# `pnpm run spendguard:proto:check`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROTO_DIR="$ROOT/src/runtime/spendguard/proto"
PROTO_FILE="$PROTO_DIR/sidecar_adapter.subset.proto"
OUT_DIR="$ROOT/src/runtime/spendguard/_generated"
MANIFEST="$PROTO_DIR/sidecar_adapter.subset.sha256"

export PATH="$ROOT/node_modules/.bin:$PATH"

# Well-known types (google/protobuf/timestamp.proto) live in the protoc include dir.
WKT_INCLUDE=""
for cand in /opt/homebrew/include /usr/local/include /usr/include; do
  if [ -f "$cand/google/protobuf/timestamp.proto" ]; then WKT_INCLUDE="$cand"; break; fi
done
if [ -z "$WKT_INCLUDE" ]; then
  echo "spendguard:proto:gen: FAIL — google/protobuf/timestamp.proto not found in protoc include path" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
protoc \
  --proto_path="$PROTO_DIR" \
  --proto_path="$WKT_INCLUDE" \
  --ts_proto_out="$TMP" \
  --ts_proto_opt='onlyTypes=true,esModuleInterop=true,oneof=unions,importSuffix=.js,useDate=string' \
  "$PROTO_FILE"

mkdir -p "$OUT_DIR"
# Copy ONLY the subset stub; the (unused) google/protobuf/timestamp.ts byproduct is discarded —
# useDate=string means the main file references no Timestamp type, so it is self-sufficient.
cp "$TMP/sidecar_adapter.subset.ts" "$OUT_DIR/sidecar_adapter.ts"
echo "spendguard:proto:gen: regenerated $OUT_DIR/sidecar_adapter.ts"

if command -v sha256sum >/dev/null 2>&1; then
  HASH_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  HASH_CMD="shasum -a 256"
else
  echo "spendguard:proto:gen: FAIL — no sha256 tool present (sha256sum / shasum)" >&2
  exit 1
fi
( cd "$PROTO_DIR" && $HASH_CMD "sidecar_adapter.subset.proto" > "$MANIFEST" )
echo "spendguard:proto:gen: re-pinned $MANIFEST"
