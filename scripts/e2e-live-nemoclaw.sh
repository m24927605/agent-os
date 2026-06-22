#!/usr/bin/env bash
# e2e:live-nemoclaw (OS-S2a) — RUN the live NemoClaw hosting proof through the PRODUCTION composition
# root. createNemoClawOnOpenShell SELF-CREATES the sandbox via the adapter (REAL CreateSandbox -> wait
# READY), drives NemoClawAgentHosting through the S10 CommandSink onto the mTLS gRPC ExecSandbox
# transport, proves host -> status running -> reconcile, then self-DELETES the sandbox (DeleteSandbox).
# NO CLI `sandbox create`/`delete` and NO id-parsing here anymore — the composition root owns the full
# lifecycle on ONE adapter. Hosts a trivial python3 HTTP gateway (no LLM key). Hermetic + self-cleaning.
# Deliberately NOT part of `pnpm run verify` (which must stay hermetic/fast and must not spawn docker /
# a gateway); this is the opt-in live proof.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- Preflight: a missing prerequisite is a CLEAN block (exit 0), never a hang or a hard failure. ------
if ! docker info >/dev/null 2>&1; then
  echo "e2e:live-nemoclaw: BLOCKED — docker daemon unreachable (start Docker/OrbStack)"
  exit 0
fi
if ! command -v openshell >/dev/null 2>&1; then
  echo "e2e:live-nemoclaw: BLOCKED — openshell CLI not found on PATH"
  exit 0
fi

# --- Run the gated live e2e + the OS-S2a live lifecycle transport test against the real gateway. ------
# Both tests self-create + self-delete their sandbox via the adapter; they need only AGENTOS_LIVE_OPENSHELL=1.
export AGENTOS_LIVE_OPENSHELL=1

( cd "$ROOT" && node_modules/.bin/vitest run \
    src/hosting/adapters/nemoclaw/nemoclaw.live.test.ts \
    src/runtime/openshell/grpc-transport.live.test.ts ) &
VPID=$!
# Hard timeout guards against a hung grpc-js channel (no close()): a hang becomes a failure, not a block.
( sleep 300; kill -9 "$VPID" 2>/dev/null ) &
WPID=$!
wait "$VPID"
RC=$?
kill "$WPID" 2>/dev/null

if [ "$RC" = 0 ]; then
  echo "e2e:live-nemoclaw: ok — composition root create -> READY -> host -> status running -> reconcile -> delete verified"
else
  echo "e2e:live-nemoclaw: FAIL — live e2e exit $RC" >&2
fi
exit "$RC"
