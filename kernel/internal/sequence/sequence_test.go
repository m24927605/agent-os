package sequence

import (
	"errors"
	"testing"

	"github.com/agent-os/kernel/internal/store"
)

func TestMonotonicHappyPath(t *testing.T) {
	tr := NewTracker()
	for _, s := range []uint64{0, 1, 2} {
		if err := tr.Admit("src-a", s); err != nil {
			t.Fatalf("admit src-a %d: %v", s, err)
		}
	}
	if err := tr.Admit("src-b", 0); err != nil { // independent source starts at 0
		t.Fatalf("src-b 0: %v", err)
	}
}

func TestGapDetected(t *testing.T) {
	tr := NewTracker()
	_ = tr.Admit("src-a", 0)
	if err := tr.Admit("src-a", 2); !errors.Is(err, ErrSequenceGap) {
		t.Fatalf("dropping seq 1: want ErrSequenceGap, got %v", err)
	}
	if err := tr.Admit("src-a", 1); err != nil { // gap must NOT advance lastSeq
		t.Fatalf("after gap, seq 1 should be admitted: %v", err)
	}
}

func TestFirstSeenNonZeroIsGap(t *testing.T) {
	tr := NewTracker()
	if err := tr.Admit("src-new", 1); !errors.Is(err, ErrSequenceGap) {
		t.Fatalf("first-seen seq 1 (non-0) must be ErrSequenceGap, got %v", err)
	}
}

func TestRegressionRejected(t *testing.T) {
	tr := NewTracker()
	for _, s := range []uint64{0, 1, 2} {
		_ = tr.Admit("src-a", s)
	}
	if err := tr.Admit("src-a", 1); !errors.Is(err, ErrSequenceRegression) {
		t.Fatalf("replay older: want ErrSequenceRegression, got %v", err)
	}
	if err := tr.Admit("src-a", 2); !errors.Is(err, ErrSequenceRegression) {
		t.Fatalf("duplicate head: want ErrSequenceRegression, got %v", err)
	}
}

func TestRebuildFromDurable(t *testing.T) {
	recs := []store.LogRecord{
		{SourceID: "src-a", SourceSeq: 0},
		{SourceID: "src-a", SourceSeq: 1},
		{SourceID: "src-a", SourceSeq: 2},
	}
	tr := NewTracker()
	if err := tr.Rebuild(recs); err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	if err := tr.Admit("src-a", 2); !errors.Is(err, ErrSequenceRegression) {
		t.Fatalf("after rebuild (lastSeq=2), admit 2 should regress, got %v", err)
	}
	if err := tr.Admit("src-a", 4); !errors.Is(err, ErrSequenceGap) {
		t.Fatalf("after rebuild, admit 4 should gap, got %v", err)
	}
	if err := tr.Admit("src-a", 3); err != nil {
		t.Fatalf("after rebuild, admit 3 should pass: %v", err)
	}
}
