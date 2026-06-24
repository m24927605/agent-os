#!/usr/bin/env bash
# e2e:live-exec-mcp-stdio (SLICE-EXEC4c-b) — RUN the GATED LIVE AUTONOMOUS-CAPSTONE HARNESS: a REAL desktop
# `hermes acp` brain is handed our STDIO MCP descriptor in session/new.mcpServers, SPAWNS our compiled
# governed exec MCP bin (`node dist/.../exec-mcp-server-bin.js`), AUTONOMOUSLY discovers our bounded exec
# tools via tools/list, calls one via tools/call -> the SPAWNED bin's governed pipeline (runGovernedToolCall)
# -> REAL OpenShell exec -> real result -> Hermes continues. The bin's WORM ships every receipt to the SHARED
# kernel chain (unified evidence). It runs the gated live test in `mcp/exec-mcp-stdio.live.test.ts`.
#
# This is the (A)+(B)+(EXEC4b http) ALL-cannot-show thing: a REAL Hermes AUTONOMOUSLY SPAWNING + calling OUR
# governed tools over STDIO — the live-pinned constraint (`hermes acp` only supports STDIO mcpServers, no
# http/sse). WE-stay-executor under Hermes-spawn: the bin is Agent OS compiled code; even though Hermes
# spawns it + controls its stdin/stdout/lifecycle, EVERY tools/call still routes through the single governed
# edge in the bin. Hermes NEVER self-executes; killing the bin just stops it (fail-closed).
#
# ⚠️ DUAL-GATE — BOTH must be set to "1":
#   AGENTOS_LIVE_DESKTOP_HERMES=1  (real Hermes, real model credits)
#   AGENTOS_LIVE_OPENSHELL=1       (real OpenShell sandbox side effects)
# A missing gate is a CLEAN block (exit 0) — nothing is driven, nothing fails, no credits spent.
#
# OPTIONAL kernel gate (turns on the SHARED-WORM assertion that the bin's receipt is in the real kernel chain):
#   AGENTOS_LIVE_KERNEL_ENDPOINT=<host:port>  — when set, it is also threaded into the bin's descriptor env so
#   the spawned bin ships its receipts to that REAL kernel partition; the test then reads the partition chain
#   back and asserts >=1 entry. When unset, the autonomous-exec proof falls back to the streamed-frame
#   evidence (the bin still ships to its default local kernel endpoint if reachable; the assertion does not
#   require the readback).
#
# ⚠️ HONEST BOUNDARY: the in-repo proof (in `pnpm run verify`) is the bin's REAL-mode SHARED-KERNEL WORM
# wiring proven vs a FAKE AppendTransport (commit-before-effect over createPartitionedIngestSink; FAKE stays
# in-memory) AND the STDIO descriptor advertised in a real session/new. The REAL autonomous spawn + discover +
# call + the EXACT ACP STDIO descriptor shape Hermes accepts + the receipts in the REAL shared kernel chain is
# THIS live run, user-initiated. Redaction is best-effort — the REAL credential boundary is a sandbox
# provisioned with ZERO real credentials + NO egress, not redaction. The nudge intent runs benign echo/ls
# only. Credential-blind: it NEVER reads ~/.hermes and advertises ONLY NON-secret endpoints in the descriptor.
#
# Deliberately NOT part of `pnpm run verify` (which must stay hermetic/fast, never spawn a gateway or
# `hermes acp`, and never spend credits); this is the opt-in live proof.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- Preflight gates: a missing prerequisite is a CLEAN block (exit 0). -------------------------------
if [ "${AGENTOS_LIVE_DESKTOP_HERMES:-}" != "1" ] || [ "${AGENTOS_LIVE_OPENSHELL:-}" != "1" ]; then
  echo "e2e:live-exec-mcp-stdio: BLOCKED — both gates required. Set AGENTOS_LIVE_DESKTOP_HERMES=1 (real Hermes, real model credits) AND AGENTOS_LIVE_OPENSHELL=1 (real OpenShell sandbox) to drive the autonomous STDIO-spawn capstone."
  exit 0
fi
if ! command -v openshell >/dev/null 2>&1; then
  echo "e2e:live-exec-mcp-stdio: BLOCKED — openshell CLI not found on PATH (install the OpenShell CLI + run the gateway)."
  exit 0
fi
if ! command -v hermes >/dev/null 2>&1; then
  echo "e2e:live-exec-mcp-stdio: BLOCKED — the desktop 'hermes' CLI is not on PATH (needed for the real-brain autonomous STDIO-spawn drive)."
  exit 0
fi

# --- Both gates satisfied: BUILD the bin (a real Hermes SPAWNS `node dist/.../exec-mcp-server-bin.js`). ----
echo "e2e:live-exec-mcp-stdio: building the compiled bin a real Hermes will SPAWN..."
( cd "$ROOT" && pnpm run build ) || { echo "e2e:live-exec-mcp-stdio: FAIL — build failed; the bin a real Hermes spawns is not available" >&2; exit 1; }
BUILT_BIN="$ROOT/dist/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js"
if [ ! -f "$BUILT_BIN" ]; then
  echo "e2e:live-exec-mcp-stdio: FAIL — the built bin is missing at $BUILT_BIN after build; a real Hermes cannot spawn it" >&2
  exit 1
fi

# --- RUN the gated vitest. ---------------------------------------------------------------------------
# The test is SELF-BOUNDING: the AcpStdioTransport startup/idle guards + the OpenShell deadlines + the
# per-test vitest timeout mean a hung child / stuck stream / a Hermes that never spawns+discovers becomes a
# FAILURE (non-zero RC) with a clear diagnostic, never a hang.
echo "e2e:live-exec-mcp-stdio: driving a REAL hermes acp brain that SPAWNS our governed exec MCP bin over stdio, AUTONOMOUSLY discovers + calls it, into REAL OpenShell (spends the user's Hermes credits + real sandbox side effects)..."
VOUT="$(mktemp -t agentos-e2e-exec-mcp-stdio.XXXXXX)"
trap 'rm -f "$VOUT"' EXIT INT TERM

( cd "$ROOT" && node_modules/.bin/vitest run \
    src/runtime/brain/adapters/hermes/mcp/exec-mcp-stdio.live.test.ts ) 2>&1 | tee "$VOUT" &
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
    echo "e2e:live-exec-mcp-stdio: FAIL — gated live drive did not RUN (skipped / no passing tests) despite exit 0; the proof is vacuous" >&2
    exit 1
  fi
fi

if [ "$RC" = 0 ]; then
  echo "e2e:live-exec-mcp-stdio: ok — a REAL hermes acp brain SPAWNED our governed exec MCP bin over stdio, AUTONOMOUSLY discovered (tools/list) + called (tools/call) exec.echo/exec.ls -> the bin's runGovernedToolCall -> REAL OpenShell exec (>=1 real exit=0); deny-by-default held for its other tools; bounded; the bin's receipts landed in the SHARED kernel chain (if the kernel gate was on). See the [EXEC4c-b] logs for the STDIO descriptor + what it discovered/ran."
else
  echo "e2e:live-exec-mcp-stdio: FAIL — autonomous STDIO-spawn drive exit $RC (see the [EXEC4c-b] diagnostics above; the real Hermes may not accept the session/new STDIO descriptor shape / may not have spawned+discovered our bin — the exact thing this live run pins)" >&2
fi
exit "$RC"
