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
echo "proto:check: go ok"

# --- TS contract stub drift gate (mirrors the Go gate; fail-closed) ---
# The TS stub is the type-only TS face of proto/ingest.proto, consumed by the S6 adapter. If the
# proto changes but the committed stub does not (or the stub is missing entirely), this gate is RED.
# fail-closed: a missing ts-proto plugin or a failed generation exits non-zero — never a silent pass.
TS_PLUGIN="$ROOT/node_modules/.bin/protoc-gen-ts_proto"
if [ ! -x "$TS_PLUGIN" ]; then
  echo "proto:check: FAIL — protoc-gen-ts_proto not found (run: pnpm install)" >&2; exit 1
fi
export PATH="$ROOT/node_modules/.bin:$PATH"
TS_TMP="$(mktemp -d)"; trap 'rm -rf "$TMP" "$TS_TMP"' EXIT
if ! protoc --proto_path="$ROOT/proto" \
  --ts_proto_out="$TS_TMP" \
  --ts_proto_opt='onlyTypes=true,esModuleInterop=true,oneof=unions,importSuffix=.js' \
  "$ROOT/proto/ingest.proto"; then
  echo "proto:check: FAIL — TS stub generation failed (fail-closed)" >&2; exit 1
fi
TS_GEN="$ROOT/src/runtime/_generated/ingest/ingest.ts"
if ! diff -q "$TS_TMP/ingest.ts" "$TS_GEN" >/dev/null 2>&1; then
  echo "proto:check: FAIL — ingest.ts drifted from proto/ingest.proto (run: pnpm run proto:gen)" >&2; exit 1
fi
echo "proto:check: ts ok"
echo "proto:check: ok"
