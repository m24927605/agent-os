#!/usr/bin/env bash
# e2e:live-agt (SLICE-R9c) — RUN the live AGT-gated decision path against a REAL Python AGT sidecar.
#
# This is the GATED-LIVE proof for the AGT advisory: build the TS, then drive the autonomous path
# (Hermes/bin -> authorize -> AGT advisory over UDS -> AGT-gated decision) against a real AGT sidecar
# the OPERATOR provides. The sidecar (a Python AGT engine over gRPC-over-UDS) is out of this repo's
# scope, so the script is GATED:
#
#   • absent AGENTOS_LIVE_AGT (or AGT_UDS_PATH) -> print "SKIPPED …" and exit 0 (NOT fake-green);
#   • present -> drive the real path against the operator's AGT sidecar and assert AGT allow/deny.
#
# This is the HONEST boundary: R9c makes AGT onboarding turnkey (config -> AGT_* env -> R9b-2b registers
# the secondary), but REAL AGT live still needs the operator's sidecar. This script is that path.
#
# NOT part of `pnpm run verify` (verify must not require a real Python AGT engine) — opt-in live proof.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- GATE: skip-by-default unless the operator opts in with a real AGT sidecar. -------------------
if [ "${AGENTOS_LIVE_AGT:-}" != "1" ] || [ -z "${AGT_UDS_PATH:-}" ]; then
  echo "e2e:live-agt: SKIPPED (set AGENTOS_LIVE_AGT + AGT_UDS_PATH to run against a real AGT sidecar)"
  exit 0
fi

# CREDENTIAL-BLIND: report only the ENV KEY NAME, never the AGT_UDS_PATH value.
echo "e2e:live-agt: AGENTOS_LIVE_AGT set + AGT_UDS_PATH present — running the live AGT-gated e2e…"

if [ ! -S "$AGT_UDS_PATH" ]; then
  echo "e2e:live-agt: BLOCKED — AGT_UDS_PATH is set but no UDS socket is listening there (start your AGT sidecar)" >&2
  exit 1
fi

echo "e2e:live-agt: building TS (dist)…"
( cd "$ROOT" && pnpm run build >/dev/null 2>&1 ) || { echo "e2e:live-agt: FAIL — TS build" >&2; exit 1; }

echo "e2e:live-agt: driving the autonomous path against the real AGT sidecar (AGT-gated decision)…"
# The live driver exercises createDecisionTransport(AGT_UDS_PATH) + the authorize AGT secondary against
# the operator's real Python AGT engine and asserts: AGT allow does NOT relax a PDP deny; AGT deny
# blocks the effect; configured-but-down -> deny (fail-closed). Driver path mirrors the SpendGuard
# live .mjs; if it is not yet present this script fails-closed (BLOCKED), never fake-green.
DRIVER="$ROOT/scripts/agt-live-e2e.mjs"
if [ ! -f "$DRIVER" ]; then
  echo "e2e:live-agt: BLOCKED — live driver $DRIVER not present (add it to run against your AGT sidecar)" >&2
  exit 1
fi
( cd "$ROOT" && node "$DRIVER" )
RC=$?

if [ "$RC" = 0 ]; then echo "e2e:live-agt: ok — real AGT advisory allow/deny verified against the live sidecar"
else echo "e2e:live-agt: FAIL — live e2e exit $RC" >&2; fi
exit "$RC"
