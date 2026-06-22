#!/usr/bin/env bash
# e2e:live-hermes (SLICE-HERMES-S1) — RUN the live proof that our NemoClawAgentHosting adapter GOVERNS
# the REAL Hermes gateway inside a USER-PROVISIONED Hermes sandbox (created externally via
# `nemohermes onboard`). The gated vitest ADOPTS the user's sandbox via the adapter (REAL GetSandbox ->
# refById), drives NemoClawAgentHosting through the S10 CommandSink onto the mTLS gRPC ExecSandbox
# transport, and proves adopt -> status running (REAL Hermes gateway /health:18789) -> reconcile.
#
# It NEVER creates or DELETES a sandbox — the sandbox is the USER's asset (managed by their onboard);
# we only adopt + observe + reconcile. The LLM key stays entirely on the user side (credential-blind).
#
# Deliberately NOT part of `pnpm run verify` (which must stay hermetic/fast and must not spawn docker /
# a gateway); this is the opt-in live proof. A missing prerequisite is a CLEAN block (exit 0), never a
# hang or a hard failure.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# OrbStack exposes the Docker daemon on the standard unix socket; export it so `docker info` (and any
# downstream tooling) reaches the daemon without relying on the caller's shell env.
export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"

# --- Preflight: a missing prerequisite is a CLEAN block (exit 0), never a hang or a hard failure. ------
if ! docker info >/dev/null 2>&1; then
  echo "e2e:live-hermes: BLOCKED — docker daemon unreachable (start Docker/OrbStack)"
  exit 0
fi
if ! command -v openshell >/dev/null 2>&1; then
  echo "e2e:live-hermes: BLOCKED — openshell CLI not found on PATH"
  exit 0
fi
if [ -z "${AGENTOS_LIVE_HERMES_SANDBOX:-}" ]; then
  echo "e2e:live-hermes: BLOCKED — AGENTOS_LIVE_HERMES_SANDBOX is not set (name the user's Hermes sandbox)"
  exit 0
fi

# --- Run the gated live e2e against the user's REAL Hermes sandbox. NEVER create/delete it. -----------
# The test gates on AGENTOS_LIVE_HERMES_SANDBOX (the sandbox NAME); export AGENTOS_LIVE_OPENSHELL=1 too
# in case any shared OpenShell live gate keys on it. We adopt + observe ONLY — no sandbox lifecycle.
export AGENTOS_LIVE_OPENSHELL=1

( cd "$ROOT" && node_modules/.bin/vitest run \
    src/hosting/adapters/nemoclaw/hermes.live.test.ts ) &
VPID=$!
# Hard timeout guards against a hung grpc-js channel (no close()): a hang becomes a failure, not a block.
( sleep 300; kill -9 "$VPID" 2>/dev/null ) &
WPID=$!
wait "$VPID"
RC=$?
kill "$WPID" 2>/dev/null

if [ "$RC" = 0 ]; then
  echo "e2e:live-hermes: ok — adopt -> status running (REAL Hermes gateway) -> reconcile verified (sandbox NOT deleted)"
else
  echo "e2e:live-hermes: FAIL — live e2e exit $RC" >&2
fi
exit "$RC"
