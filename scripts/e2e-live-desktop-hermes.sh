#!/usr/bin/env bash
# e2e:live-desktop-hermes (SLICE-DHB2b) — RUN the GATED live proof that Agent OS drives a LOCALLY-RUN
# desktop Hermes as its brain over ACP (Agent Client Protocol: JSON-RPC over stdio, the surface
# `hermes acp` exposes). It spawns the REAL `hermes acp` subprocess via DHB2a's `AcpStdioTransport`
# (initialize -> session/new -> session/prompt -> session/update), wraps it in DHB1's
# `DesktopHermesTurnSource` + `HermesBrainShim`, drives one safe intent, and runs the brain events
# through `governBrainStream`. It proves the live invariants: >=1 real frame, a captured governed
# PROPOSAL, propose-only (nothing executed on the host), credential-blind — and logs the M3/M4 dialect
# diagnostics so this run CONFIRMS or REVEALS divergence from DHB2a's wire assumptions.
#
# ⚠️ HONEST BOUNDARY: this drive uses the REAL `hermes acp` + the user's AUTHENTICATED Hermes, so it
# SPENDS the user's Hermes MODEL CREDITS and touches their account. That is why it is GATED + USER-
# initiated (set AGENTOS_LIVE_DESKTOP_HERMES=1 and run it yourself). It remains credential-blind: it
# NEVER reads `~/.hermes` and NEVER puts an Agent OS secret on the child's stdin. If the real ACP
# dialect diverges from DHB2a's mapping, the test FAILS with a clear diagnostic (it never hangs, never
# fakes a green) — telling you DHB2a's mapping needs a follow-up fix.
#
# Distinct from `e2e:live-hermes` (which adopts a Hermes gateway INSIDE an OpenShell sandbox): this
# vertical drives the user's *local desktop Hermes* (sandbox backend local/Docker/SSH/…, NOT OpenShell).
#
# Deliberately NOT part of `pnpm run verify` (which must stay hermetic/fast and must never launch an
# external agent process or spend credits); this is the opt-in live proof.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- Preflight gates: a missing prerequisite is a CLEAN block (exit 0), never a hang or hard failure. -
if ! command -v hermes >/dev/null 2>&1; then
  echo "e2e:live-desktop-hermes: BLOCKED — desktop Hermes 'hermes' CLI not found on PATH (install desktop Hermes)"
  exit 0
fi
if [ "${AGENTOS_LIVE_DESKTOP_HERMES:-}" != "1" ]; then
  echo "e2e:live-desktop-hermes: BLOCKED — AGENTOS_LIVE_DESKTOP_HERMES is not set to 1 (opt-in gate for the live ACP drive)"
  exit 0
fi

# --- Both gates satisfied: RUN the gated vitest that drives the REAL `hermes acp` subprocess. ---------
# This spends the user's Hermes model credits (the gate above is exactly why it is user-initiated). The
# test is SELF-BOUNDING: the AcpStdioTransport's startup/idle guards + the per-test vitest timeout mean
# a hung child / stuck stream becomes a FAILURE (non-zero RC), never a silent block or an infinite hang.
echo "e2e:live-desktop-hermes: driving the REAL 'hermes acp' (spends the user's Hermes model credits)..."
VOUT="$(mktemp -t agentos-e2e-desktop-hermes.XXXXXX)"
trap 'rm -f "$VOUT"' EXIT INT TERM

( cd "$ROOT" && node_modules/.bin/vitest run \
    src/runtime/brain/adapters/hermes/desktop.live.test.ts ) 2>&1 | tee "$VOUT"
RC="${PIPESTATUS[0]}"

# NON-VACUITY GUARD: vitest exits 0 even when every test SKIPS. The live proof is worthless if the gated
# suite did not actually RUN, so a green that contains "skipped" (or lacks a "passed" count) is treated
# as a FAIL — we never print "ok" without the real `hermes acp` drive having executed.
if [ "$RC" = 0 ]; then
  if grep -qE "[0-9]+ +skipped" "$VOUT" || ! grep -qE "[0-9]+ +passed" "$VOUT"; then
    echo "e2e:live-desktop-hermes: FAIL — gated live drive did not RUN (skipped / no passing tests) despite exit 0; the proof is vacuous" >&2
    exit 1
  fi
fi

if [ "$RC" = 0 ]; then
  echo "e2e:live-desktop-hermes: ok — real 'hermes acp' drive verified: >=1 frame, governed proposal, propose-only (nothing executed), credential-blind"
else
  echo "e2e:live-desktop-hermes: FAIL — live drive exit $RC (see the [DHB2b/M3] + [DHB2b/M4] dialect diagnostics above; the real ACP dialect may diverge from DHB2a's mapping)" >&2
fi
exit "$RC"
