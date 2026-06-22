#!/usr/bin/env bash
# e2e:live-nemoclaw (NC-S11b) — RUN the live NemoClaw hosting proof: drive NemoClawAgentHosting through
# the S10 CommandSink onto the CONVERGED mTLS gRPC ExecSandbox transport against a REAL OpenShell
# sandbox. Hosts a trivial python3 HTTP gateway (no LLM key), proves host -> status running -> reconcile,
# then tears it down. Hermetic + self-cleaning. Deliberately NOT part of `pnpm run verify` (which must
# stay hermetic/fast and must not spawn docker / a gateway); this is the opt-in live proof.
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

# --- Ensure a sandbox: reuse the caller's, else create one (and tear it down on exit if WE created it). -
CREATED_NAME=""        # the sandbox NAME we created (delete keys on name, NOT the gateway id)
SANDBOX_ID="${AGENTOS_LIVE_OPENSHELL_SANDBOX:-}"

cleanup() {
  if [ -n "$CREATED_NAME" ]; then
    echo "e2e:live-nemoclaw: deleting sandbox we created ($CREATED_NAME)…"
    openshell sandbox delete "$CREATED_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [ -z "$SANDBOX_ID" ]; then
  CREATED_NAME="agentos-nc-live"
  echo "e2e:live-nemoclaw: no AGENTOS_LIVE_OPENSHELL_SANDBOX — creating $CREATED_NAME from openclaw…"
  # A trailing `-- <cmd>` makes create run-and-return; WITHOUT it the CLI opens an interactive attach
  # (`[?2004h`) which hangs/fails non-interactively. The sandbox persists Ready after the cmd exits.
  openshell sandbox create --from openclaw --name "$CREATED_NAME" -- sh -c 'true' >/dev/null 2>&1 \
    || { echo "e2e:live-nemoclaw: BLOCKED — sandbox create failed (is the gateway running?)"; exit 0; }
  # Resolve the gateway-assigned stable id (the ExecSandbox lookup key; `get` has no JSON flag, so
  # strip ANSI and pull the UUID from the human `Id:` line).
  SANDBOX_ID="$(openshell sandbox get "$CREATED_NAME" 2>/dev/null \
    | sed 's/\x1b\[[0-9;]*m//g' \
    | sed -n 's/.*Id:[[:space:]]*\([0-9a-fA-F-]\{36\}\).*/\1/p' | head -1)"
  if [ -z "$SANDBOX_ID" ]; then
    echo "e2e:live-nemoclaw: BLOCKED — could not resolve the created sandbox's gateway id"; exit 0
  fi
  echo "e2e:live-nemoclaw: created sandbox $CREATED_NAME id=$SANDBOX_ID"
else
  echo "e2e:live-nemoclaw: reusing sandbox $SANDBOX_ID"
fi

# --- Run the gated live e2e + the converged OS-S1 live transport test against the real gateway. --------
export AGENTOS_LIVE_OPENSHELL=1
export AGENTOS_LIVE_OPENSHELL_SANDBOX="$SANDBOX_ID"

( cd "$ROOT" && node_modules/.bin/vitest run \
    src/hosting/adapters/nemoclaw/nemoclaw.live.test.ts \
    src/runtime/openshell/grpc-transport.live.test.ts ) &
VPID=$!
# Hard timeout guards against a hung grpc-js channel (no close()): a hang becomes a failure, not a block.
( sleep 180; kill -9 "$VPID" 2>/dev/null ) &
WPID=$!
wait "$VPID"
RC=$?
kill "$WPID" 2>/dev/null

if [ "$RC" = 0 ]; then
  echo "e2e:live-nemoclaw: ok — real NemoClaw host -> status running -> reconcile verified, gateway torn down"
else
  echo "e2e:live-nemoclaw: FAIL — live e2e exit $RC" >&2
fi
exit "$RC"
