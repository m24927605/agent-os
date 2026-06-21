package server

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/agent-os/kernel/internal/ingestpb"
)

// genesisHash mirrors the empty-log head the store reports (sha256: + 64 zero-hex).
const genesisHash = "sha256:" + "0000000000000000000000000000000000000000000000000000000000000000"

// Checkpoint must return an anchor consistent with the post-append state: head_entry_hash == s.head
// and per_source_next_seq[src] == N after N appends from sequence 0.
func TestCheckpointReturnsConsistentAnchor(t *testing.T) {
	srv, _ := newTestServer(t)
	var lastHead string
	const n = uint64(4)
	for i := uint64(0); i < n; i++ {
		resp, err := srv.Append(context.Background(), appendReq("S", i, `{"i":`+itoa(i)+`}`))
		if err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
		lastHead = resp.GetReceipt().EntryHash
	}

	cp, err := srv.Checkpoint(context.Background(), &ingestpb.CheckpointRequest{})
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	if cp.GetHeadEntryHash() != lastHead {
		t.Fatalf("head_entry_hash %q != current head %q", cp.GetHeadEntryHash(), lastHead)
	}
	if cp.GetHeadSequence() != n-1 {
		t.Fatalf("head_sequence %d != last appended sequence %d", cp.GetHeadSequence(), n-1)
	}
	if got := cp.GetPerSourceNextSeq()["S"]; got != n {
		t.Fatalf("per_source_next_seq[S] %d != N %d", got, n)
	}
}

// Read-only invariant (adversarial): Checkpoint must not mutate s.head / s.next, and must not write
// to the durable store (file size unchanged, record count unchanged, head unchanged).
func TestCheckpointIsReadOnly(t *testing.T) {
	srv, _ := newTestServer(t)
	for i := uint64(0); i < 3; i++ {
		if _, err := srv.Append(context.Background(), appendReq("S", i, `{}`)); err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}
	beforeRecs, beforeHead, err := srv.store.Load()
	if err != nil {
		t.Fatal(err)
	}
	beforeHeadField := srv.head
	beforeNext := srv.next["S"]

	if _, err := srv.Checkpoint(context.Background(), &ingestpb.CheckpointRequest{}); err != nil {
		t.Fatalf("checkpoint: %v", err)
	}

	afterRecs, afterHead, err := srv.store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(beforeRecs) != len(afterRecs) {
		t.Fatalf("Checkpoint changed durable record count: %d -> %d", len(beforeRecs), len(afterRecs))
	}
	if beforeHead != afterHead {
		t.Fatalf("Checkpoint changed durable head: %q -> %q", beforeHead, afterHead)
	}
	if srv.head != beforeHeadField {
		t.Fatalf("Checkpoint mutated s.head: %q -> %q", beforeHeadField, srv.head)
	}
	if srv.next["S"] != beforeNext {
		t.Fatalf("Checkpoint mutated s.next: %d -> %d", beforeNext, srv.next["S"])
	}
}

// Atomicity (adversarial): concurrent Append + Checkpoint under -race must not produce a torn read —
// the returned head_sequence and per_source_next_seq must be self-consistent (next == headSeq+1) and
// the data race detector must stay quiet (the append mutex is load-bearing).
func TestCheckpointAtomicUnderConcurrentAppend(t *testing.T) {
	srv, _ := newTestServer(t)
	var wg sync.WaitGroup
	const total = uint64(200)

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := uint64(0); i < total; i++ {
			if _, err := srv.Append(context.Background(), appendReq("S", i, `{}`)); err != nil {
				t.Errorf("append %d: %v", i, err)
				return
			}
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 400; i++ {
			cp, err := srv.Checkpoint(context.Background(), &ingestpb.CheckpointRequest{})
			if err != nil {
				t.Errorf("checkpoint: %v", err)
				return
			}
			next, seen := cp.GetPerSourceNextSeq()["S"]
			if !seen {
				// no appends observed yet -> head must be genesis, head_sequence 0
				if cp.GetHeadEntryHash() != genesisHash {
					t.Errorf("empty-observed checkpoint head %q != genesis", cp.GetHeadEntryHash())
					return
				}
				continue
			}
			// self-consistency: next sequence is exactly one past the head sequence captured atomically.
			if next != cp.GetHeadSequence()+1 {
				t.Errorf("torn read: per_source_next_seq[S]=%d but head_sequence=%d (want next=head+1)", next, cp.GetHeadSequence())
				return
			}
		}
	}()

	wg.Wait()
}

// Empty log fail-safe boundary: head_entry_hash == genesis, per_source_next_seq is empty.
func TestCheckpointEmptyLogIsGenesis(t *testing.T) {
	srv, _ := newTestServer(t)
	cp, err := srv.Checkpoint(context.Background(), &ingestpb.CheckpointRequest{})
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	if cp.GetHeadEntryHash() != genesisHash {
		t.Fatalf("empty log head %q != genesis %q", cp.GetHeadEntryHash(), genesisHash)
	}
	if cp.GetHeadSequence() != 0 {
		t.Fatalf("empty log head_sequence %d != 0", cp.GetHeadSequence())
	}
	if n := len(cp.GetPerSourceNextSeq()); n != 0 {
		t.Fatalf("empty log per_source_next_seq must be empty, got %d entries", n)
	}
	if !strings.HasPrefix(cp.GetHeadEntryHash(), "sha256:") {
		t.Fatalf("head_entry_hash must be sha256:-prefixed: %q", cp.GetHeadEntryHash())
	}
}
