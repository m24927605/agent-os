// Package sequence enforces per-source ingest completeness: each sourceId must deliver a contiguous,
// 0-based, monotonically increasing sourceSeq. A missing record (gap) or a stale/duplicate
// (regression/replay) is rejected with a named error — fail-closed, never silently accepted. The
// per-source state is reconstructable from the durable log (Rebuild), so a crash/restart cannot
// silently re-open a gap. It depends on internal/store only for the record TYPE (one direction;
// store must not import sequence — depguard enforces it).
package sequence

import (
	"errors"
	"fmt"

	"github.com/agent-os/kernel/internal/store"
)

// ErrSequenceGap means one or more records before this sourceSeq are missing.
var ErrSequenceGap = errors.New("sequence gap: missing record(s) before this sourceSeq")

// ErrSequenceRegression means this sourceSeq is stale or duplicate (a replay).
var ErrSequenceRegression = errors.New("sequence regression: stale or duplicate sourceSeq")

// Tracker holds per-source last-admitted sequence. The zero value is not usable; use NewTracker.
type Tracker struct {
	lastSeq map[string]uint64
}

// NewTracker returns an empty Tracker.
func NewTracker() *Tracker {
	return &Tracker{lastSeq: make(map[string]uint64)}
}

// Admit enforces sourceSeq == expected, where expected is 0 for a first-seen source else lastSeq+1.
// On success it advances lastSeq; a gap/regression returns a named error WITHOUT advancing.
func (t *Tracker) Admit(sourceID string, sourceSeq uint64) error {
	last, seen := t.lastSeq[sourceID]
	var expected uint64
	if seen {
		expected = last + 1
	}
	switch {
	case sourceSeq == expected:
		t.lastSeq[sourceID] = sourceSeq
		return nil
	case sourceSeq > expected:
		return ErrSequenceGap
	default: // sourceSeq < expected
		return ErrSequenceRegression
	}
}

// Rebuild reconstructs per-source lastSeq by replaying the durable records through Admit, which also
// validates that the durable log itself is gap-free per source (fail-closed if it is not).
func (t *Tracker) Rebuild(records []store.LogRecord) error {
	t.lastSeq = make(map[string]uint64)
	for _, r := range records {
		if err := t.Admit(r.SourceID, r.SourceSeq); err != nil {
			return fmt.Errorf("rebuild: source %q seq %d: %w", r.SourceID, r.SourceSeq, err)
		}
	}
	return nil
}
