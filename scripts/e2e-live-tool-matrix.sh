#!/usr/bin/env bash
# e2e:live-tool-matrix — RUN the REAL approve/deny matrix for the governed exec MCP tools against a REAL
# OpenShell sandbox + a FRESH REAL Go kernel WORM partition. For EACH in-sandbox exec/git tool it proves an
# APPROVE path (real exec, exit 0, commit-before-effect); and it proves every DENY MODE — screen
# (credential-blind), cost (fail-closed), egress (net.fetch host not on allowlist), approval (git.push),
# and deny-by-default (unadvertised tool) — plus a kernel readback that the chain is append-only,
# hash-chained, and credential-blind. NO LLM, NO model credits (drives server.handle directly).
#
# Honest boundary: attester != actor holds to the PROCESS boundary (TR1) — the kernel's signing key is
# in-process/operator-held; HSM/KMS/remote-attestation is TR2/deployment, not proven here.
#
# Deliberately NOT part of `pnpm run verify` (it spawns a kernel + needs a live OpenShell gateway); opt-in.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

# --- Preflight gates: a missing prerequisite is a CLEAN block (exit 0), never a hang/hard failure. -------
if [ "${AGENTOS_LIVE_OPENSHELL:-}" != "1" ]; then
  echo "e2e:live-tool-matrix: BLOCKED — set AGENTOS_LIVE_OPENSHELL=1 (real OpenShell sandbox side effects)."
  exit 0
fi
if ! command -v openshell >/dev/null 2>&1; then
  echo "e2e:live-tool-matrix: BLOCKED — openshell CLI not found on PATH (install + run the gateway)."
  exit 0
fi

# Non-secret OpenShell wiring (overridable); defaults mirror the live capstone.
export AGENTOS_OPENSHELL_ENDPOINT="${AGENTOS_OPENSHELL_ENDPOINT:-127.0.0.1:17670}"
export AGENTOS_OPENSHELL_MTLS="${AGENTOS_OPENSHELL_MTLS:-$HOME/.config/openshell/gateways/openshell/mtls}"

# --- Build + spawn a FRESH Go kernel (a fresh partition so the append-only chain has no settled history). -
TMP="$(mktemp -d -t agentos-tool-matrix.XXXXXX)"
PORT="${AGENTOS_TOOL_MATRIX_PORT:-7798}"
trap 'kill "${KPID:-0}" 2>/dev/null; rm -rf "$TMP"' EXIT

echo "e2e:live-tool-matrix: building the kernel..."
( cd "$ROOT/kernel" && env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local go build -o "$TMP/kernel" ./cmd/kernel ) \
  || { echo "e2e:live-tool-matrix: FAIL — kernel build" >&2; exit 1; }

echo "e2e:live-tool-matrix: starting the kernel on 127.0.0.1:$PORT ..."
"$TMP/kernel" --addr "127.0.0.1:$PORT" --chain "$TMP/chain.jsonl" --audit "$TMP/audit.jsonl" >"$TMP/kernel.log" 2>&1 &
KPID=$!
ready=0
for _ in $(seq 1 40); do
  kill -0 "$KPID" 2>/dev/null || { echo "e2e:live-tool-matrix: FAIL — kernel exited early:" >&2; cat "$TMP/kernel.log" >&2; exit 1; }
  grep -q "listening" "$TMP/kernel.log" 2>/dev/null && { ready=1; break; }
  sleep 0.25
done
[ "$ready" = 1 ] || { echo "e2e:live-tool-matrix: FAIL — kernel not ready" >&2; cat "$TMP/kernel.log" >&2; exit 1; }

# --- Drive the REAL matrix (gated vitest live spec). -----------------------------------------------------
export AGENTOS_LIVE_KERNEL_ENDPOINT="127.0.0.1:$PORT"
export AGENTOS_KERNEL_INGEST_ENDPOINT="127.0.0.1:$PORT"
if pnpm exec vitest run src/runtime/brain/adapters/hermes/mcp/exec-mcp-matrix.live.test.ts; then
  echo "e2e:live-tool-matrix: ok — every in-sandbox exec/git tool APPROVED (real OpenShell exec, exit 0, commit-before-effect); screen/cost/egress/approval/deny-by-default DENIED with no effect; kernel chain append-only + hash-chained + credential-blind. (attester != actor to the PROCESS boundary; HSM/KMS = TR2.)"
else
  echo "e2e:live-tool-matrix: FAIL — see the vitest output above" >&2
  exit 1
fi
