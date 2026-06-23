package server

import (
	"context"
	"crypto/x509"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/agent-os/kernel/internal/canonical"
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

// Checkpoint produces the SIGNED read-back anchor for ONE tenant: it signs that tenant's chain head
// with that tenant's OWN Ed25519 key and exposes the signature + that tenant's public key (SPKI/PKIX
// DER), so each Enterprise tenant can be verified INDEPENDENTLY — a's checkpoint verifies only under
// a's key (chain.VerifyCheckpoint), and is rejected under b's key (per-tenant attester isolation).
//
// FAIL-CLOSED routing (deny-by-default; the partition value is NEVER echoed in the deny detail, so the
// error text is not a tenant-enumeration oracle):
//   - empty partition_id   -> InvalidArgument (the partitioned server REQUIRES a tenant; it must NOT
//                             fall through to a default/first tenant).
//   - unknown partition_id -> PartitionedIngest returns (·, err); translate to InvalidArgument with a
//                             STATIC detail (no partition_id value), no default tenant materialized.
// It returns an ERROR (not a typed AppendError) on deny, matching the single-chain Checkpoint
// (checkpoint.go) which has no error oneof — a CheckpointResponse is only ever returned on success.
func (s *PartitionAppendServer) Checkpoint(_ context.Context, req *ingestpb.CheckpointRequest) (*ingestpb.CheckpointResponse, error) {
	if req.GetPartitionId() == "" {
		// FAIL-CLOSED: no default/first tenant. Static detail — never echo a partition_id value.
		return nil, status.Error(codes.InvalidArgument, "partition_id is required")
	}
	cp, err := s.pi.Checkpoint(req.GetPartitionId())
	if err != nil {
		// Unknown partition (no default tenant materialized). Translate WITHOUT leaking the partition_id
		// value (no tenant-enumeration oracle) — static detail, same discipline as Append.
		return nil, status.Error(codes.InvalidArgument, "checkpoint rejected by partition router")
	}
	pub, err := s.pi.PublicKey(req.GetPartitionId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "checkpoint rejected by partition router")
	}
	derPub, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		// Cannot expose a usable public key -> fail closed (the signature would be unverifiable).
		return nil, status.Error(codes.Internal, "marshal partition public key failed")
	}
	// Load-bearing fields: head_entry_hash + checkpoint_signature + public_key. (head_sequence /
	// per_source_next_seq are not exposed by the per-partition Checkpoint and stay zero/empty here.)
	return &ingestpb.CheckpointResponse{
		HeadEntryHash:       cp.HeadEntryHash,
		CheckpointSignature: cp.Signature,
		PublicKey:           derPub,
	}, nil
}

// ListEntries returns ONE tenant's WORM chain read-back (records with chain sequence >= from_sequence),
// re-deriving canonical_event from each stored (already-redacted) event via the SAME canonical function
// the chain used to seal it, so a client's EntryHashFromCanonical(canonical_event, prev_hash, sequence)
// reproduces entry_hash byte-for-byte (mirrors the single-chain list.go). It reads ONLY the routed
// tenant's store — never another tenant's.
//
// FAIL-CLOSED routing (same discipline as Append/Checkpoint; the partition value is never echoed):
//   - empty partition_id   -> InvalidArgument (no default/first tenant).
//   - unknown partition_id -> InvalidArgument (no default tenant materialized).
// FAIL-CLOSED read: a torn/unreadable durable log surfaces as Internal — NEVER a partial slice.
func (s *PartitionAppendServer) ListEntries(_ context.Context, req *ingestpb.ListEntriesRequest) (*ingestpb.ListEntriesResponse, error) {
	if req.GetPartitionId() == "" {
		return nil, status.Error(codes.InvalidArgument, "partition_id is required")
	}
	records, err := s.pi.ListEntries(req.GetPartitionId(), req.GetFromSequence())
	if err != nil {
		// Unknown partition OR a durable read failure inside the routed tenant. Static detail — never
		// leak the partition_id value. (Both map to a deny; a client cannot tell them apart.)
		return nil, status.Error(codes.InvalidArgument, "listentries rejected by partition router")
	}
	entries := make([]*ingestpb.Entry, 0, len(records))
	for _, r := range records {
		// Re-canonicalize from the stored (already-redacted) event via the SAME function the chain used
		// to seal it, so canonical_event round-trips to entry_hash. Fail closed if it cannot round-trip.
		cb, cerr := canonical.CanonicalBytes(r.Event)
		if cerr != nil {
			return nil, status.Error(codes.Internal, "stored event is not re-canonicalizable")
		}
		entries = append(entries, &ingestpb.Entry{
			Sequence:       uint64(r.Sequence),
			CanonicalEvent: cb,
			PrevHash:       r.PrevHash,
			EntryHash:      r.EntryHash,
		})
	}
	return &ingestpb.ListEntriesResponse{Entries: entries}, nil
}
