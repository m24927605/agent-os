#!/usr/bin/env bash
# e2e:live-substrate-exec (SLICE-EXEC2) — RUN the GATED live proof that the substrate exec primitive,
# reconciled from OpenShell's STREAMING exec onto the buffered port by `makeOpenShellExecCapable`, runs a
# REAL command in a REAL OpenShell sandbox through the credential-blind `makeExecEffect`. It runs the
# single gated live test in `exec-buffered.live.test.ts`:
#   • create a REAL sandbox (CreateSandbox -> wait READY) -> makeExecEffect(makeOpenShellExecCapable(adapter))
#     execs a benign real command (`sh -c 'echo hello; echo err 1>&2; exit 0'`) -> asserts the governed
#     EffectResult{ok:true} carries the REAL "hello" + "exit=0" (output came back through the buffered
#     reconcile, redacted + capped) -> self-DELETES the sandbox (DeleteSandbox). No leaked sandbox.
#
# ⚠️ HONEST BOUNDARY: this is a SANDBOX command (create/exec/delete) against the user's OpenShell gateway
# — REAL side effects (a real sandbox + a real command), NOT LLM credits. That is why it is GATED +
# user-initiated (set AGENTOS_LIVE_OPENSHELL=1 and run it yourself). It is credential-blind: the mTLS
# materials are read from the OpenShell CLI's local store (never inlined, never committed) and no Agent OS
# secret is placed in the command env. EXEC2 = reconcile + this gated live harness; the closed-loop
# real-output feedback to Hermes (DHB3) = EXEC3.
#
# Deliberately NOT part of `pnpm run verify` (which must stay hermetic/fast and must never spawn a
# gateway / docker); this is the opt-in live proof.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- Preflight gates: a missing prerequisite is a CLEAN block (exit 0), never a hang or hard failure. -
if ! command -v openshell >/dev/null 2>&1; then
  echo "e2e:live-substrate-exec: BLOCKED — openshell CLI not found on PATH (install the OpenShell CLI + run the gateway)"
  exit 0
fi
if [ "${AGENTOS_LIVE_OPENSHELL:-}" != "1" ]; then
  echo "e2e:live-substrate-exec: BLOCKED — AGENTOS_LIVE_OPENSHELL is not set to 1 (opt-in gate for the live sandbox exec drive)"
  exit 0
fi

# --- Both gates satisfied: RUN the gated vitest that drives the REAL OpenShell gateway. ---------------
# The test SELF-creates + SELF-deletes its sandbox via the adapter; it needs only AGENTOS_LIVE_OPENSHELL=1.
echo "e2e:live-substrate-exec: driving a REAL OpenShell sandbox exec — create -> exec -> delete (real sandbox side effects)..."
VOUT="$(mktemp -t agentos-e2e-substrate-exec.XXXXXX)"
trap 'rm -f "$VOUT"' EXIT INT TERM

( cd "$ROOT" && node_modules/.bin/vitest run \
    src/runtime/openshell/exec-buffered.live.test.ts ) 2>&1 | tee "$VOUT" &
VPID=$!
# Hard timeout guards against a hung grpc-js channel (no close()): a hang becomes a failure, not a block.
( sleep 300; kill -9 "$VPID" 2>/dev/null ) &
WPID=$!
wait "$VPID"
RC=$?
kill "$WPID" 2>/dev/null

# NON-VACUITY GUARD: vitest exits 0 even when every test SKIPS. The live proof is worthless if the gated
# suite did not actually RUN, so a green that contains "skipped" (or lacks a "passed" count) is treated as
# a FAIL — we never print "ok" without the real OpenShell sandbox exec having executed.
if [ "$RC" = 0 ]; then
  if grep -qE "[0-9]+ +skipped" "$VOUT" || ! grep -qE "[0-9]+ +passed" "$VOUT"; then
    echo "e2e:live-substrate-exec: FAIL — gated live drive did not RUN (skipped / no passing tests) despite exit 0; the proof is vacuous" >&2
    exit 1
  fi
fi

if [ "$RC" = 0 ]; then
  echo "e2e:live-substrate-exec: ok — real sandbox exec verified through makeOpenShellExecCapable + makeExecEffect (create -> exec real command -> real {exitCode,stdout} redacted+capped -> delete)"
else
  echo "e2e:live-substrate-exec: FAIL — live drive exit $RC (the buffered reconcile or the real gateway exec diverged from the EXEC1/EXEC2 mapping)" >&2
fi
exit "$RC"
