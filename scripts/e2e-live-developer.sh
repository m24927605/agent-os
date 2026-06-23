#!/usr/bin/env bash
# e2e:live-developer — SLICE-DV2: prove the Developer moat is REAL. BUILD the released Go verifier
# (`verifier:release` -> dist/verifier/verifier-<goos>-<goarch> + SHA-256SUMS), CHECKSUM-VERIFY the
# host binary against SHA-256SUMS (provenance gate — never run an unverified binary), then run the
# GATED vitest e2e with AGENTOS_VERIFIER_BIN pointed at the checksum-verified binary. The e2e proves:
#   (a) INTACT  — the REAL verifier accepts the TS-produced signed WORM chain (cross-language byte-match),
#   (b) TAMPER  — a mutated entry -> exit 1 (broken), non-vacuously,
#   (c) WRONG   — a different pubkey -> non-zero ({ok:false}).
# Deliberately NOT part of `pnpm run verify` (which stays hermetic/fast and must not build binaries or
# spawn processes); this is the opt-in live proof. Hermetic + self-cleaning.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="$ROOT/dist/verifier"
TMP="$(mktemp -d -t agentos-e2e-developer.XXXXXX)"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

# ── Host -> goos/goarch -> released binary name (matches build-verifier-release.sh's matrix) ──────────
case "$(uname -s)" in
  Linux)  GOOS="linux" ;;
  Darwin) GOOS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) GOOS="windows" ;;
  *) echo "e2e:live-developer: FAIL — unsupported host OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) GOARCH="amd64" ;;
  arm64|aarch64) GOARCH="arm64" ;;
  *) echo "e2e:live-developer: FAIL — unsupported host arch $(uname -m)" >&2; exit 1 ;;
esac
EXT=""
[ "$GOOS" = "windows" ] && EXT=".exe"
BIN_NAME="verifier-${GOOS}-${GOARCH}${EXT}"
BIN_PATH="$OUTDIR/$BIN_NAME"

# ── 1. Build the released verifier (+ SHA-256SUMS). Pin the toolchain; don't inherit a stray GOROOT. ──
echo "e2e:live-developer: building verifier (pnpm run verifier:release)..."
( cd "$ROOT" && env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local pnpm run verifier:release ) \
  || { echo "e2e:live-developer: FAIL — verifier:release build" >&2; exit 1; }

[ -f "$BIN_PATH" ] || { echo "e2e:live-developer: FAIL — host binary absent ($BIN_PATH)" >&2; exit 1; }
[ -f "$OUTDIR/SHA-256SUMS" ] || { echo "e2e:live-developer: FAIL — SHA-256SUMS absent" >&2; exit 1; }

# ── 2. CHECKSUM-VERIFY the host binary against SHA-256SUMS (provenance gate). ─────────────────────────
# Recompute the SHA-256 of the built binary and confirm it MATCHES the entry recorded in SHA-256SUMS.
# A mismatch (or a missing entry) FAILS — we never run an unverified binary.
ACTUAL="$(cd "$OUTDIR" && shasum -a 256 "$BIN_NAME" | awk '{print $1}')"
EXPECTED="$(awk -v f="$BIN_NAME" '$2 == f || $2 == "*"f {print $1}' "$OUTDIR/SHA-256SUMS" | head -1)"
if [ -z "$EXPECTED" ]; then
  echo "e2e:live-developer: FAIL — no SHA-256SUMS entry for $BIN_NAME (provenance gate)" >&2
  exit 1
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "e2e:live-developer: FAIL — checksum MISMATCH for $BIN_NAME (provenance gate)" >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $ACTUAL" >&2
  exit 1
fi
echo "e2e:live-developer: checksum ok — $BIN_NAME matches SHA-256SUMS ($ACTUAL)"

# ── 3. Run the GATED e2e with the checksum-verified verifier binary. ──────────────────────────────────
echo "e2e:live-developer: running e2e (real verifier: intact / tamper-broken / wrong-pubkey)..."
export AGENTOS_LIVE_VERIFIER=1
export AGENTOS_VERIFIER_BIN="$BIN_PATH"
VOUT="$TMP/vitest.out"
( cd "$ROOT" && node_modules/.bin/vitest run src/developer/real-verifier.live.test.ts ) 2>&1 | tee "$VOUT"
RC="${PIPESTATUS[0]}"

# NON-VACUITY GUARD: vitest exits 0 even when every test SKIPS. The moat proof is worthless if the
# gated suite did not actually RUN, so a green that contains "skipped" (or lacks a "passed" count) is
# treated as a FAIL — we never print "ok" without the real verifier having executed all three cases.
if [ "$RC" = 0 ]; then
  if grep -qE "[0-9]+ +skipped" "$VOUT" || ! grep -qE "[0-9]+ +passed" "$VOUT"; then
    echo "e2e:live-developer: FAIL — gated e2e did not RUN (skipped / no passing tests) despite exit 0; the live proof is vacuous" >&2
    exit 1
  fi
fi

if [ "$RC" = 0 ]; then
  echo "e2e:live-developer: ok — TS-produced WORM chain verified INTACT by the real Go verifier (cross-language byte-match); tamper -> broken; wrong-pubkey -> rejected"
else
  echo "e2e:live-developer: FAIL — e2e exit $RC" >&2
fi
exit "$RC"
