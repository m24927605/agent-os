#!/usr/bin/env bash
# e2e:live-hermes-desktop (SLICE-HDI1) — RUN the GATED LIVE DESKTOP-PATH HARNESS: the LAST MILE for a real
# Hermes DESKTOP user. It registers our governed exec MCP bin into Hermes's OWN `config.yaml` `mcp_servers`
# map (via `hermes mcp add`, argv built by the pure `buildHermesMcpAddArgv`) UNDER AN ISOLATED, TEMP
# HERMES_HOME (NEVER the user's real ~/.hermes), then drives a HEADLESS `hermes --oneshot` so a REAL Hermes
# Desktop AUTONOMOUSLY reads config.yaml, SPAWNS `node dist/.../exec-mcp-server-bin.js`, discovers + calls
# our bounded exec.echo -> the bin's governed pipeline (runGovernedToolCall) -> REAL OpenShell exec -> the
# result surfaces in the one-shot output. The bin's WORM ships every receipt to the SHARED kernel chain.
# It runs the gated live test in `hermes-desktop.live.test.ts`.
#
# This is the CONFIG.YAML path (distinct from EXEC4c-b's ACP `session/new.mcpServers` path): both land in
# Hermes's register_mcp_servers -> our SAME governed bin -> SAME governance + shared WORM. WE-stay-executor
# under Hermes-spawn: the bin is Agent OS compiled code; even though Hermes spawns it from config.yaml +
# controls its lifecycle, EVERY tools/call still routes through the single governed edge. Hermes NEVER
# self-executes; killing the bin just stops it (fail-closed).
#
# ⚠️ DUAL-GATE — BOTH must be set to "1":
#   AGENTOS_LIVE_DESKTOP_HERMES=1  (real Hermes, real model credits)
#   AGENTOS_LIVE_OPENSHELL=1       (real OpenShell sandbox side effects)
# A missing gate is a CLEAN block (exit 0) — nothing is driven, nothing fails, no credits spent.
#
# OPTIONAL kernel gate (turns on the SHARED-WORM assertion that the bin's receipt is in the real kernel chain):
#   AGENTOS_LIVE_KERNEL_ENDPOINT=<host:port>  — when set, it is also threaded into the bin's config.yaml env
#   so the spawned bin ships its receipts to that REAL kernel partition; the test reads the partition chain
#   back and asserts >=1 entry.
#
# OPTIONAL provider/model flags the user's Hermes needs for headless drive:
#   AGENTOS_LIVE_HERMES_MODEL_ARGS="--provider <p> --model <m>"  (appended to the one-shot command).
#
# ⚠️ ISOLATION: the test sets HERMES_HOME to a FRESH temp dir for both the install + the drive; the user's
# real ~/.hermes/config.yaml is NEVER touched (teardown removes the temp home, confirms no orphan).
#
# ⚠️ HONEST BOUNDARY: the in-repo proof (in `pnpm run verify`) is `buildHermesMcpAddArgv`'s argv correctness
# (--args LAST / --env KEY=VALUE) + its credential-blindness (a secret-shaped value THROWS) + the install
# script's no-hermes clean-block. A REAL Hermes Desktop DISCOVERING + CALLING our governed tools via
# config.yaml is THIS live run, user-initiated. Redaction is best-effort — the REAL credential boundary is a
# sandbox provisioned with ZERO credentials + NO egress, not redaction. The nudge runs a benign echo only.
# Credential-blind: it NEVER reads the user's real ~/.hermes and writes ONLY NON-secret endpoints.
#
# Deliberately NOT part of `pnpm run verify` (which must stay hermetic/fast, never spawn `hermes`, and never
# spend credits); this is the opt-in live proof.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- Preflight gates: a missing prerequisite is a CLEAN block (exit 0). -------------------------------
if [ "${AGENTOS_LIVE_DESKTOP_HERMES:-}" != "1" ] || [ "${AGENTOS_LIVE_OPENSHELL:-}" != "1" ]; then
  echo "e2e:live-hermes-desktop: BLOCKED — both gates required. Set AGENTOS_LIVE_DESKTOP_HERMES=1 (real Hermes, real model credits) AND AGENTOS_LIVE_OPENSHELL=1 (real OpenShell sandbox) to drive the desktop-path config.yaml capstone."
  exit 0
fi
if ! command -v openshell >/dev/null 2>&1; then
  echo "e2e:live-hermes-desktop: BLOCKED — openshell CLI not found on PATH (install the OpenShell CLI + run the gateway)."
  exit 0
fi
if ! command -v hermes >/dev/null 2>&1; then
  echo "e2e:live-hermes-desktop: BLOCKED — the desktop 'hermes' CLI is not on PATH (needed for the config.yaml install + the headless one-shot drive)."
  exit 0
fi

# --- Both gates satisfied: BUILD the bin (a real Hermes Desktop SPAWNS dist/.../exec-mcp-server-bin.js). ---
echo "e2e:live-hermes-desktop: building the compiled bin a real Hermes Desktop will SPAWN from config.yaml..."
( cd "$ROOT" && pnpm run build ) || { echo "e2e:live-hermes-desktop: FAIL — build failed; the bin a real Hermes spawns is not available" >&2; exit 1; }
BUILT_BIN="$ROOT/dist/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js"
if [ ! -f "$BUILT_BIN" ]; then
  echo "e2e:live-hermes-desktop: FAIL — the built bin is missing at $BUILT_BIN after build; a real Hermes cannot spawn it" >&2
  exit 1
fi

# --- RUN the gated vitest. ---------------------------------------------------------------------------
# The test is SELF-BOUNDING: the one-shot has a hard SIGKILL timeout + the per-test vitest timeout, so a
# hung Hermes / a Hermes that never discovers our bin becomes a FAILURE (non-zero RC) with a clear
# diagnostic, never a hang.
echo "e2e:live-hermes-desktop: installing into an ISOLATED temp HERMES_HOME via 'hermes mcp add' then driving a REAL 'hermes --oneshot' that reads config.yaml + SPAWNS our governed exec MCP bin into REAL OpenShell (spends the user's Hermes credits + real sandbox side effects; the user's real ~/.hermes is NEVER touched)..."
VOUT="$(mktemp -t agentos-e2e-hermes-desktop.XXXXXX)"
trap 'rm -f "$VOUT"' EXIT INT TERM

( cd "$ROOT" && node_modules/.bin/vitest run \
    src/runtime/brain/adapters/hermes/hermes-desktop.live.test.ts ) 2>&1 | tee "$VOUT" &
VPID=$!
# Hard timeout guards against a hung child: a hang becomes a failure, not a block.
( sleep 720; kill -9 "$VPID" 2>/dev/null ) &
WPID=$!
wait "$VPID"
RC=$?
kill "$WPID" 2>/dev/null

# NON-VACUITY GUARD: vitest exits 0 even when every test SKIPS. The live proof is worthless if the gated
# suite did not actually RUN, so a green that contains "skipped" (or lacks a "passed" count) is treated as
# a FAIL — we never print "ok" without the real desktop-path drive having executed.
if [ "$RC" = 0 ]; then
  if grep -qE "[0-9]+ +skipped" "$VOUT" || ! grep -qE "[0-9]+ +passed" "$VOUT"; then
    echo "e2e:live-hermes-desktop: FAIL — gated live drive did not RUN (skipped / no passing tests) despite exit 0; the proof is vacuous" >&2
    exit 1
  fi
fi

if [ "$RC" = 0 ]; then
  echo "e2e:live-hermes-desktop: ok — a REAL Hermes Desktop read our installed config.yaml mcp_servers.agentos-exec (isolated temp home), SPAWNED our governed exec MCP bin, AUTONOMOUSLY discovered (tools/list) + called (tools/call) exec.echo via 'hermes --oneshot' -> the bin's runGovernedToolCall -> REAL OpenShell exec (exit=0 + hello); deny-by-default held; bounded; the bin's receipts landed in the SHARED kernel chain (if the kernel gate was on). The desktop user can use Agent OS via the config.yaml path. See the [HDI1] logs for what was installed + what ran."
else
  echo "e2e:live-hermes-desktop: FAIL — desktop-path drive exit $RC (see the [HDI1] diagnostics above; the real Hermes Desktop may not have discovered/spawned our bin via the config.yaml path — the exact thing this live run pins)" >&2
fi
exit "$RC"
