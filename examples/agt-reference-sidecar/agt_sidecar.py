#!/usr/bin/env python3
"""Reference AGT advisory sidecar — implements OUR `AgtDecision.Evaluate` UDS contract.

⚠️ THIS IS A REFERENCE / EXAMPLE, NOT a production AGT engine. It exists so the gated
`pnpm run e2e:live-agt` can run the REAL transport against a REAL gRPC-over-UDS server and prove the
AGT-advisory path end-to-end. A production deployment replaces the trivial policy below with the real
Agent Governance Toolkit (Python) engine — the wire contract (agt_decision.subset.proto) stays the same.

The reference policy is deliberately tiny + transparent:
  • a governance projection carrying a destructive flag (rm -rf / --force / --no-preserve-root) OR a
    known-destructive argv0 (rm/dd/mkfs/shred) -> DENY (allowed=False, action="deny");
  • everything else -> ALLOW (allowed=True, action="allow").
This is enough to demonstrate advisory allow AND advisory deny over the real wire. The sidecar is
CREDENTIAL-BLIND by construction: it only ever receives the neutral fields + the (already-redacted,
bounded) GovernanceProjection — never raw args/env/stdin.
"""

from __future__ import annotations

import os
import sys
from concurrent import futures

import grpc

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "_generated"))
import agt_decision_pb2 as pb  # noqa: E402
import agt_decision_pb2_grpc as pb_grpc  # noqa: E402

# Known-destructive argv0 basenames (a HINT, mirrors the projection's best-effort intent).
_DESTRUCTIVE_CMDS = {"rm", "dd", "mkfs", "shred", "rmdir"}


class AgtDecisionServicer(pb_grpc.AgtDecisionServicer):
    def Evaluate(self, request: pb.AgtEvaluateRequest, context) -> pb.AgtEvaluateResponse:
        proj = request.governance_projection if request.HasField("governance_projection") else None

        # No projection -> evaluate on neutral fields alone; the reference engine abstains to allow.
        if proj is None:
            return pb.AgtEvaluateResponse(
                allowed=True, action="allow", matched_rule="ref:no-projection-allow",
                reason="reference AGT: no projection, neutral allow",
            )

        argv0_base = os.path.basename(proj.argv0) if proj.argv0 else ""
        if list(proj.destructive_flags):
            flags = ",".join(proj.destructive_flags)
            return pb.AgtEvaluateResponse(
                allowed=False, action="deny", matched_rule="ref:no-destructive-flags",
                reason=f"reference AGT: destructive flag(s) present: {flags}",
            )
        if argv0_base in _DESTRUCTIVE_CMDS:
            return pb.AgtEvaluateResponse(
                allowed=False, action="deny", matched_rule="ref:no-destructive-cmd",
                reason=f"reference AGT: destructive command: {argv0_base}",
            )

        return pb.AgtEvaluateResponse(
            allowed=True, action="allow", matched_rule="ref:default-allow",
            reason=f"reference AGT: allow {proj.operation_class}/{argv0_base or '?'}",
        )


def serve(uds_path: str) -> None:
    # Fresh socket each run (a stale socket file would make bind fail).
    if os.path.exists(uds_path):
        os.unlink(uds_path)
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    pb_grpc.add_AgtDecisionServicer_to_server(AgtDecisionServicer(), server)
    server.add_insecure_port(f"unix://{uds_path}")
    server.start()
    # CREDENTIAL-BLIND log: announce readiness without echoing anything sensitive.
    print(f"agt-reference-sidecar: listening on unix://{uds_path}", flush=True)
    server.wait_for_termination()


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("AGT_UDS_PATH", "")
    if not path:
        print("usage: agt_sidecar.py <uds-path>  (or set AGT_UDS_PATH)", file=sys.stderr)
        sys.exit(2)
    serve(path)
