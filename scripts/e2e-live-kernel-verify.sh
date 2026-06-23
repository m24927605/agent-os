#!/usr/bin/env bash
# e2e:live-kernel-verify — SLICE-K2: prove the consumer-side moat is REAL on the OPERATOR'S ACTUAL kernel
# chain. This is the step beyond DV2 (which verified the kit's own ts-signed chain): here the REAL Go
# kernel (K1: signs its Checkpoint with an operator-held Ed25519 key) produces + signs the chain in a
# SEPARATE process, the TS signed-chain reader reconstructs it over gRPC (ListEntries + signed
# Checkpoint), and the SEPARATELY-RELEASED + CHECKSUM-VERIFIED Go verifier verifies it using the kernel's
# SELF-REPORTED pubkey.
#
# Steps:
#   1. BUILD the signed kernel (kernel/cmd/kernel; K1 generates an in-memory signing key at startup by
#      default) and the released verifier (`verifier:release` -> dist/verifier + SHA-256SUMS).
#   2. CHECKSUM-VERIFY the host verifier binary against SHA-256SUMS (provenance gate — never run an
#      unverified binary; mirrors e2e-live-developer.sh).
#   3. START the kernel (readiness-poll its "listening" line), export AGENTOS_LIVE_KERNEL_ENDPOINT.
#   4. Run the GATED vitest with AGENTOS_LIVE_KERNEL_VERIFY=1 + AGENTOS_VERIFIER_BIN=<verified binary>.
#      The e2e proves: (a) INTACT — the released verifier verifies the REAL kernel chain (cross-language
#      byte-match) -> exit 0; (b) TAMPER — a mutated entry -> exit 1 (broken), non-vacuously; (c) WRONG
#      pubkey — a different ed25519 pubkey -> non-zero.
#   5. NON-VACUITY guard (all-skipped / no-passed despite exit 0 -> FAIL) + trap-cleanup the kernel + temp.
#
# Deliberately NOT part of `pnpm run verify` (which stays hermetic/fast and must not build binaries or
# spawn processes); this is the opt-in live proof. Hermetic + self-cleaning.
#
# HONEST BOUNDARY: the kernel signing key is OPERATOR-HELD (in-memory generated, or loaded via
# -signing-key), so attester != actor holds TO THE PROCESS BOUNDARY (the control plane cannot sign). The
# kernel SELF-REPORTS its pubkey, so the pubkey trust-root endorsement + real key externalization
# (HSM/KMS/remote attestation) are P4 — NOT proven here.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="$ROOT/dist/verifier"
PORT="${PORT:-7801}"
TMP="$(mktemp -d -t agentos-e2e-kernel-verify.XXXXXX)"
CHAIN="$TMP/chain.wal"
AUDIT="$TMP/audit.wal"
LOG="$TMP/kernel.log"
KPID=""

cleanup() {
  [ -n "$KPID" ] && kill "$KPID" 2>/dev/null
  [ -n "$KPID" ] && wait "$KPID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

# ── Host -> goos/goarch -> released binary name (matches build-verifier-release.sh's matrix) ──────────
case "$(uname -s)" in
  Linux)  GOOS="linux" ;;
  Darwin) GOOS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) GOOS="windows" ;;
  *) echo "e2e:live-kernel-verify: FAIL — unsupported host OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) GOARCH="amd64" ;;
  arm64|aarch64) GOARCH="arm64" ;;
  *) echo "e2e:live-kernel-verify: FAIL — unsupported host arch $(uname -m)" >&2; exit 1 ;;
esac
EXT=""
[ "$GOOS" = "windows" ] && EXT=".exe"
BIN_NAME="verifier-${GOOS}-${GOARCH}${EXT}"
BIN_PATH="$OUTDIR/$BIN_NAME"

# ── 1a. Build the signed kernel binary. Pin the toolchain; don't inherit a stray GOROOT. ─────────────
echo "e2e:live-kernel-verify: building kernel binary..."
( cd "$ROOT/kernel" && env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local go build -o "$TMP/agentos-kernel" ./cmd/kernel ) \
  || { echo "e2e:live-kernel-verify: FAIL — kernel build" >&2; exit 1; }

# ── 1b. Build the released verifier (+ SHA-256SUMS). ──────────────────────────────────────────────────
echo "e2e:live-kernel-verify: building verifier (pnpm run verifier:release)..."
( cd "$ROOT" && env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local pnpm run verifier:release ) \
  || { echo "e2e:live-kernel-verify: FAIL — verifier:release build" >&2; exit 1; }

[ -f "$BIN_PATH" ] || { echo "e2e:live-kernel-verify: FAIL — host verifier binary absent ($BIN_PATH)" >&2; exit 1; }
[ -f "$OUTDIR/SHA-256SUMS" ] || { echo "e2e:live-kernel-verify: FAIL — SHA-256SUMS absent" >&2; exit 1; }

# ── 2. CHECKSUM-VERIFY the host verifier binary against SHA-256SUMS (provenance gate). ────────────────
ACTUAL="$(cd "$OUTDIR" && shasum -a 256 "$BIN_NAME" | awk '{print $1}')"
EXPECTED="$(awk -v f="$BIN_NAME" '$2 == f || $2 == "*"f {print $1}' "$OUTDIR/SHA-256SUMS" | head -1)"
if [ -z "$EXPECTED" ]; then
  echo "e2e:live-kernel-verify: FAIL — no SHA-256SUMS entry for $BIN_NAME (provenance gate)" >&2
  exit 1
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "e2e:live-kernel-verify: FAIL — checksum MISMATCH for $BIN_NAME (provenance gate)" >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $ACTUAL" >&2
  exit 1
fi
echo "e2e:live-kernel-verify: checksum ok — $BIN_NAME matches SHA-256SUMS ($ACTUAL)"

# ── 3. START the signed kernel (K1 generates an in-memory signing key at startup by default). ─────────
echo "e2e:live-kernel-verify: starting kernel on 127.0.0.1:$PORT ..."
"$TMP/agentos-kernel" --addr "127.0.0.1:$PORT" --chain "$CHAIN" --audit "$AUDIT" >"$LOG" 2>&1 &
KPID=$!

# Bounded readiness wait: poll the kernel log for its "listening" line (fail fast if it exits early).
ready=0
for _ in $(seq 1 100); do
  if grep -q "listening" "$LOG" 2>/dev/null; then ready=1; break; fi
  kill -0 "$KPID" 2>/dev/null || { echo "e2e:live-kernel-verify: FAIL — kernel exited before listening:" >&2; cat "$LOG" >&2; exit 1; }
  sleep 0.1
done
[ "$ready" = 1 ] || { echo "e2e:live-kernel-verify: FAIL — kernel not ready within timeout" >&2; cat "$LOG" >&2; exit 1; }
echo "e2e:live-kernel-verify: kernel ready ($(grep listening "$LOG" | tail -1))"

# ── 4. Run the GATED e2e: real kernel chain -> signed read-back -> released verifier. ─────────────────
echo "e2e:live-kernel-verify: running e2e (real verifier verifies the REAL kernel chain: intact / tamper-broken / wrong-pubkey)..."
export AGENTOS_LIVE_KERNEL_VERIFY=1
export AGENTOS_LIVE_KERNEL_ENDPOINT="127.0.0.1:$PORT"
export AGENTOS_VERIFIER_BIN="$BIN_PATH"
VOUT="$TMP/vitest.out"
# Hard timeout guards against a hung grpc-js channel (the client exposes no close()): a hang becomes a
# failure, never an infinite block.
( cd "$ROOT" && node_modules/.bin/vitest run src/runtime/ingest/signed-readback.live.test.ts ) 2>&1 | tee "$VOUT" &
VPID=$!
( sleep 120; kill -9 "$VPID" 2>/dev/null ) &
WPID=$!
wait "$VPID"
RC="${PIPESTATUS[0]}"
kill "$WPID" 2>/dev/null

# ── 5. NON-VACUITY GUARD: vitest exits 0 even when every test SKIPS. The moat proof is worthless if the
# gated suite did not actually RUN, so a green that contains "skipped" (or lacks a "passed" count) is
# treated as a FAIL — we never print "ok" without the real verifier having executed all three cases.
if [ "$RC" = 0 ]; then
  if grep -qE "[0-9]+ +skipped" "$VOUT" || ! grep -qE "[0-9]+ +passed" "$VOUT"; then
    echo "e2e:live-kernel-verify: FAIL — gated e2e did not RUN (skipped / no passing tests) despite exit 0; the live proof is vacuous" >&2
    exit 1
  fi
fi

if [ "$RC" = 0 ]; then
  echo "e2e:live-kernel-verify: ok — the operator's REAL kernel chain verified INTACT by the released Go verifier (cross-language byte-match); tamper -> broken; wrong-pubkey -> rejected; kernel torn down"
else
  echo "e2e:live-kernel-verify: FAIL — e2e exit $RC" >&2
fi
exit "$RC"
