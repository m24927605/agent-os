package outbox

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/agent-os/kernel/internal/canonical"
	"github.com/agent-os/kernel/internal/sequence"
)

// kernelSink is the test's at-least-once delivery target backed by the real P1-S4 Tracker: a
// duplicate sourceSeq would surface as ErrSequenceRegression, proving "kernel never sees a dup".
type kernelSink struct {
	tracker   *sequence.Tracker
	delivered []Record
}

func (k *kernelSink) Deliver(rec Record) error {
	if err := k.tracker.Admit(rec.SourceID, rec.Sequence); err != nil {
		return err
	}
	k.delivered = append(k.delivered, rec)
	return nil
}

func mustOpen(t *testing.T, path string) *Outbox {
	t.Helper()
	o, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return o
}

func TestPerSourceMonotonicSequence(t *testing.T) {
	o := mustOpen(t, filepath.Join(t.TempDir(), "ob.log"))
	for i := 0; i < 3; i++ {
		r, err := o.Enqueue(RecordInput{SourceID: "src-a", ContentHash: "sha256:a", CanonicalBytes: []byte("{}")})
		if err != nil {
			t.Fatalf("enqueue: %v", err)
		}
		if r.Sequence != uint64(i) || !r.Durable {
			t.Fatalf("seq=%d durable=%v want %d/true", r.Sequence, r.Durable, i)
		}
	}
	// independent source restarts at 0
	if r, _ := o.Enqueue(RecordInput{SourceID: "src-b", ContentHash: "sha256:b", CanonicalBytes: []byte("{}")}); r.Sequence != 0 {
		t.Fatalf("src-b first seq=%d want 0", r.Sequence)
	}
}

func TestConcurrentEnqueueNoDuplicateSeq(t *testing.T) {
	o := mustOpen(t, filepath.Join(t.TempDir(), "ob.log"))
	var wg sync.WaitGroup
	seqs := make([]uint64, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r, err := o.Enqueue(RecordInput{SourceID: "src-a", ContentHash: "sha256:a", CanonicalBytes: []byte("{}")})
			if err == nil {
				seqs[i] = r.Sequence
			}
		}(i)
	}
	wg.Wait()
	seen := map[uint64]bool{}
	for _, s := range seqs {
		if seen[s] {
			t.Fatalf("duplicate sequence %d under concurrency", s)
		}
		seen[s] = true
	}
}

func TestCrashCommittedButNotDeliveredResumesOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ob.log")
	o := mustOpen(t, path)
	for i := 0; i < 3; i++ {
		if _, err := o.Enqueue(RecordInput{SourceID: "src-a", ContentHash: "sha256:h", CanonicalBytes: []byte("{}")}); err != nil {
			t.Fatalf("enqueue: %v", err)
		}
	}
	_ = o.Close() // simulate crash: committed (fsync'd) but NEVER delivered

	// resume: reopen from the same durable file
	o2 := mustOpen(t, path)
	sink := &kernelSink{tracker: sequence.NewTracker()}
	if err := o2.Deliver(sink); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if len(sink.delivered) != 3 {
		t.Fatalf("delivered %d want 3 (events conserved)", len(sink.delivered))
	}
	// deliver again: all marked delivered -> no-op, kernel never sees a duplicate sourceSeq
	if err := o2.Deliver(sink); err != nil {
		t.Fatalf("re-deliver: %v", err)
	}
	if len(sink.delivered) != 3 {
		t.Fatalf("re-deliver appended duplicates: delivered=%d want 3", len(sink.delivered))
	}

	// even a fresh resume (new Outbox) re-reads the durable delivered-set -> still no-op
	o3 := mustOpen(t, path)
	if err := o3.Deliver(sink); err != nil {
		t.Fatalf("deliver after 2nd resume: %v", err)
	}
	if len(sink.delivered) != 3 {
		t.Fatalf("delivered-set not durable: delivered=%d want 3", len(sink.delivered))
	}
}

func TestDedupContentConflict(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ob.log")
	o := mustOpen(t, path)
	r, _ := o.Enqueue(RecordInput{SourceID: "src-a", ContentHash: "sha256:h", CanonicalBytes: []byte("{}")})
	_ = o.Deliver(&kernelSink{tracker: sequence.NewTracker()})

	// same (sourceId, seq) + same hash -> already delivered (no-op)
	already, err := o.CheckDedup(r.SourceID, r.Sequence, "sha256:h")
	if err != nil || !already {
		t.Fatalf("same-hash redelivery want (true,nil), got (%v,%v)", already, err)
	}
	// same (sourceId, seq) + DIFFERENT hash -> conflict (fail-closed, no overwrite)
	if _, err := o.CheckDedup(r.SourceID, r.Sequence, "sha256:DIFFERENT"); !errors.Is(err, ErrContentConflict) {
		t.Fatalf("diff-hash want ErrContentConflict, got %v", err)
	}
}

func TestPersistedEvidenceRedacted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ob.log")
	o := mustOpen(t, path)
	canary := "sk-" + strings.Repeat("a", 40)
	cb, err := canonical.CanonicalBytes(map[string]any{"apiKey": canary, "resource": "/x/" + canary})
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	if _, err := o.Enqueue(RecordInput{SourceID: "s", ContentHash: "sha256:h", CanonicalBytes: cb}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	_ = o.Close()
	rawb, _ := os.ReadFile(path)
	raw := string(rawb)
	if strings.Contains(raw, canary) {
		t.Fatalf("canary leaked into outbox durable file")
	}
	if !strings.Contains(raw, "[REDACTED]") {
		t.Fatalf("expected [REDACTED] in outbox file")
	}
}
