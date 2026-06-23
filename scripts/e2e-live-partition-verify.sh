#!/usr/bin/env bash
# e2e:live-partition-verify — SLICE-PK2: prove the Enterprise per-tenant moat is REAL on the OPERATOR'S
# ACTUAL partitioned kernel. The step beyond K2 (one single-chain kernel) and ES2b (per-tenant WRITE
# isolation): here a PARTITIONED Go kernel (>=2 tenants, each with its OWN in-memory Ed25519 key) produces
# + signs per-tenant chains in a SEPARATE process; the PK2 partition-aware TS reader reconstructs EACH
# tenant's chain over gRPC (Checkpoint({partitionId}) + ListEntries({partitionId})); and the
# SEPARATELY-RELEASED + CHECKSUM-VERIFIED Go verifier proves:
#   (a) A's chain under A's pubkey -> exit 0 intact, (b) B's chain under B's pubkey -> exit 0 intact
#       (each tenant independently verifies ITS OWN chain, cross-language);
#   (c) A's chain under B's pubkey -> NON-ZERO (PER-TENANT ATTESTER ISOLATION — a tenant cannot verify/
#       forge its chain with ANOTHER tenant's key);
#   (d) cross-tenant ENTRIES isolation (A's read-back holds A's marker, never B's);
#   (e) tamper A's chain -> exit 1 broken (non-vacuity).
#
# Steps:
#   1. BUILD the kernel (kernel/cmd/kernel) and the released verifier (`verifier:release` -> dist/verifier
#      + SHA-256SUMS).
#   2. CHECKSUM-VERIFY the host verifier binary against SHA-256SUMS (provenance gate — never run an
#      unverified binary; mirrors e2e-live-kernel-verify.sh).
#   3. START the kernel in PARTITIONED mode (--partitions "tenant-a,tenant-b" + --partition-dir),
#      readiness-poll its "listening" line, export AGENTOS_LIVE_KERNEL_ENDPOINT.
#   4. Run the GATED vitest with AGENTOS_LIVE_PARTITION_VERIFY=1 + AGENTOS_VERIFIER_BIN=<verified binary>.
#   5. NON-VACUITY guard (all-skipped / no-passed despite exit 0 -> FAIL) + trap-cleanup kernel + temp.
#
# Deliberately NOT part of `pnpm run verify` (which stays hermetic/fast and must not build binaries or
# spawn processes); this is the opt-in live proof. Hermetic + self-cleaning.
#
# HONEST BOUNDARY: each tenant's signing key is generated IN-MEMORY by the kernel process (ES2a), so
# per-tenant attester != actor holds TO THE PROCESS BOUNDARY (the control plane cannot sign). The kernel
# SELF-REPORTS each tenant's pubkey, so per-tenant key externalization (HSM / per-tenant KMS / trust-root
# endorsement of which key is which tenant's) is P4 — NOT proven here.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="$ROOT/dist/verifier"
PORT="${PORT:-7802}"
TMP="$(mktemp -d -t agentos-e2e-partition-verify.XXXXXX)"
# Single-chain paths are unused in partitioned mode but the kernel still accepts the flags; keep them in
# TMP so nothing lands in the repo.
CHAIN="$TMP/chain.wal"
AUDIT="$TMP/audit.wal"
# Per-partition durable chain dir: the kernel writes <dir>/<tenant>.wal per partition.
PARTITION_DIR="$TMP/partitions"
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
  *) echo "e2e:live-partition-verify: FAIL — unsupported host OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) GOARCH="amd64" ;;
  arm64|aarch64) GOARCH="arm64" ;;
  *) echo "e2e:live-partition-verify: FAIL — unsupported host arch $(uname -m)" >&2; exit 1 ;;
esac
EXT=""
[ "$GOOS" = "windows" ] && EXT=".exe"
BIN_NAME="verifier-${GOOS}-${GOARCH}${EXT}"
BIN_PATH="$OUTDIR/$BIN_NAME"

# ── 1a. Build the kernel binary. Pin the toolchain; don't inherit a stray GOROOT. ────────────────────
echo "e2e:live-partition-verify: building kernel binary..."
( cd "$ROOT/kernel" && env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local go build -o "$TMP/agentos-kernel" ./cmd/kernel ) \
  || { echo "e2e:live-partition-verify: FAIL — kernel build" >&2; exit 1; }

# ── 1b. Build the released verifier (+ SHA-256SUMS). ──────────────────────────────────────────────────
echo "e2e:live-partition-verify: building verifier (pnpm run verifier:release)..."
( cd "$ROOT" && env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local pnpm run verifier:release ) \
  || { echo "e2e:live-partition-verify: FAIL — verifier:release build" >&2; exit 1; }

[ -f "$BIN_PATH" ] || { echo "e2e:live-partition-verify: FAIL — host verifier binary absent ($BIN_PATH)" >&2; exit 1; }
[ -f "$OUTDIR/SHA-256SUMS" ] || { echo "e2e:live-partition-verify: FAIL — SHA-256SUMS absent" >&2; exit 1; }

# ── 2. CHECKSUM-VERIFY the host verifier binary against SHA-256SUMS (provenance gate). ────────────────
ACTUAL="$(cd "$OUTDIR" && shasum -a 256 "$BIN_NAME" | awk '{print $1}')"
EXPECTED="$(awk -v f="$BIN_NAME" '$2 == f || $2 == "*"f {print $1}' "$OUTDIR/SHA-256SUMS" | head -1)"
if [ -z "$EXPECTED" ]; then
  echo "e2e:live-partition-verify: FAIL — no SHA-256SUMS entry for $BIN_NAME (provenance gate)" >&2
  exit 1
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "e2e:live-partition-verify: FAIL — checksum MISMATCH for $BIN_NAME (provenance gate)" >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $ACTUAL" >&2
  exit 1
fi
echo "e2e:live-partition-verify: checksum ok — $BIN_NAME matches SHA-256SUMS ($ACTUAL)"

# ── 3. START the PARTITIONED kernel (>=2 tenants; ES2a generates a per-tenant in-memory key each). ────
echo "e2e:live-partition-verify: starting PARTITIONED kernel on 127.0.0.1:$PORT (tenant-a,tenant-b) ..."
"$TMP/agentos-kernel" \
  --addr "127.0.0.1:$PORT" \
  --chain "$CHAIN" --audit "$AUDIT" \
  --partitions "tenant-a,tenant-b" \
  --partition-dir "$PARTITION_DIR" \
  >"$LOG" 2>&1 &
KPID=$!

# Bounded readiness wait: poll the kernel log for its "listening" line (fail fast if it exits early).
ready=0
for _ in $(seq 1 100); do
  if grep -q "listening" "$LOG" 2>/dev/null; then ready=1; break; fi
  kill -0 "$KPID" 2>/dev/null || { echo "e2e:live-partition-verify: FAIL — kernel exited before listening:" >&2; cat "$LOG" >&2; exit 1; }
  sleep 0.1
done
[ "$ready" = 1 ] || { echo "e2e:live-partition-verify: FAIL — kernel not ready within timeout" >&2; cat "$LOG" >&2; exit 1; }
echo "e2e:live-partition-verify: kernel ready ($(grep listening "$LOG" | tail -1))"

# ── 4. Run the GATED e2e: per-tenant signed read-back -> released verifier (per-tenant attester isolation).
echo "e2e:live-partition-verify: running e2e (per tenant: intact under own key, A's chain rejected under B's key, entries isolated, tamper->broken)..."
export AGENTOS_LIVE_PARTITION_VERIFY=1
export AGENTOS_LIVE_KERNEL_ENDPOINT="127.0.0.1:$PORT"
export AGENTOS_VERIFIER_BIN="$BIN_PATH"
VOUT="$TMP/vitest.out"
# Hard timeout guards against a hung grpc-js channel (the client exposes no close()): a hang becomes a
# failure, never an infinite block.
( cd "$ROOT" && node_modules/.bin/vitest run src/runtime/ingest/partition-readback.live.test.ts ) 2>&1 | tee "$VOUT" &
VPID=$!
( sleep 120; kill -9 "$VPID" 2>/dev/null ) &
WPID=$!
wait "$VPID"
RC="${PIPESTATUS[0]}"
kill "$WPID" 2>/dev/null

# ── 5. NON-VACUITY GUARD: vitest exits 0 even when every test SKIPS. The moat proof is worthless if the
# gated suite did not actually RUN, so a green that contains "skipped" (or lacks a "passed" count) is
# treated as a FAIL — we never print "ok" without the real verifier having executed every case.
if [ "$RC" = 0 ]; then
  if grep -qE "[0-9]+ +skipped" "$VOUT" || ! grep -qE "[0-9]+ +passed" "$VOUT"; then
    echo "e2e:live-partition-verify: FAIL — gated e2e did not RUN (skipped / no passing tests) despite exit 0; the live proof is vacuous" >&2
    exit 1
  fi
fi

if [ "$RC" = 0 ]; then
  echo "e2e:live-partition-verify: ok — each Enterprise tenant independently verified ITS OWN partition chain INTACT by the released Go verifier; A's chain REJECTED under B's pubkey (per-tenant attester isolation); cross-tenant entries isolated; tamper -> broken; kernel torn down"
else
  echo "e2e:live-partition-verify: FAIL — e2e exit $RC" >&2
fi
exit "$RC"
