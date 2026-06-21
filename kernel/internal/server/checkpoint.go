package server

import (
	"context"

	"github.com/agent-os/kernel/internal/ingestpb"
)

// Checkpoint atomically captures a consistent snapshot anchor under the SAME mutex that serializes
// Append (append.go), so a caller can never observe a torn (half-written) tail: the chain head
// entryHash, the head record's sequence, and the per-source next-sequence map are all read at one
// instant in which no Append is mid-flight (design §41/§60).
//
// READ-ONLY by construction: it acquires the lock, copies the in-memory anchor, releases, and returns.
// It NEVER appends, rewrites, truncates, or mutates s.head / s.headSeq / s.next / the durable store —
// it does not widen the append-only surface (this is the safe replacement for the infeasible
// ftruncate-to-N of design §49 correction 1). Empty log => head_entry_hash is the genesis hash and
// per_source_next_seq is an empty map (fail-safe boundary).
func (s *IngestServer) Checkpoint(_ context.Context, _ *ingestpb.CheckpointRequest) (*ingestpb.CheckpointResponse, error) {
	s.mu.Lock()
	// Copy the per-source map so the returned snapshot cannot be mutated by a later Append racing on
	// s.next after the lock is released. The copy is taken inside the critical section.
	perSource := make(map[string]uint64, len(s.next))
	for src, n := range s.next {
		perSource[src] = n
	}
	head := s.head
	headSeq := s.headSeq
	s.mu.Unlock()

	return &ingestpb.CheckpointResponse{
		HeadEntryHash:    head,
		HeadSequence:     headSeq,
		PerSourceNextSeq: perSource,
	}, nil
}
