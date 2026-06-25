#!/usr/bin/env bash
# Regenerate the AGT AgtDecision types-only TS stub from OUR pinned AGT decision proto and (re-)pin its
# sha256 manifest. Mirrors scripts/spendguard-proto-gen.sh.
#
#   in  : src/runtime/agt/proto/agt_decision.subset.proto   (OUR contract; source of truth)
#   out : src/runtime/agt/_generated/agt_decision.ts         (GENERATED types-only; DO NOT EDIT)
#         src/runtime/agt/proto/agt_decision.subset.sha256   (pin manifest of the proto)
#
# The stub is a TYPE-ONLY contract (onlyTypes=true): zero runtime imports, no RPC client — it only
# fixes the TS face of the AGT Evaluate contract so the real grpc-js transport (confined to
# src/runtime/agt/) can import it. The proto uses NO well-known types, so the generated file is
# self-sufficient with NO cross-proto imports.
#
# Run this intentionally to re-pin after a deliberate proto change. Drift is then caught by
# `pnpm run agt:proto:check`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROTO_DIR="$ROOT/src/runtime/agt/proto"
PROTO_FILE="$PROTO_DIR/agt_decision.subset.proto"
OUT_DIR="$ROOT/src/runtime/agt/_generated"
MANIFEST="$PROTO_DIR/agt_decision.subset.sha256"

export PATH="$ROOT/node_modules/.bin:$PATH"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
protoc \
  --proto_path="$PROTO_DIR" \
  --ts_proto_out="$TMP" \
  --ts_proto_opt='onlyTypes=true,esModuleInterop=true,oneof=unions,importSuffix=.js,useDate=string' \
  "$PROTO_FILE"

mkdir -p "$OUT_DIR"
cp "$TMP/agt_decision.subset.ts" "$OUT_DIR/agt_decision.ts"
echo "agt:proto:gen: regenerated $OUT_DIR/agt_decision.ts"

if command -v sha256sum >/dev/null 2>&1; then
  HASH_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  HASH_CMD="shasum -a 256"
else
  echo "agt:proto:gen: FAIL — no sha256 tool present (sha256sum / shasum)" >&2
  exit 1
fi
( cd "$PROTO_DIR" && $HASH_CMD "agt_decision.subset.proto" > "$MANIFEST" )
echo "agt:proto:gen: re-pinned $MANIFEST"
