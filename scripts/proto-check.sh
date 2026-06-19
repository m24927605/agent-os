#!/usr/bin/env bash
# Fail-closed-ish: if the protoc toolchain is present, regenerate to a temp dir and diff against the
# committed generated files (drift => non-zero). If the toolchain is absent (CI provisioning step),
# skip cleanly (exit 0) — mirrors the verify:go cascade philosophy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v protoc >/dev/null 2>&1 || ! command -v protoc-gen-go >/dev/null 2>&1 || ! command -v protoc-gen-go-grpc >/dev/null 2>&1; then
  echo "proto:check: skip — protoc toolchain not present"
  exit 0
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
protoc --proto_path="$ROOT/proto" \
  --go_out="$TMP" --go_opt=paths=source_relative \
  --go-grpc_out="$TMP" --go-grpc_opt=paths=source_relative \
  "$ROOT/proto/ingest.proto"
for f in ingest.pb.go ingest_grpc.pb.go; do
  if ! diff -q "$TMP/$f" "$ROOT/kernel/internal/ingestpb/$f" >/dev/null 2>&1; then
    echo "proto:check: FAIL — $f drifted from proto/ingest.proto (run: pnpm run proto:gen)"; exit 1
  fi
done
echo "proto:check: ok"
