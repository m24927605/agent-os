#!/usr/bin/env bash
# e2e:live-desktop-hermes (SLICE-DHB1 skeleton) — the GATED live proof that Agent OS can drive a
# LOCALLY-RUN desktop Hermes as its brain over ACP (Agent Client Protocol: JSON-RPC over stdio, the
# surface `hermes acp` exposes). intent -> desktop Hermes ACP proposal -> the SAME governed pipeline
# (screen -> authorize -> cost -> commit-before-effect -> effect), credential-blind + propose-only.
#
# ⚠️ HONEST BOUNDARY: DHB1 ships ONLY this skeleton. It does NOT yet launch the real `hermes acp` stdio
# subprocess or bind the exact ACP message dialect — that (initialize -> session/new -> session/prompt
# -> session/update, with the dialect confirmed via `hermes acp --check`, plus the propose-only live
# proof) is DHB2. Until DHB2 lands the live wire, this script is a CLEAN BLOCK (exit 0); it NEVER
# fakes a green and NEVER hangs.
#
# Distinct from `e2e:live-hermes` (which adopts a Hermes gateway INSIDE an OpenShell sandbox): this
# vertical drives the user's *local desktop Hermes* (sandbox backend local/Docker/SSH/…, NOT OpenShell).
#
# Deliberately NOT part of `pnpm run verify` (which must stay hermetic/fast and must never launch an
# external agent process); this is the opt-in live proof.
set -uo pipefail

# --- Preflight gates: a missing prerequisite is a CLEAN block (exit 0), never a hang or hard failure. -
if ! command -v hermes >/dev/null 2>&1; then
  echo "e2e:live-desktop-hermes: BLOCKED — desktop Hermes 'hermes' CLI not found on PATH (install desktop Hermes)"
  exit 0
fi
if [ "${AGENTOS_LIVE_DESKTOP_HERMES:-}" != "1" ]; then
  echo "e2e:live-desktop-hermes: BLOCKED — AGENTOS_LIVE_DESKTOP_HERMES is not set to 1 (opt-in gate for the live ACP drive)"
  exit 0
fi

# --- DHB2 lands here: launch the real `hermes acp` subprocess and drive the live ACP session. --------
# The real wire is intentionally NOT implemented in DHB1. Even with both gates satisfied we BLOCK
# clean rather than fake a pass — the live `hermes acp` stdio drive (initialize -> session/new ->
# session/prompt -> session/update -> DesktopHermesTurnSource -> HermesBrainShim -> governed effect)
# is DHB2 scope. Replace this block in DHB2 with the gated vitest that drives the real subprocess.
echo "e2e:live-desktop-hermes: BLOCKED — live ACP drive of 'hermes acp' is DHB2 (DHB1 ships the in-repo seam + Fake ACP transport only)"
exit 0
