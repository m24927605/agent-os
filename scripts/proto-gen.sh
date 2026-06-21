#!/usr/bin/env bash
# Regenerate the cross-plane proto products from proto/:
#   - Go server stub   -> kernel/internal/ingestpb/  (requires protoc + protoc-gen-go + protoc-gen-go-grpc)
#   - TS contract stub  -> src/runtime/_generated/ingest/  (requires protoc + node_modules/.bin/protoc-gen-ts_proto)
# The TS stub is a TYPE-ONLY contract (onlyTypes=true): zero runtime imports, no RPC client — it only
# fixes the TS face of proto/ingest.proto so S6's adapter can import it. It is GENERATED; do not edit.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ts-proto plugin lives in node_modules/.bin; put it on PATH so protoc can find protoc-gen-ts_proto.
export PATH="$ROOT/node_modules/.bin:$PATH"

# --- Go (unchanged) ---
protoc \
  --proto_path="$ROOT/proto" \
  --go_out="$ROOT/kernel/internal/ingestpb" --go_opt=paths=source_relative \
  --go-grpc_out="$ROOT/kernel/internal/ingestpb" --go-grpc_opt=paths=source_relative \
  "$ROOT/proto/ingest.proto"
echo "proto:gen: regenerated kernel/internal/ingestpb/"

# --- TS contract stub (type-only; no runtime RPC dependency) ---
TS_OUT="$ROOT/src/runtime/_generated/ingest"
mkdir -p "$TS_OUT"
protoc \
  --proto_path="$ROOT/proto" \
  --ts_proto_out="$TS_OUT" \
  --ts_proto_opt='onlyTypes=true,esModuleInterop=true,oneof=unions,importSuffix=.js' \
  "$ROOT/proto/ingest.proto"
echo "proto:gen: regenerated src/runtime/_generated/ingest/"
