#!/usr/bin/env bash
# RED-first smoke test for SLICE-P2R-R9-S5: scripts/build-verifier-release.sh must produce a
# versioned, cross-platform + WASM, REPRODUCIBLE verifier release artifact.
#
# Behaviours asserted (each maps to a §5 RED invariant):
#   1. cross-platform artefacts present: every {GOOS}-{GOARCH}[.exe] binary + verifier.wasm + SHA-256SUMS
#   2. reproducible: a second build of the same commit yields byte-identical artefacts (same SHA-256SUMS)
#   3. SHA-256SUMS validates against the produced files (`shasum -c` clean)
#
# Fail-closed: any missing artefact / mismatch -> exit nonzero.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/build-verifier-release.sh"
OUTDIR="$ROOT/dist/verifier"

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -x "$SCRIPT" ] || [ -f "$SCRIPT" ] || fail "scripts/build-verifier-release.sh does not exist"

# Expected cross-platform matrix (must match the script).
EXPECTED=(
  "verifier-linux-amd64"
  "verifier-linux-arm64"
  "verifier-darwin-amd64"
  "verifier-darwin-arm64"
  "verifier-windows-amd64.exe"
  "verifier.wasm"
  "SHA-256SUMS"
)

# --- build #1 ---
bash "$SCRIPT" || fail "first build exited nonzero"
for f in "${EXPECTED[@]}"; do
  [ -f "$OUTDIR/$f" ] || fail "missing artefact: $f"
done
SUMS1="$(cat "$OUTDIR/SHA-256SUMS")"

# checksum file must validate against the produced binaries
( cd "$OUTDIR" && shasum -a 256 -c SHA-256SUMS >/dev/null 2>&1 ) || fail "SHA-256SUMS does not verify against produced files"

# --- build #2 (reproducibility) ---
bash "$SCRIPT" || fail "second build exited nonzero"
SUMS2="$(cat "$OUTDIR/SHA-256SUMS")"

[ "$SUMS1" = "$SUMS2" ] || fail "build is NOT reproducible: SHA-256SUMS differ between two builds"

echo "ok: cross-platform + WASM artefacts present, checksums verify, build is reproducible"
