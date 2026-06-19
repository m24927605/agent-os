#!/usr/bin/env bash
# Regenerate Go from proto/ into kernel/internal/ingestpb/. Requires protoc + protoc-gen-go + protoc-gen-go-grpc on PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
protoc \
  --proto_path="$ROOT/proto" \
  --go_out="$ROOT/kernel/internal/ingestpb" --go_opt=paths=source_relative \
  --go-grpc_out="$ROOT/kernel/internal/ingestpb" --go-grpc_opt=paths=source_relative \
  "$ROOT/proto/ingest.proto"
echo "proto:gen: regenerated kernel/internal/ingestpb/"
