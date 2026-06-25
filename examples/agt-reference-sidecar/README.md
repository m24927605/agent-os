# Reference AGT advisory sidecar

⚠️ **This is a REFERENCE / EXAMPLE, not a production AGT engine.** It implements OUR
`AgtDecision.Evaluate` gRPC-over-UDS contract (`src/runtime/agt/proto/agt_decision.subset.proto`) with a
trivial, transparent policy so the gated `pnpm run e2e:live-agt` can run the **real** transport against a
**real** server and prove the AGT-advisory path end-to-end. A production deployment swaps the policy in
`agt_sidecar.py` for the real Agent Governance Toolkit (Python) engine — **the wire contract stays the same**.

The reference policy: a governance projection carrying a destructive flag (`rm -rf` / `--force` /
`--no-preserve-root`) or a known-destructive `argv0` (rm/dd/mkfs/shred) → **DENY**; everything else →
**ALLOW**. It is credential-blind by construction: the sidecar only ever receives the neutral governance
fields + the already-redacted, bounded `GovernanceProjection` — never raw args/env/stdin.

## One-time setup (grpcio is a heavy binary dep — built on demand, never committed)

```bash
cd examples/agt-reference-sidecar
uv venv --python 3.13 .venv
uv pip install --python ./.venv/bin/python grpcio grpcio-tools
bash gen-stubs.sh            # generates _generated/agt_decision_pb2*.py from the proto
```

## Run the live AGT e2e (against this reference sidecar)

```bash
# 1. start the sidecar (binds the UDS, stays up)
./examples/agt-reference-sidecar/.venv/bin/python \
  ./examples/agt-reference-sidecar/agt_sidecar.py /tmp/agt.sock &

# 2. drive the gated live e2e (the real TS transport -> grpc-js -> UDS -> this sidecar)
AGENTOS_LIVE_AGT=1 AGT_UDS_PATH=/tmp/agt.sock pnpm run e2e:live-agt
#   PASS  benign exec.run -> AGT allow -> ALLOW
#   PASS  destructive exec.run (rm -rf) -> AGT deny -> DENY
#   PASS  AGT allow can NOT relax a PDP deny -> DENY
#   e2e:live-agt: ok — real AGT advisory allow/deny verified against the live sidecar

kill %1   # stop the sidecar
```

Without `AGENTOS_LIVE_AGT` + `AGT_UDS_PATH`, `e2e:live-agt` prints `SKIPPED` and exits 0 (never fake-green);
with them set but no socket listening, it is `BLOCKED` (exit 1).

## Wiring AGT into a real deployment

Put the `agt` section into your `agent-os.config.json` (see `agent-os.config.example.json`):

```json
"agt": { "udsPath": "/tmp/agt.sock", "scope": "effectful", "timeoutMs": 750 }
```

`agentos setup` then writes `AGT_UDS_PATH` / `AGT_SCOPE` / `AGT_TIMEOUT_MS` into the bin's
`mcp_servers.env`; `integrationsFromEnv` (R9b-2b) registers the AGT advisory secondary, so Hermes-driven
effectful tool calls (e.g. `exec.run`) are advised by AGT — with the **PDP still the sole deny authority**
(AGT can only narrow, never grant) and **configured-but-down AGT → deny** (fail-closed). `agentos doctor`
preflights the AGT socket (PASS/FAIL/SKIP).
