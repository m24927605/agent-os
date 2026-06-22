package server

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/ingestpb"
	"github.com/agent-os/kernel/internal/store"
)

// appendN appends n events through the SERVER (not the store directly) so the returned entries are
// exactly what the WORM write path produced: prev/entry hashes computed from the wire canonical bytes.
func appendN(t *testing.T, srv *IngestServer, n int) []*ingestpb.Receipt {
	t.Helper()
	recs := make([]*ingestpb.Receipt, 0, n)
	for i := 0; i < n; i++ {
		resp, err := srv.Append(context.Background(), appendReq("S", uint64(i), `{"action":"x","i":`+itoa(uint64(i))+`}`))
		if err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
		r := resp.GetReceipt()
		if r == nil {
			t.Fatalf("append %d: expected receipt, got %v", i, resp.GetError())
		}
		recs = append(recs, r)
	}
	return recs
}

// TestListEntriesReturnsChainAndRoundTrips is the load-bearing invariant of this slice: ListEntries(0)
// returns every entry with sequence/prev_hash/entry_hash matching the appended chain, AND the returned
// canonical_event RE-canonicalizes to reproduce the stored entry_hash (canonical round-trip). If
// re-canonicalizing the stored (json-Unmarshal'd) Event were lossy, this would go RED.
func TestListEntriesReturnsChainAndRoundTrips(t *testing.T) {
	srv, _ := newTestServer(t)
	receipts := appendN(t, srv, 3)

	resp, err := srv.ListEntries(context.Background(), &ingestpb.ListEntriesRequest{FromSequence: 0})
	if err != nil {
		t.Fatalf("ListEntries(0): %v", err)
	}
	entries := resp.GetEntries()
	if len(entries) != 3 {
		t.Fatalf("ListEntries(0) want 3 entries, got %d", len(entries))
	}
	for i, e := range entries {
		if e.GetSequence() != uint64(i) {
			t.Fatalf("entry %d: sequence = %d, want %d", i, e.GetSequence(), i)
		}
		if e.GetPrevHash() != receipts[i].GetPrevHash() {
			t.Fatalf("entry %d: prev_hash = %s, want %s", i, e.GetPrevHash(), receipts[i].GetPrevHash())
		}
		if e.GetEntryHash() != receipts[i].GetEntryHash() {
			t.Fatalf("entry %d: entry_hash = %s, want %s", i, e.GetEntryHash(), receipts[i].GetEntryHash())
		}
		if len(e.GetCanonicalEvent()) == 0 {
			t.Fatalf("entry %d: canonical_event is empty", i)
		}
		// CANONICAL ROUND-TRIP (make-or-break): recompute entryHash from the RETURNED canonical_event
		// and assert it reproduces the stored entry_hash. This is the same frame+sha256 the WORM chain
		// used to seal the entry — byte-identity of canonical bytes is the invariant under test.
		recomputed := chain.EntryHashFromCanonical(e.GetCanonicalEvent(), e.GetPrevHash(), int(e.GetSequence()))
		if recomputed != e.GetEntryHash() {
			t.Fatalf("entry %d: canonical round-trip FAILED: EntryHashFromCanonical(canonical_event, prev, seq) = %s, stored entry_hash = %s", i, recomputed, e.GetEntryHash())
		}
	}
}

// TestListEntriesFiltersFromSequence: from_sequence=2 returns only the tail (seq >= 2), and the tail's
// canonical round-trip still holds (entries are not corrupted by filtering).
func TestListEntriesFiltersFromSequence(t *testing.T) {
	srv, _ := newTestServer(t)
	appendN(t, srv, 3)

	resp, err := srv.ListEntries(context.Background(), &ingestpb.ListEntriesRequest{FromSequence: 2})
	if err != nil {
		t.Fatalf("ListEntries(2): %v", err)
	}
	entries := resp.GetEntries()
	if len(entries) != 1 {
		t.Fatalf("ListEntries(2) want 1 entry (seq>=2), got %d", len(entries))
	}
	if entries[0].GetSequence() != 2 {
		t.Fatalf("tail entry sequence = %d, want 2", entries[0].GetSequence())
	}
	if got := chain.EntryHashFromCanonical(entries[0].GetCanonicalEvent(), entries[0].GetPrevHash(), int(entries[0].GetSequence())); got != entries[0].GetEntryHash() {
		t.Fatalf("tail canonical round-trip FAILED: %s != %s", got, entries[0].GetEntryHash())
	}
}

// TestListEntriesEmptyLog: a fresh (empty) WORM log returns 0 entries, never an error.
func TestListEntriesEmptyLog(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := srv.ListEntries(context.Background(), &ingestpb.ListEntriesRequest{FromSequence: 0})
	if err != nil {
		t.Fatalf("ListEntries on empty log: %v", err)
	}
	if n := len(resp.GetEntries()); n != 0 {
		t.Fatalf("empty log want 0 entries, got %d", n)
	}
}

// TestListEntriesTornStoreReturnsInternalNotPartial: if the durable Load fails (torn tail), ListEntries
// must return codes.Internal and NEVER a partial slice (fail-closed; reading half a chain is worse than
// erroring). We corrupt the WAL after appends to force Load() to fail.
func TestListEntriesTornStoreReturnsInternalNotPartial(t *testing.T) {
	path := filepath.Join(t.TempDir(), "k.wal")
	st, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	srv, err := NewIngestServer(st, &auditSpy{})
	if err != nil {
		t.Fatal(err)
	}
	appendN(t, srv, 2)

	// Append a stray partial length-prefix to tear the tail (store.Load fails closed on this).
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte{0, 0, 0}); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	resp, err := srv.ListEntries(context.Background(), &ingestpb.ListEntriesRequest{FromSequence: 0})
	if err == nil || status.Code(err) != codes.Internal {
		t.Fatalf("torn store must fail closed with codes.Internal, got resp=%v err=%v", resp, err)
	}
	if resp != nil {
		t.Fatalf("torn store must NOT return a partial response, got %v", resp)
	}
	// sanity: the error must not echo any stored canonical content (no secret/content leak in the error)
	if strings.Contains(status.Convert(err).Message(), "action") {
		t.Fatalf("Internal error message must not echo entry content: %s", status.Convert(err).Message())
	}
}
