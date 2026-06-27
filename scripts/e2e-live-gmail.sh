#!/usr/bin/env bash
# e2e:live-gmail (SLICE-ACT3-live) — RUN the live, governed gmail.send self-send against REAL Google.
#
# This is the GATED-LIVE proof for the runtime-direct action path: build the TS, then drive the FULL governed
# pipeline (screen -> authorize[egress fold + approval] -> cost -> commit-before-effect -> effect[guard ->
# google connector -> REAL HttpActionTransport (node fetch)] -> boundary) for ONE gmail.send SELF-send to the
# operator's throwaway test account. The transport resolves the OAuth placeholder from env AT EGRESS (the only
# resolution point) — credential-blind to brain/audit/WORM/projection.
#
# GATED (skip-by-default; NEVER fake-green):
#   • any of AGENTOS_ACTION_LIVE / AGENTOS_ACTION_TEST_ACCOUNT / AGENTOS_GMAIL_OAUTH_KEY / AGENTOS_EGRESS_ALLOW
#     unset -> print "SKIP (env not set)" and exit 0;
#   • all present -> build dist + drive the real self-send against Google (the .mjs prints "ABOUT TO SEND").
#
# HONEST boundary: runtime-direct (this process holds the token at egress). Production-strongest = sandbox
# SecretResolver (EXEC2). The token rides ONLY this process's env — never the repo, logs, or the conversation.
#
# NOT part of `pnpm run verify` (verify must not hit the network / hold a token) — opt-in live proof.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- GATE: skip-by-default unless the operator opts in with the full live env. --------------------
if [ "${AGENTOS_ACTION_LIVE:-}" = "" ] \
  || [ "${AGENTOS_ACTION_TEST_ACCOUNT:-}" = "" ] \
  || [ "${AGENTOS_GMAIL_OAUTH_KEY:-}" = "" ] \
  || [ "${AGENTOS_EGRESS_ALLOW:-}" = "" ]; then
  echo "e2e:live-gmail: SKIP (env not set) — set AGENTOS_ACTION_LIVE + AGENTOS_ACTION_TEST_ACCOUNT + AGENTOS_GMAIL_OAUTH_KEY + AGENTOS_EGRESS_ALLOW to run a real self-send"
  exit 0
fi

# CREDENTIAL-BLIND: name only the fixed ENV VARIABLE NAME constant, NEVER its value. ONE-LEVEL:
# AGENTOS_GMAIL_OAUTH_KEY DIRECTLY HOLDS the token. The .mjs's liveGmailPreflight does the real,
# fixed-reason validation.
echo "e2e:live-gmail: live env present (AGENTOS_GMAIL_OAUTH_KEY holds the token) — running the governed live self-send…"

echo "e2e:live-gmail: building TS (dist)…"
( cd "$ROOT" && pnpm run build >/dev/null 2>&1 ) || { echo "e2e:live-gmail: FAIL — TS build" >&2; exit 1; }

DRIVER="$ROOT/scripts/act-live-gmail.mjs"
if [ ! -f "$DRIVER" ]; then
  echo "e2e:live-gmail: BLOCKED — live driver $DRIVER not present" >&2
  exit 1
fi

echo "e2e:live-gmail: driving the real governed gmail.send self-send…"
( cd "$ROOT" && node "$DRIVER" )
RC=$?

if [ "$RC" = 0 ]; then echo "e2e:live-gmail: ok — governed live self-send executed (confirm receipt in the test mailbox)"
else echo "e2e:live-gmail: FAIL — live e2e exit $RC" >&2; fi
exit "$RC"
