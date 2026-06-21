// Package server implements the kernel's append-only ingest gRPC service. It enforces append-only +
// monotonic per-source sequence and fails closed (typed AppendError + a durable audit record) on
// replay/gap/malformed. It durably commits (fsync, via the store) BEFORE returning a Receipt
// (commit-before-effect at the RPC boundary). It is the in-path enforcement point that makes
// "attester != attested actor" hold: the control plane can only Append, never rewrite.
package server

import (
	"context"
	"encoding/json"
	"sync"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/ingestpb"
	"github.com/agent-os/kernel/internal/store"
)

// AuditSink durably records a denied Append (attest-the-negative: even rejections are recorded).
type AuditSink interface {
	RecordDenial(sourceID string, sequence uint64, code, detail string) error
}

// IngestServer implements ingestpb.AppendServiceServer.
type IngestServer struct {
	ingestpb.UnimplementedAppendServiceServer
	mu      sync.Mutex
	store   *store.Store
	audit   AuditSink
	next    map[string]uint64 // expected next sequence per source (0 if unseen)
	head    string            // current chain head entryHash (genesis if empty)
	headSeq uint64            // source-sequence of the head record (0 if empty log)
}

// NewIngestServer wires the durable store + audit sink, rebuilding per-source next-sequence + head
// from the durable log so a restart cannot silently re-open a gap or accept a replay.
func NewIngestServer(st *store.Store, audit AuditSink) (*IngestServer, error) {
	records, head, err := st.Load()
	if err != nil {
		return nil, err
	}
	next := make(map[string]uint64)
	var headSeq uint64
	for _, r := range records {
		if r.SourceSeq+1 > next[r.SourceID] {
			next[r.SourceID] = r.SourceSeq + 1
		}
		headSeq = r.SourceSeq // head is the last record replayed; its source-sequence is the head sequence
	}
	return &IngestServer{store: st, audit: audit, next: next, head: head, headSeq: headSeq}, nil
}

func (s *IngestServer) deny(req *ingestpb.AppendRequest, code ingestpb.AppendError_Code, detail string) (*ingestpb.AppendResponse, error) {
	// detail is a static reason / field name only — it never echoes canonical_event content.
	// FAIL-CLOSED: a denial is not "recorded" until its durable audit lands; if the audit write fails,
	// return an internal error rather than handing back a typed deny with no audit behind it.
	if err := s.audit.RecordDenial(req.GetSourceId(), req.GetSequence(), code.String(), detail); err != nil {
		return nil, status.Error(codes.Internal, "denial audit write failed")
	}
	return &ingestpb.AppendResponse{Result: &ingestpb.AppendResponse_Error{Error: &ingestpb.AppendError{Code: code, Detail: detail}}}, nil
}

// Append enforces append-only + monotonic per-source sequence; never returns CODE_UNSPECIFIED as a
// result and never rewrites an existing entry.
func (s *IngestServer) Append(_ context.Context, req *ingestpb.AppendRequest) (*ingestpb.AppendResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(req.GetCanonicalEvent()) == 0 || !json.Valid(req.GetCanonicalEvent()) {
		return s.deny(req, ingestpb.AppendError_MALFORMED, "canonical_event is empty or not valid canonical JSON")
	}

	expected := s.next[req.GetSourceId()]
	switch {
	case req.GetSequence() > expected:
		return s.deny(req, ingestpb.AppendError_SEQUENCE_GAP, "sequence ahead of expected next (gap)")
	case req.GetSequence() < expected:
		return s.deny(req, ingestpb.AppendError_SEQUENCE_REPLAY, "sequence already settled; append-only refuses rewrite")
	}

	// accept: hashes are computed from the canonical bytes; the client cannot set them.
	prevHash := s.head
	entryHash := chain.EntryHashFromCanonical(req.GetCanonicalEvent(), prevHash, int(req.GetSequence()))
	contentHash := chain.ContentAddress(req.GetCanonicalEvent())

	var ev any
	_ = json.Unmarshal(req.GetCanonicalEvent(), &ev) // persist the already-redacted event object
	if _, err := s.store.Append(store.LogRecord{
		Sequence: int(req.GetSequence()), Event: ev, PrevHash: prevHash, EntryHash: entryHash,
		SourceID: req.GetSourceId(), SourceSeq: req.GetSequence(),
	}); err != nil {
		// durable commit failed -> do NOT return a Receipt (commit-before-effect). Internal error, not fail-open.
		return nil, status.Error(codes.Internal, "durable commit failed")
	}
	s.head = entryHash
	s.headSeq = req.GetSequence()
	s.next[req.GetSourceId()] = req.GetSequence() + 1
	return &ingestpb.AppendResponse{Result: &ingestpb.AppendResponse_Receipt{Receipt: &ingestpb.Receipt{
		Sequence: req.GetSequence(), ContentHash: contentHash, PrevHash: prevHash, EntryHash: entryHash,
	}}}, nil
}
