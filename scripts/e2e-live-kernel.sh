#!/usr/bin/env bash
# e2e:live-kernel — RUN the R2-S8 live cross-process integration: build + spawn the REAL Go kernel
# AppendService (kernel/cmd/kernel), point the REAL grpc-js ingest appender at it, run the gated vitest
# e2e, then tear down. Hermetic + self-cleaning. Deliberately NOT part of `pnpm run verify` (which must
# stay hermetic/fast and must not build binaries or spawn processes); this is the opt-in live proof.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-7799}"
TMP="$(mktemp -d -t agentos-e2e-kernel.XXXXXX)"
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

echo "e2e:live-kernel: building kernel binary..."
( cd "$ROOT/kernel" && env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local go build -o "$TMP/agentos-kernel" ./cmd/kernel ) \
  || { echo "e2e:live-kernel: FAIL — kernel build" >&2; exit 1; }

echo "e2e:live-kernel: starting kernel on 127.0.0.1:$PORT ..."
"$TMP/agentos-kernel" --addr "127.0.0.1:$PORT" --chain "$CHAIN" --audit "$AUDIT" >"$LOG" 2>&1 &
KPID=$!

# Bounded readiness wait: poll the kernel log for its "listening" line (fail fast if it exits early).
ready=0
for _ in $(seq 1 100); do
  if grep -q "listening" "$LOG" 2>/dev/null; then ready=1; break; fi
  kill -0 "$KPID" 2>/dev/null || { echo "e2e:live-kernel: FAIL — kernel exited before listening:" >&2; cat "$LOG" >&2; exit 1; }
  sleep 0.1
done
[ "$ready" = 1 ] || { echo "e2e:live-kernel: FAIL — kernel not ready within timeout" >&2; cat "$LOG" >&2; exit 1; }
echo "e2e:live-kernel: kernel ready ($(grep listening "$LOG" | tail -1))"

# Run the gated e2e against the live kernel. Hard timeout guards against a hung grpc-js channel
# (the client exposes no close()): a hang becomes a failure, never an infinite block.
export AGENTOS_LIVE_KERNEL_ENDPOINT="127.0.0.1:$PORT"
export AGENTOS_LIVE_KERNEL_CHAIN="$CHAIN"
( cd "$ROOT" && node_modules/.bin/vitest run src/audit/ingest/live-kernel.e2e.test.ts src/personal/bootstrap.live-kernel.e2e.test.ts ) &
VPID=$!
( sleep 120; kill -9 "$VPID" 2>/dev/null ) &
WPID=$!
wait "$VPID"
RC=$?
kill "$WPID" 2>/dev/null

if [ "$RC" = 0 ]; then
  echo "e2e:live-kernel: ok — real TS->Go round-trip verified, kernel torn down"
else
  echo "e2e:live-kernel: FAIL — e2e exit $RC" >&2
fi
exit "$RC"
