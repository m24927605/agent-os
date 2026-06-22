package server

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/agent-os/kernel/internal/canonical"
	"github.com/agent-os/kernel/internal/ingestpb"
)

// ListEntries is READ-ONLY: it captures a consistent snapshot of the durable WORM chain and returns the
// entries with sequence >= from_sequence so a client can re-derive entryHash and verify integrity.
//
// READING != ATTESTING (attester != actor): it acquires the SAME mutex that serializes Append (so it
// cannot observe a torn, half-written tail mid-Append), reads via store.Load (the existing fail-closed
// replay), then releases — it NEVER appends, rewrites, truncates, or mutates s.head / s.headSeq / s.next
// / the durable store. It does not widen the append-only surface (the surface_test allowlist marks it
// read-only).
//
// FAIL-CLOSED: a durable read failure (e.g. a torn tail) returns codes.Internal — NEVER a partial slice.
// Returning half a chain is worse than erroring: a client must not mistake a truncated read for the
// whole WORM log. The error detail is a static reason; it never echoes stored event content.
//
// CANONICAL ROUND-TRIP (the load-bearing invariant): canonical_event is re-derived from the stored
// (already-redacted, json-Unmarshal'd) Event via canonical.CanonicalBytes — the SAME function the chain
// used to seal the entry (chain.ComputeEntryHash = canonical.CanonicalBytes then frame+sha256). So
// chain.EntryHashFromCanonical(entry.canonical_event, entry.prev_hash, entry.sequence) reproduces
// entry.entry_hash byte-for-byte. If re-canonicalization could not reproduce the stored entry_hash, this
// method returns Internal rather than handing back an entry whose canonical_event fails to round-trip.
func (s *IngestServer) ListEntries(_ context.Context, req *ingestpb.ListEntriesRequest) (*ingestpb.ListEntriesResponse, error) {
	s.mu.Lock()
	// Consistent snapshot under the append mutex; read-all then release. No mutation of any field.
	records, _, err := s.store.Load()
	s.mu.Unlock()
	if err != nil {
		// Fail-closed: a torn/unreadable durable log is an Internal error, NEVER a partial result. The
		// detail is a static reason — it never echoes record/event content.
		return nil, status.Error(codes.Internal, "durable log read failed")
	}

	entries := make([]*ingestpb.Entry, 0, len(records))
	for _, r := range records {
		// Use the LEAF chain sequence (r.Sequence) — the value that was actually framed into entry_hash
		// (append.go) — for BOTH the from_sequence filter and Entry.sequence, so a client's
		// EntryHashFromCanonical(canonical_event, prev_hash, sequence) reproduces entry_hash. r.SourceSeq is
		// per-source ingest metadata, NOT the hashed leaf (they coincide on the current write path but must
		// not be assumed equal here — see R11/PV-S3a review).
		if uint64(r.Sequence) < req.GetFromSequence() {
			continue
		}
		// Re-derive the canonical bytes from the stored (already-redacted) event via the SAME canonical
		// function the chain used to seal it, so the bytes are byte-identical to what was hashed.
		cb, cerr := canonical.CanonicalBytes(r.Event)
		if cerr != nil {
			// Stored event is not re-canonicalizable -> we cannot guarantee the round-trip. Fail closed
			// rather than return an entry whose canonical_event would not reproduce its entry_hash.
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
