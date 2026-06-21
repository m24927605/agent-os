#!/usr/bin/env bash
# verify:py — polyglot cascade leg (FAIL-CLOSED). See docs/slices/phase-0/S0.8-verify-cascade.md.
#
# No Python plane yet => skip (exit 0).
# Python plane present but gate unconfigured (toolchain / pyproject missing) => FAIL (exit 1).
# Never no-op-green.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLANE="${VERIFY_PY_PLANE:-$ROOT/python}"

if [ ! -d "$PLANE" ]; then
  echo "verify:py: skip — no Python plane (${PLANE} absent)"
  exit 0
fi

echo "verify:py: Python plane present (${PLANE}) — gate must be configured (fail-closed)"
fail=0
# Toolchain: prefer a project-managed runner (uv) so dev deps (ruff/pyright/pytest/import-linter)
# resolve from the plane's pyproject; fall back to bare ruff/uvx for environments that have it.
if command -v uv >/dev/null 2>&1; then RUN="uv run"
elif command -v uvx >/dev/null 2>&1; then RUN="uvx --from . --"
else RUN=""; fi
{ [ -n "$RUN" ] || command -v ruff >/dev/null 2>&1; } ||
  { echo "  FAIL: Python toolchain not available (need uv, uvx, or ruff)" >&2; fail=1; }
[ -f "${PLANE}/pyproject.toml" ] || { echo "  FAIL: pyproject.toml missing" >&2; fail=1; }
if [ "$fail" -ne 0 ]; then
  echo "verify:py: FAIL — Python plane present but gate unconfigured (configure it in the P3 SDK slice)" >&2
  exit 1
fi
[ -z "$RUN" ] && RUN=""  # bare-tool path: invoke ruff/pyright/pytest/lint-imports directly

# Fully configured: run the language gate (ruff + pyright + pytest) plus the import-linter
# forbidden contract (lint-imports) — the credential-blind import-time invariant. Fail-closed.
( cd "$PLANE" && $RUN ruff check . && $RUN pyright && $RUN pytest -q &&
  $RUN lint-imports ) ||
  { echo "verify:py: FAIL — Python gate failed" >&2; exit 1; }
echo "verify:py: ok"
