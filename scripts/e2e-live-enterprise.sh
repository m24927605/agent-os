#!/usr/bin/env bash
# e2e:live-enterprise — RUN the SLICE-ES2b live cross-process integration: build + spawn the REAL Go
# kernel in PARTITIONED mode (kernel/cmd/kernel --partitions "tenant-a,tenant-b"), point each tenant's
# REAL grpc-js partitioned ingest sink at it, run the gated vitest e2e, then tear down. Hermetic +
# self-cleaning. Deliberately NOT part of `pnpm run verify` (which must stay hermetic/fast and must not
# build binaries or spawn processes); this is the opt-in live proof of per-tenant kernel isolation.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-7798}"
TMP="$(mktemp -d -t agentos-e2e-enterprise.XXXXXX)"
# Single-chain paths are unused in partitioned mode but the kernel still accepts the flags; keep them in
# TMP so nothing lands in the repo.
CHAIN="$TMP/chain.wal"
AUDIT="$TMP/audit.wal"
# Per-partition durable chain dir: the kernel writes <dir>/<tenant>.wal per partition. The gated e2e
# reads these to prove kernel-level cross-tenant isolation (A's event never enters B's chain).
PARTITION_DIR="$TMP/partitions"
LOG="$TMP/kernel.log"
KPID=""

cleanup() {
  [ -n "$KPID" ] && kill "$KPID" 2>/dev/null
  [ -n "$KPID" ] && wait "$KPID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

echo "e2e:live-enterprise: building kernel binary..."
( cd "$ROOT/kernel" && env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local go build -o "$TMP/agentos-kernel" ./cmd/kernel ) \
  || { echo "e2e:live-enterprise: FAIL — kernel build" >&2; exit 1; }

# The kernel partition IDs MUST match the fleet's binding.partitionId convention (ES1:
# partition-<tenantId>); the sink stamps partition_id = binding.partitionId, and an unknown partition
# id is fail-closed denied. So provision partition-tenant-a / partition-tenant-b, not tenant-a/tenant-b.
echo "e2e:live-enterprise: starting PARTITIONED kernel on 127.0.0.1:$PORT (partition-tenant-a,partition-tenant-b) ..."
"$TMP/agentos-kernel" \
  --addr "127.0.0.1:$PORT" \
  --chain "$CHAIN" --audit "$AUDIT" \
  --partitions "partition-tenant-a,partition-tenant-b" \
  --partition-dir "$PARTITION_DIR" \
  >"$LOG" 2>&1 &
KPID=$!

# Bounded readiness wait: poll the kernel log for its "listening" line (fail fast if it exits early).
ready=0
for _ in $(seq 1 100); do
  if grep -q "listening" "$LOG" 2>/dev/null; then ready=1; break; fi
  kill -0 "$KPID" 2>/dev/null || { echo "e2e:live-enterprise: FAIL — kernel exited before listening:" >&2; cat "$LOG" >&2; exit 1; }
  sleep 0.1
done
[ "$ready" = 1 ] || { echo "e2e:live-enterprise: FAIL — kernel not ready within timeout" >&2; cat "$LOG" >&2; exit 1; }
echo "e2e:live-enterprise: kernel ready ($(grep listening "$LOG" | tail -1))"

# Run the gated e2e against the live partitioned kernel. Hard timeout guards against a hung grpc-js
# channel (the client exposes no close()): a hang becomes a failure, never an infinite block.
export AGENTOS_LIVE_KERNEL=1
export AGENTOS_LIVE_KERNEL_ENDPOINT="127.0.0.1:$PORT"
export AGENTOS_LIVE_PARTITION_DIR="$PARTITION_DIR"
( cd "$ROOT" && node_modules/.bin/vitest run src/enterprise/bootstrap.live-kernel.e2e.test.ts ) &
VPID=$!
( sleep 120; kill -9 "$VPID" 2>/dev/null ) &
WPID=$!
wait "$VPID"
RC=$?
kill "$WPID" 2>/dev/null

if [ "$RC" = 0 ]; then
  echo "e2e:live-enterprise: ok — real TS->Go per-tenant partition round-trip + cross-tenant isolation verified, kernel torn down"
else
  echo "e2e:live-enterprise: FAIL — e2e exit $RC" >&2
fi
exit "$RC"
