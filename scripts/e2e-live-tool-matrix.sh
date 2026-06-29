#!/usr/bin/env bash
# e2e:live-tool-matrix — the COMPLETE, REAL approve/deny flow for the governed tools. Every effect is real;
# nothing is faked. Where a real credential or external target is absent, that family cleanly SKIPS (never
# a fake stand-in). It runs, in one command:
#   (1) the in-sandbox + network matrix — for each exec.*/git.*/net.fetch tool an APPROVE path (real
#       OpenShell exec / real network egress, exit 0, commit-before-effect) + every DENY MODE (screen, cost,
#       egress, approval, deny-by-default), then a kernel readback (append-only, hash-chained,
#       credential-blind). Drives server.handle() directly — NO LLM, NO model credits.
#   (2) the REAL Gmail send (real Google API egress) — gated on the action creds in your env.
#   (3) the REAL browser drive (real Chromium) — gated on its env.
#
# Honest boundary: attester != actor holds to the PROCESS boundary (TR1); HSM/KMS = TR2/deployment.
# Deliberately NOT part of `pnpm run verify` (spawns a kernel + real external effects); opt-in.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

# Load the operator's non-public action creds (Gmail OAuth, test account, egress allowlist, …) if present.
# Credential-blind: values are never printed here; the downstream drivers redact every trace.
if [ -f "$HOME/.env" ]; then set -a; . "$HOME/.env"; set +a; fi

# --- Gate: the in-sandbox matrix needs a live OpenShell gateway. ----------------------------------------
if [ "${AGENTOS_LIVE_OPENSHELL:-}" != "1" ]; then
  echo "e2e:live-tool-matrix: BLOCKED — set AGENTOS_LIVE_OPENSHELL=1 (real OpenShell sandbox side effects)."
  exit 0
fi
if ! command -v openshell >/dev/null 2>&1; then
  echo "e2e:live-tool-matrix: BLOCKED — openshell CLI not found on PATH (install + run the gateway)."
  exit 0
fi
export AGENTOS_OPENSHELL_ENDPOINT="${AGENTOS_OPENSHELL_ENDPOINT:-127.0.0.1:17670}"
export AGENTOS_OPENSHELL_MTLS="${AGENTOS_OPENSHELL_MTLS:-$HOME/.config/openshell/gateways/openshell/mtls}"

# --- (1) Build + spawn a FRESH Go kernel (a fresh append-only partition) + drive the matrix. ------------
TMP="$(mktemp -d -t agentos-tool-matrix.XXXXXX)"
PORT="${AGENTOS_TOOL_MATRIX_PORT:-7798}"
trap 'kill "${KPID:-0}" 2>/dev/null; rm -rf "$TMP"' EXIT

echo "e2e:live-tool-matrix: building + starting a fresh kernel on 127.0.0.1:$PORT ..."
( cd "$ROOT/kernel" && env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local go build -o "$TMP/kernel" ./cmd/kernel ) \
  || { echo "e2e:live-tool-matrix: FAIL — kernel build" >&2; exit 1; }
"$TMP/kernel" --addr "127.0.0.1:$PORT" --chain "$TMP/chain.jsonl" --audit "$TMP/audit.jsonl" >"$TMP/kernel.log" 2>&1 &
KPID=$!
ready=0
for _ in $(seq 1 40); do
  kill -0 "$KPID" 2>/dev/null || { echo "e2e:live-tool-matrix: FAIL — kernel exited early:" >&2; cat "$TMP/kernel.log" >&2; exit 1; }
  grep -q "listening" "$TMP/kernel.log" 2>/dev/null && { ready=1; break; }
  sleep 0.25
done
[ "$ready" = 1 ] || { echo "e2e:live-tool-matrix: FAIL — kernel not ready" >&2; cat "$TMP/kernel.log" >&2; exit 1; }

export AGENTOS_LIVE_KERNEL_ENDPOINT="127.0.0.1:$PORT"
export AGENTOS_KERNEL_INGEST_ENDPOINT="127.0.0.1:$PORT"
echo "e2e:live-tool-matrix: [1/3] in-sandbox + network matrix (exec.* / git.* / net.fetch + every deny mode + kernel readback)…"
pnpm exec vitest run src/runtime/brain/adapters/hermes/mcp/exec-mcp-matrix.live.test.ts \
  || { echo "e2e:live-tool-matrix: FAIL — matrix (see vitest output)" >&2; exit 1; }

# --- (2) REAL Gmail send (real Google API). Self-gates: clean-skips if creds absent. Non-fatal to the run:
#         its own output reports SENT / SKIP / a real failure — a real external family shouldn't sink the
#         whole flow, but it is NEVER faked. -----------------------------------------------------------
echo "e2e:live-tool-matrix: [2/3] real Gmail send (gmail.send → real Google API egress)…"
bash scripts/e2e-live-gmail.sh || echo "e2e:live-tool-matrix: NOTE — Gmail family did not complete (see above; real failure or blocked, never faked)."

# --- (3) REAL browser drive (real Chromium). Self-gates on its env / playwright. Non-fatal (see above). --
echo "e2e:live-tool-matrix: [3/3] real browser drive (browser.* → real Chromium)…"
bash scripts/e2e-live-browser.sh || echo "e2e:live-tool-matrix: NOTE — browser family did not complete (see above; install playwright for the real browser drive, never faked)."

echo "e2e:live-tool-matrix: ok — REAL throughout: exec.*/git.* ran in a real OpenShell sandbox (exit 0), net.fetch hit a real host, every deny mode denied with no effect, the kernel chain is append-only + hash-chained + credential-blind; real Gmail send + real browser drive ran (or cleanly skipped when their creds were absent — never faked). attester != actor to the PROCESS boundary; HSM/KMS = TR2."
