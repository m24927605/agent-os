#!/usr/bin/env bash
# Credential Non-Leak scanner — SEED of custom loop #3 (Credential Non-Leak Loop).
#
# Invariant (CLAUDE.md): credentials must never be written to workspace files, logs,
# artifacts, snapshots, traces, or test fixtures.
#
# This script is the minimal feedback gate used by `pnpm run verify` and the pre-commit
# hook. It scans source for high-signal secret patterns and, on any match, exits non-zero.
# It prints ONLY "file:line" — never the matched value — so the gate itself can never
# become a leak source.
#
# Task-2 hardening (full loop #3): add canary fixtures, broaden coverage to
# logs/artifacts/snapshots/traces, and add a capped /loop remediation flow.
set -uo pipefail

ROOTS=("src" "scripts" ".githooks")

# High-signal patterns only (low false-positive). These literals contain regex
# metacharacters, so the script does not match itself.
PATTERNS='sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'

hits=0
for root in "${ROOTS[@]}"; do
  [ -d "$root" ] || continue
  # grep -I skip binaries, -r recursive, -n line numbers, -E extended regex.
  # `cut -d: -f1,2` keeps only file:line, discarding the matched content (the secret).
  while IFS= read -r loc; do
    [ -n "$loc" ] || continue
    echo "  potential secret at ${loc}"
    hits=$((hits + 1))
  done < <(grep -rInE "$PATTERNS" "$root" 2>/dev/null | cut -d: -f1,2)
done

if [ "$hits" -gt 0 ]; then
  echo "secret-scan: FAIL — ${hits} potential secret location(s) found (values intentionally not shown)." >&2
  exit 1
fi

echo "secret-scan: clean"
exit 0
