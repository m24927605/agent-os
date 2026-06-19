#!/usr/bin/env bash
# Phase-1 exit criteria (roadmap §3.1) as a single re-runnable, FAIL-CLOSED aggregation:
# set -euo pipefail means any sub-command's non-zero exit aborts and the whole script exits non-zero
# (no swallowed errors, no fake-green). Each step maps to the slice that delivered it. This script
# only ORCHESTRATES existing, slice-owned checks — it implements no new judgement of its own.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
GO="env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local go"

echo "[p1-exit 1/6] pnpm run verify (incl cascaded verify:go) — S0.8 + P1-S1.."
pnpm run verify >/dev/null

echo "[p1-exit 2/6] standalone verifier golden (tamper -> non-zero, intact -> ok) — P1-S3"
( cd kernel && $GO test ./internal/verify/... ./cmd/verifier/... >/dev/null )

echo "[p1-exit 3/6] control plane cannot rewrite an appended record (typed deny + audit) — P1-S6"
( cd kernel && $GO test ./internal/server/... >/dev/null )

echo "[p1-exit 4/6] sequence-gap injection detected — P1-S4"
( cd kernel && $GO test ./internal/sequence/... -run TestGap >/dev/null )

echo "[p1-exit 5/6] synchronous commit-before-effect — P1-S5"
( cd kernel && $GO test ./internal/commitgate/... -run TestCommitBeforeEffect >/dev/null )

echo "[p1-exit 6/6] cross-language conformance TS<->Go (both directions) — P1-S7"
pnpm exec vitest run conformance/cross-lang/ts-verifies-go.conformance.test.ts >/dev/null
( cd kernel && $GO test ./internal/conformance/... >/dev/null )

echo "verify:p1-exit: ok — all 6 Phase-1 exit criteria green"
