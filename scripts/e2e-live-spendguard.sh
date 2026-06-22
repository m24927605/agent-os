#!/usr/bin/env bash
# e2e:live-spendguard (R11-S9) — RUN the live cross-process integration: build the TS, stand up the REAL
# SpendGuard demo (sidecar + Rust ledger + Postgres) via docker compose, drive our SpendGuardCostGate +
# decision-transport against the real sidecar UDS from a sidecar-adjacent container (uid 65532, shared UDS
# volume), assert reserve/commit/over-budget, then tear the stack down. Hermetic + self-cleaning. NOT part
# of `pnpm run verify` (verify must not build docker images or spawn a Postgres) — this is the opt-in live proof.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SG="${SPENDGUARD_REPO:-/tmp/agentic-spendguard}"
COMPOSE="$SG/deploy/demo/compose.yaml"
NET="spendguard-demo_spendguard-net"
UDS_VOL="spendguard-demo_sidecar-uds"
# OrbStack/Docker Desktop socket. The host's DOCKER_HOST may point at a dead socket; normalize.
export DOCKER_HOST="${DOCKER_HOST_OVERRIDE:-unix:///var/run/docker.sock}"

if [ ! -f "$COMPOSE" ]; then
  echo "e2e:live-spendguard: BLOCKED — SpendGuard repo not found at $SG (set SPENDGUARD_REPO)" >&2; exit 1
fi
docker info >/dev/null 2>&1 || {
  echo "e2e:live-spendguard: BLOCKED — docker daemon unreachable at $DOCKER_HOST (start Docker/OrbStack)" >&2; exit 1; }

cleanup() { ( cd "$SG" && docker compose -f "$COMPOSE" down -v >/dev/null 2>&1 ); }
trap cleanup EXIT INT TERM

echo "e2e:live-spendguard: building TS (dist)…"
( cd "$ROOT" && pnpm run build >/dev/null 2>&1 ) || { echo "e2e:live-spendguard: FAIL — TS build" >&2; exit 1; }

echo "e2e:live-spendguard: bringing up the real SpendGuard sidecar (+ ledger + Postgres)…"
# Reuse already-built images (do NOT force --build every run: rebuilding ~8 Rust services is slow and
# flaky). One-time setup on a clean machine: `cd $SG && docker compose -f deploy/demo/compose.yaml build`.
( cd "$SG" && docker compose -f "$COMPOSE" up -d sidecar ) \
  || { echo "e2e:live-spendguard: BLOCKED — demo failed to start (images present? run a one-time \`docker compose build\`)" >&2; exit 1; }

# Bounded wait for the sidecar to report healthy.
ready=0
for _ in $(seq 1 60); do
  state="$( cd "$SG" && docker compose -f "$COMPOSE" ps sidecar --format '{{.Health}}' 2>/dev/null )"
  if [ "$state" = "healthy" ]; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "e2e:live-spendguard: BLOCKED — sidecar not healthy in time" >&2; exit 1; }
echo "e2e:live-spendguard: sidecar healthy — running the live e2e in a sidecar-adjacent container…"

# Run the probe in-network as the sidecar's peer uid (65532), sharing the UDS volume + the host repo
# (pure-JS @grpc/grpc-js + the compiled dist work cross-platform in a linux node container).
docker run --rm \
  --network "$NET" \
  -v "$UDS_VOL:/var/run/spendguard" \
  --user 65532:65532 \
  -v "$ROOT:/app" -w /app \
  node:20-bookworm-slim node scripts/spendguard-live-e2e.mjs
RC=$?

if [ "$RC" = 0 ]; then echo "e2e:live-spendguard: ok — real SpendGuard reserve/commit/over-budget verified, stack torn down"
else echo "e2e:live-spendguard: FAIL — live e2e exit $RC" >&2; fi
exit "$RC"
