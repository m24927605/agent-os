#!/usr/bin/env bash
# e2e:live-capstone (SLICE-EXEC3b) — RUN the GATED LIVE CAPSTONE: the EXEC closed loop driven over a REAL
# OpenShell ephemeral sandbox, against a REAL desktop `hermes acp` brain (A) and a CONTROLLED in-tree
# proposal (B). It runs the gated live tests in `exec-capstone.live.test.ts`:
#
#   (A) SAFETY against a REAL brain — needs BOTH AGENTOS_LIVE_DESKTOP_HERMES=1 (real Hermes, real model
#       credits) AND AGENTOS_LIVE_OPENSHELL=1 (real sandbox side effects). The real Hermes proposes its OWN
#       tools (not our exec.echo/exec.ls); the whole governance net holds against the real brain:
#       PROPOSE-ONLY (Hermes never self-executes), DENY-BY-DEFAULT (its non-registered proposals are denied
#       @policy — 0 governed execs), CREDENTIAL-BLIND, BOUNDED (maxTurns), ephemeral sandbox create+destroy.
#       It LOGS what the real Hermes proposed (observability for whether MCP/EXEC4 is worth doing).
#   (B) SUCCESS path (real exec) — needs ONLY AGENTOS_LIVE_OPENSHELL=1 (the Hermes side is the in-tree
#       CONTROLLED fake). A controlled exec.echo {text:"hello"} proposal -> govern -> REAL OpenShell exec ->
#       EffectResult{ok:true} whose redacted detail carries the REAL "hello" + "exit=0". Proves the JOIN
#       end-to-end over REAL OpenShell with a not-yet-MCP brain.
#
# ⚠️ HONEST BOUNDARY: a real Hermes AUTONOMOUSLY calling OUR exec tools -> real exec is EXEC4 (MCP
# advertisement, session/new.mcpServers), NOT this slice. (A) proves SAFETY vs a real brain; (B) proves
# the success path via a CONTROLLED proposal over real OpenShell. Redaction is best-effort — the REAL
# credential boundary is a sandbox provisioned with ZERO real credentials + NO egress, not redaction.
# (A)+(B) run benign echo/ls only. It is credential-blind: it NEVER reads ~/.hermes and reads the OpenShell
# mTLS materials only from the OpenShell CLI's local store.
#
# Deliberately NOT part of `pnpm run verify` (which must stay hermetic/fast, must never spawn a gateway or
# `hermes acp`, and must never spend credits); this is the opt-in live proof. A missing gate is a CLEAN
# block (exit 0), never a hang or a hard failure.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- Preflight gates: a missing prerequisite is a CLEAN block (exit 0). -------------------------------
# The minimum to RUN anything is AGENTOS_LIVE_OPENSHELL=1 (it runs (B); (A) additionally needs the Hermes
# gate). If NEITHER gate is set, BLOCK clean — nothing is driven and nothing fails.
if [ "${AGENTOS_LIVE_OPENSHELL:-}" != "1" ] && [ "${AGENTOS_LIVE_DESKTOP_HERMES:-}" != "1" ]; then
  echo "e2e:live-capstone: BLOCKED — neither gate set. (A) needs AGENTOS_LIVE_DESKTOP_HERMES=1 AND AGENTOS_LIVE_OPENSHELL=1 (real Hermes + real OpenShell); (B) needs AGENTOS_LIVE_OPENSHELL=1 (controlled proposal over real OpenShell)."
  exit 0
fi
if [ "${AGENTOS_LIVE_OPENSHELL:-}" != "1" ]; then
  # The Hermes gate alone cannot run (A) without a real OpenShell sandbox, and (B) needs OpenShell too.
  echo "e2e:live-capstone: BLOCKED — AGENTOS_LIVE_OPENSHELL is not set to 1. Both (A) and (B) require a REAL OpenShell sandbox; set AGENTOS_LIVE_OPENSHELL=1 (and additionally AGENTOS_LIVE_DESKTOP_HERMES=1 for the (A) real-brain safety drive)."
  exit 0
fi
if ! command -v openshell >/dev/null 2>&1; then
  echo "e2e:live-capstone: BLOCKED — openshell CLI not found on PATH (install the OpenShell CLI + run the gateway)."
  exit 0
fi
if [ "${AGENTOS_LIVE_DESKTOP_HERMES:-}" = "1" ] && ! command -v hermes >/dev/null 2>&1; then
  echo "e2e:live-capstone: BLOCKED — AGENTOS_LIVE_DESKTOP_HERMES=1 but the desktop 'hermes' CLI is not on PATH (needed for the (A) real-brain drive)."
  exit 0
fi

# --- A gate is satisfied: RUN the gated vitest. ------------------------------------------------------
# (B) always runs under AGENTOS_LIVE_OPENSHELL=1; (A) additionally runs when AGENTOS_LIVE_DESKTOP_HERMES=1.
# The tests are SELF-BOUNDING: the AcpStdioTransport startup/idle guards + the OpenShell deadlines + the
# per-test vitest timeouts mean a hung child / stuck stream becomes a FAILURE (non-zero RC), never a hang.
if [ "${AGENTOS_LIVE_DESKTOP_HERMES:-}" = "1" ]; then
  echo "e2e:live-capstone: driving (A) REAL hermes acp SAFETY + (B) controlled exec over REAL OpenShell (spends the user's Hermes credits + real sandbox side effects)..."
else
  echo "e2e:live-capstone: driving (B) controlled exec.echo/exec.ls over a REAL OpenShell sandbox ((A) skipped — AGENTOS_LIVE_DESKTOP_HERMES not set)..."
fi
VOUT="$(mktemp -t agentos-e2e-capstone.XXXXXX)"
trap 'rm -f "$VOUT"' EXIT INT TERM

( cd "$ROOT" && node_modules/.bin/vitest run \
    src/runtime/brain/adapters/hermes/exec-capstone.live.test.ts ) 2>&1 | tee "$VOUT" &
VPID=$!
# Hard timeout guards against a hung grpc-js channel / stuck child: a hang becomes a failure, not a block.
( sleep 600; kill -9 "$VPID" 2>/dev/null ) &
WPID=$!
wait "$VPID"
RC=$?
kill "$WPID" 2>/dev/null

# NON-VACUITY GUARD: vitest exits 0 even when every test SKIPS. The live proof is worthless if the gated
# suite did not actually RUN, so a green that contains "skipped" (or lacks a "passed" count) is treated as
# a FAIL — we never print "ok" without the real drive having executed.
if [ "$RC" = 0 ]; then
  if grep -qE "[0-9]+ +skipped" "$VOUT" || ! grep -qE "[0-9]+ +passed" "$VOUT"; then
    echo "e2e:live-capstone: FAIL — gated live drive did not RUN (skipped / no passing tests) despite exit 0; the proof is vacuous" >&2
    exit 1
  fi
fi

if [ "$RC" = 0 ]; then
  echo "e2e:live-capstone: ok — (B) controlled exec.echo over REAL OpenShell returned the real 'hello'+'exit=0' (propose-only, credential-blind, ephemeral sandbox create+destroy)$([ "${AGENTOS_LIVE_DESKTOP_HERMES:-}" = "1" ] && echo "; (A) the REAL hermes acp brain was governed propose-only + deny-by-default — see the [EXEC3b/A] log for what it proposed (MCP/EXEC4 signal)" )"
else
  echo "e2e:live-capstone: FAIL — live drive exit $RC (see the [EXEC3b/A]+[EXEC3b/B] diagnostics above; the real OpenShell exec or the real ACP dialect may diverge from the EXEC2/EXEC3a mapping)" >&2
fi
exit "$RC"
