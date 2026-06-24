#!/usr/bin/env bash
# e2e:live-exec-mcp (SLICE-EXEC4b) — RUN the GATED LIVE AUTONOMOUS-MCP HARNESS: a REAL desktop `hermes acp`
# brain is handed our in-process governed MCP loopback server in session/new.mcpServers, AUTONOMOUSLY
# discovers our bounded exec tools via tools/list, calls one via tools/call, and the call lands in OUR
# in-process runGovernedToolCall -> REAL OpenShell exec -> real result. It runs the gated live test in
# `exec-mcp.live.test.ts`.
#
# This is the autonomous SUCCESS path EXEC3b (A)+(B) structurally could NOT show: a real Hermes proposing
# OUR registered tools needs MCP advertisement (session/new.mcpServers). Here we ADVERTISE a single
# descriptor pointing at the Agent-OS-hosted in-process governed MCP loopback server, so the brain (the MCP
# client) calls OUR server and OUR handler executes — the brain NEVER self-executes (WE-stay-executor) and
# the WORM/governance stay in OUR process.
#
# ⚠️ DUAL-GATE — BOTH must be set to "1":
#   AGENTOS_LIVE_DESKTOP_HERMES=1  (real Hermes, real model credits)
#   AGENTOS_LIVE_OPENSHELL=1       (real OpenShell sandbox side effects)
# A missing gate is a CLEAN block (exit 0) — nothing is driven, nothing fails, no credits spent.
#
# ⚠️ HONEST BOUNDARY: the in-repo proof (in `pnpm run verify`) is that the mcpServers injection is
# backward-compat (default []) AND the loopback transport does NOT bypass governance (a Fake MCP client
# over the REAL transport -> the EXEC4a handler -> governed over a Fake substrate). The REAL autonomous
# discovery + call + the EXACT ACP descriptor shape Hermes accepts is THIS live run, user-initiated.
# Redaction is best-effort — the REAL credential boundary is a sandbox provisioned with ZERO real
# credentials + NO egress, not redaction. The nudge intent runs benign echo/ls only. It is credential-blind:
# it NEVER reads ~/.hermes and reads the OpenShell mTLS materials only from the OpenShell CLI's local store.
#
# Deliberately NOT part of `pnpm run verify` (which must stay hermetic/fast, never spawn a gateway or
# `hermes acp`, and never spend credits); this is the opt-in live proof.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- Preflight gates: a missing prerequisite is a CLEAN block (exit 0). -------------------------------
if [ "${AGENTOS_LIVE_DESKTOP_HERMES:-}" != "1" ] || [ "${AGENTOS_LIVE_OPENSHELL:-}" != "1" ]; then
  echo "e2e:live-exec-mcp: BLOCKED — both gates required. Set AGENTOS_LIVE_DESKTOP_HERMES=1 (real Hermes, real model credits) AND AGENTOS_LIVE_OPENSHELL=1 (real OpenShell sandbox) to drive the autonomous-MCP harness."
  exit 0
fi
if ! command -v openshell >/dev/null 2>&1; then
  echo "e2e:live-exec-mcp: BLOCKED — openshell CLI not found on PATH (install the OpenShell CLI + run the gateway)."
  exit 0
fi
if ! command -v hermes >/dev/null 2>&1; then
  echo "e2e:live-exec-mcp: BLOCKED — the desktop 'hermes' CLI is not on PATH (needed for the real-brain autonomous-MCP drive)."
  exit 0
fi

# --- Both gates satisfied: RUN the gated vitest. -----------------------------------------------------
# The test is SELF-BOUNDING: the AcpStdioTransport startup/idle guards + the OpenShell deadlines + the
# per-test vitest timeout mean a hung child / stuck stream / a Hermes that never discovers becomes a
# FAILURE (non-zero RC) with a clear diagnostic, never a hang.
echo "e2e:live-exec-mcp: driving a REAL hermes acp brain that AUTONOMOUSLY discovers + calls our governed exec tools over the in-process MCP loopback, into REAL OpenShell (spends the user's Hermes credits + real sandbox side effects)..."
VOUT="$(mktemp -t agentos-e2e-exec-mcp.XXXXXX)"
trap 'rm -f "$VOUT"' EXIT INT TERM

( cd "$ROOT" && node_modules/.bin/vitest run \
    src/runtime/brain/adapters/hermes/exec-mcp.live.test.ts ) 2>&1 | tee "$VOUT" &
VPID=$!
# Hard timeout guards against a hung grpc-js channel / stuck child: a hang becomes a failure, not a block.
( sleep 720; kill -9 "$VPID" 2>/dev/null ) &
WPID=$!
wait "$VPID"
RC=$?
kill "$WPID" 2>/dev/null

# NON-VACUITY GUARD: vitest exits 0 even when every test SKIPS. The live proof is worthless if the gated
# suite did not actually RUN, so a green that contains "skipped" (or lacks a "passed" count) is treated as
# a FAIL — we never print "ok" without the real autonomous drive having executed.
if [ "$RC" = 0 ]; then
  if grep -qE "[0-9]+ +skipped" "$VOUT" || ! grep -qE "[0-9]+ +passed" "$VOUT"; then
    echo "e2e:live-exec-mcp: FAIL — gated live drive did not RUN (skipped / no passing tests) despite exit 0; the proof is vacuous" >&2
    exit 1
  fi
fi

if [ "$RC" = 0 ]; then
  echo "e2e:live-exec-mcp: ok — a REAL hermes acp brain AUTONOMOUSLY discovered (tools/list) + called (tools/call) our governed exec.echo/exec.ls over the in-process MCP loopback -> OUR runGovernedToolCall -> REAL OpenShell exec (>=1 real exit=0); deny-by-default held for its other tools; ephemeral sandboxes create+destroy. See the [EXEC4b] logs for the descriptor + what it discovered/called."
else
  echo "e2e:live-exec-mcp: FAIL — autonomous-MCP drive exit $RC (see the [EXEC4b] diagnostics above; the real Hermes may not accept the session/new.mcpServers descriptor shape / may not have discovered our tools — the exact thing this live run pins)" >&2
fi
exit "$RC"
