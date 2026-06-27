#!/usr/bin/env bash
# e2e:live-browser (SLICE-ACT5d-live) — RUN the live, governed browser drive against a REAL headless
# browser. Build the TS, then drive the FULL governed pipeline (screen -> authorize[egress fold] -> cost
# -> commit-before-effect -> effect[page connector -> REAL browser via route-intercepted egress] ->
# boundary) for ONE session.open -> browser.navigate(<first allowlist host>) -> browser.read ->
# session.close. The browser context ABORTS any non-allowlisted host at the network (substrate-PRIMARY).
#
# GATED (skip-by-default; NEVER fake-green):
#   • AGENTOS_EGRESS_ALLOW unset -> print "SKIP (env not set)" and exit 0;
#   • set -> build dist + run the .mjs. The .mjs itself FAIL-CLOSES (exit 2) if the browser library
#     (playwright) is not installed — verify never installs it (ZERO-new-dep); the operator installs it
#     for the live drive (`pnpm add -D playwright && pnpm exec playwright install chromium`).
#
# HONEST boundary: runtime-direct (this process drives the real browser). navigate/read are READS
# (benign, no approval/credential) against a public page. The real network boundary is the browser's
# route-interception (abort non-allowlisted host) — stronger than a PDP best-effort projection.
#
# NOT part of `pnpm run verify` (verify must not launch a real browser / hit the network) — opt-in live proof.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- GATE: skip-by-default unless the operator opts in with the egress allowlist. ----------------
if [ "${AGENTOS_EGRESS_ALLOW:-}" = "" ]; then
  echo "e2e:live-browser: SKIP (env not set) — set AGENTOS_EGRESS_ALLOW to the host(s) the browser may reach to run a real governed browser drive"
  exit 0
fi

echo "e2e:live-browser: egress allowlist present (AGENTOS_EGRESS_ALLOW) — running the governed live browser drive…"

echo "e2e:live-browser: building TS (dist)…"
( cd "$ROOT" && pnpm run build >/dev/null 2>&1 ) || { echo "e2e:live-browser: FAIL — TS build" >&2; exit 1; }

DRIVER="$ROOT/scripts/act5-live-browser.mjs"
if [ ! -f "$DRIVER" ]; then
  echo "e2e:live-browser: BLOCKED — live driver $DRIVER not present" >&2
  exit 1
fi

echo "e2e:live-browser: driving the real governed browser navigate+read…"
( cd "$ROOT" && node "$DRIVER" )
RC=$?

# The .mjs exits 0 ONLY when both navigate+read EXECUTED (governed); 2 if the browser library is absent
# (fail-closed, nothing run); 1 on a pipeline-level deny. So RC=0 here means "actually driven + sanitized
# content printed"; the driver already printed the precise reason on its own stderr otherwise.
if [ "$RC" = 0 ]; then echo "e2e:live-browser: ok — governed live browser navigate+read EXECUTED (sanitized content printed above)"
elif [ "$RC" = 2 ]; then echo "e2e:live-browser: BLOCKED — browser library not installed (install playwright for the live drive); nothing run" >&2
else echo "e2e:live-browser: FAIL — NOT EXECUTED (live e2e exit $RC; see the driver's 'NOT EXECUTED — …' reason above)" >&2; fi
exit "$RC"
