package server

import (
	"context"

	"github.com/agent-os/kernel/internal/ingestpb"
	"github.com/agent-os/kernel/internal/partition"
)

// PartitionAppendServer is the PARTITIONED gRPC AppendService adapter (SLICE-ES2a). It implements the
// SAME ingestpb.AppendServiceServer surface as the single-chain IngestServer, but routes every Append
// to a per-tenant chain + signing key by req.partition_id via the existing PartitionedIngest library
// (internal/partition). It is a thin contract adapter: it adds NO new enforcement of its own — the
// append-only / monotonic-per-source / commit-before-effect guarantees all live inside PartitionedIngest.
//
// It does NOT replace or modify the single-chain IngestServer (append.go): Personal's live path keeps
// using NewIngestServer with NO partition_id, byte-identical. A deployment chooses ONE of the two at
// wire time (cmd/kernel main.go: -partitions selects the partitioned adapter; absent => single-chain).
//
// FAIL-CLOSED routing (deny-by-default; the partition value is NEVER echoed in any detail):
//   - empty partition_id      -> typed MALFORMED deny, no write (the partitioned server requires a
//                                tenant; it must NOT silently fall through to a default/first tenant).
//   - unknown partition_id    -> PartitionedIngest.Append returns (nil, err); we translate that to a
//                                typed MALFORMED deny, no write, no default tenant materialized.
//   - known partition_id      -> pass through PartitionedIngest's typed AppendResponse (Receipt on
//                                accept; typed AppendError on intra-tenant malformed/gap/replay).
//
// HONEST LIMITATION (ES2a): per-tenant Ed25519 keys are provisioned in-memory by the operator at wire
// time (see cmd/kernel main.go), so at THIS layer attester==operator. Real per-tenant key provision /
// KMS / root-trust externalization is P4 — NOT solved here.
type PartitionAppendServer struct {
	ingestpb.UnimplementedAppendServiceServer
	pi *partition.PartitionedIngest
}

// NewPartitionAppendServer wraps an already-built PartitionedIngest (the per-tenant {store, signer}
// set is provisioned by the caller). The adapter holds no mutable state of its own — all per-tenant
// state + the append mutex live in PartitionedIngest.
func NewPartitionAppendServer(pi *partition.PartitionedIngest) *PartitionAppendServer {
	return &PartitionAppendServer{pi: pi}
}

// partitionDeny builds a typed fail-closed deny AppendResponse. detail is a STATIC reason only — it
// never echoes canonical_event content, and never leaks the partition_id value (so probing for which
// tenants exist via the error text is impossible).
func partitionDeny(code ingestpb.AppendError_Code, detail string) *ingestpb.AppendResponse {
	return &ingestpb.AppendResponse{Result: &ingestpb.AppendResponse_Error{Error: &ingestpb.AppendError{Code: code, Detail: detail}}}
}

// Append routes by req.partition_id to the per-tenant chain. Empty => deny; unknown (PartitionedIngest
// returns (nil, err)) => deny; known => pass through the typed AppendResponse. It returns a nil
// transport error in the deny cases (the deny is carried IN the AppendResponse, fail-closed) so a
// client cannot distinguish "denied" from a wire fault and retry-loop a write into existence.
func (s *PartitionAppendServer) Append(_ context.Context, req *ingestpb.AppendRequest) (*ingestpb.AppendResponse, error) {
	if req.GetPartitionId() == "" {
		// FAIL-CLOSED: the partitioned server REQUIRES a tenant. Do NOT fall through to a default /
		// first partition. Static detail only — never echo canonical_event.
		return partitionDeny(ingestpb.AppendError_MALFORMED, "partition_id is required"), nil
	}

	resp, err := s.pi.Append(req.GetPartitionId(), req)
	if err != nil {
		// PartitionedIngest fails closed on an UNKNOWN partition (no default tenant materialized) and
		// on a durable-commit failure, returning (nil, err). Translate to a typed deny WITHOUT leaking
		// the partition_id value (no tenant-enumeration oracle).
		return partitionDeny(ingestpb.AppendError_MALFORMED, "append rejected by partition router"), nil
	}
	// Known partition: pass through the typed AppendResponse (Receipt on accept, typed AppendError on
	// intra-tenant malformed/gap/replay).
	return resp, nil
}
