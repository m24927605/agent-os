#!/usr/bin/env bash
# Regenerate the Python gRPC stubs for the reference AGT sidecar from OUR contract proto.
#   in  : src/runtime/agt/proto/agt_decision.subset.proto   (the AgtDecision.Evaluate contract)
#   out : examples/agt-reference-sidecar/_generated/agt_decision_pb2.py + _pb2_grpc.py
#
# protoc dislikes the dotted source filename, so we copy it to a dot-free name first (the wire
# contract — package/service/message names + field numbers — is unchanged by the filename).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PY="$HERE/.venv/bin/python"

[ -x "$PY" ] || { echo "FAIL: $PY missing — run: uv venv --python 3.13 $HERE/.venv && uv pip install --python $PY grpcio grpcio-tools" >&2; exit 1; }

rm -rf "$HERE/_generated" && mkdir -p "$HERE/_generated"
cp "$ROOT/src/runtime/agt/proto/agt_decision.subset.proto" "$HERE/_generated/agt_decision.proto"
( cd "$HERE/_generated" && "$PY" -m grpc_tools.protoc -I . --python_out=. --grpc_python_out=. agt_decision.proto )
echo "ok — stubs in $HERE/_generated (agt_decision_pb2.py + agt_decision_pb2_grpc.py)"
