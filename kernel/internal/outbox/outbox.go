// Package outbox is a producer-side transactional outbox: evidence is durably staged (fsync) and
// assigned a per-source monotonic sequence BEFORE any side effect is allowed (see commitgate), and
// at-least-once delivery to the kernel is made idempotent by a DURABLE delivered-set so a crash
// between commit and delivery never double-appends. It is append-only by construction (no
// Update/Delete/Rewrite) and stores only the already-redacted canonical bytes the caller hands it.
// It delivers via an injected Sink — it does NOT import the kernel append path (low coupling).
package outbox

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"sync"
)

// State of an outbox record.
type State string

const (
	Pending   State = "pending"
	Delivered State = "delivered"
)

// ErrContentConflict means an already-delivered (sourceId, sequence) is being re-presented with a
// different contentHash — fail-closed: never redeliver, never overwrite.
var ErrContentConflict = errors.New("outbox: content hash conflict for an already-delivered (sourceId, sequence)")

// RecordInput is what a caller hands in. CanonicalBytes must already be redacted S0.2 canonical bytes;
// ContentHash is their content address. The caller does NOT supply Sequence (the outbox allocates it).
type RecordInput struct {
	SourceID       string
	CanonicalBytes []byte
	ContentHash    string
}

// Record is a staged outbox record after the outbox assigns its sequence.
type Record struct {
	SourceID       string
	Sequence       uint64
	ContentHash    string
	CanonicalBytes []byte
	State          State
}

// CommitReceipt confirms a durable commit; Durable==true means fsync returned.
type CommitReceipt struct {
	SourceID    string
	Sequence    uint64
	ContentHash string
	Durable     bool
}

// Sink is the at-least-once delivery target (e.g. the kernel append). Injected to keep the outbox
// decoupled from the concrete kernel.
type Sink interface {
	Deliver(rec Record) error
}

const maxBodySize = 64 << 20

type opEntry struct {
	Op          string          `json:"op"` // "enqueue" | "delivered"
	SourceID    string          `json:"sourceId"`
	Sequence    uint64          `json:"sequence"`
	ContentHash string          `json:"contentHash"`
	// Canonical bytes are themselves valid JSON, so embed them inline (json.RawMessage) rather than
	// base64 — keeps the durable file auditable (redaction is visible) and round-trips faithfully.
	Canonical json.RawMessage `json:"canonical,omitempty"`
}

// Outbox is a durable append-only op-log. Not safe across processes; safe across goroutines.
type Outbox struct {
	mu        sync.Mutex
	f         *os.File
	path      string
	lastSeq   map[string]uint64
	seen      map[string]bool
	pending   map[string]Record
	delivered map[string]string // key -> contentHash
}

func key(sourceID string, seq uint64) string { return fmt.Sprintf("%s/%d", sourceID, seq) }

// Open opens (creating if needed) the durable outbox, replaying existing state.
func Open(path string) (*Outbox, error) {
	o := &Outbox{
		path:      path,
		lastSeq:   map[string]uint64{},
		seen:      map[string]bool{},
		pending:   map[string]Record{},
		delivered: map[string]string{},
	}
	if err := o.replay(); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	o.f = f
	return o, nil
}

func (o *Outbox) replay() error {
	f, err := os.Open(o.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	fileSize := info.Size()
	r := bufio.NewReader(f)
	var offset int64
	for {
		var lenBuf [8]byte
		n, rerr := io.ReadFull(r, lenBuf[:])
		if rerr == io.EOF && n == 0 {
			break
		}
		if rerr != nil {
			return fmt.Errorf("outbox: torn tail: partial length prefix (%d bytes): %w", n, rerr)
		}
		offset += 8
		bodyLen := binary.BigEndian.Uint64(lenBuf[:])
		if bodyLen > maxBodySize || int64(bodyLen) > fileSize-offset {
			return fmt.Errorf("outbox: torn tail: implausible body length %d", bodyLen)
		}
		body := make([]byte, bodyLen)
		if _, rerr := io.ReadFull(r, body); rerr != nil {
			return fmt.Errorf("outbox: torn tail: truncated body: %w", rerr)
		}
		offset += int64(bodyLen)
		var e opEntry
		if jerr := json.Unmarshal(body, &e); jerr != nil {
			return fmt.Errorf("outbox: corrupt op: %w", jerr)
		}
		o.applyReplay(e)
	}
	return nil
}

func (o *Outbox) applyReplay(e opEntry) {
	k := key(e.SourceID, e.Sequence)
	switch e.Op {
	case "enqueue":
		o.lastSeq[e.SourceID] = e.Sequence
		o.seen[e.SourceID] = true
		o.pending[k] = Record{SourceID: e.SourceID, Sequence: e.Sequence, ContentHash: e.ContentHash, CanonicalBytes: []byte(e.Canonical), State: Pending}
	case "delivered":
		o.delivered[k] = e.ContentHash
		delete(o.pending, k)
	}
}

// append writes a framed op and fsyncs; only after fsync is the op durable.
func (o *Outbox) append(e opEntry) error {
	body, err := json.Marshal(e)
	if err != nil {
		return err
	}
	var lenBuf [8]byte
	binary.BigEndian.PutUint64(lenBuf[:], uint64(len(body)))
	if _, err := o.f.Write(lenBuf[:]); err != nil {
		return err
	}
	if _, err := o.f.Write(body); err != nil {
		return err
	}
	return o.f.Sync() // fsync — durability point
}

// Enqueue allocates a per-source monotonic sequence, durably stages the record (fsync), and returns
// a durable receipt. The sequence is allocated by the outbox (callers cannot supply it).
func (o *Outbox) Enqueue(in RecordInput) (CommitReceipt, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	var seq uint64
	if o.seen[in.SourceID] {
		seq = o.lastSeq[in.SourceID] + 1
	}
	e := opEntry{Op: "enqueue", SourceID: in.SourceID, Sequence: seq, ContentHash: in.ContentHash, Canonical: json.RawMessage(in.CanonicalBytes)}
	if err := o.append(e); err != nil {
		return CommitReceipt{}, err // not durable -> receipt absent; commitgate must fail closed
	}
	o.lastSeq[in.SourceID] = seq
	o.seen[in.SourceID] = true
	o.pending[key(in.SourceID, seq)] = Record{SourceID: in.SourceID, Sequence: seq, ContentHash: in.ContentHash, CanonicalBytes: in.CanonicalBytes, State: Pending}
	return CommitReceipt{SourceID: in.SourceID, Sequence: seq, ContentHash: in.ContentHash, Durable: true}, nil
}

// MarkDelivered durably records that (sourceID, seq) was delivered.
func (o *Outbox) MarkDelivered(sourceID string, seq uint64) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	k := key(sourceID, seq)
	if _, done := o.delivered[k]; done {
		return nil
	}
	rec, ok := o.pending[k]
	if !ok {
		return fmt.Errorf("outbox: MarkDelivered unknown record %s", k)
	}
	if err := o.append(opEntry{Op: "delivered", SourceID: sourceID, Sequence: seq, ContentHash: rec.ContentHash}); err != nil {
		return err
	}
	o.delivered[k] = rec.ContentHash
	delete(o.pending, k)
	return nil
}

// PendingSince returns the still-pending records for a source with sequence >= after, ordered.
func (o *Outbox) PendingSince(sourceID string, after uint64) ([]Record, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	var out []Record
	for _, r := range o.pending {
		if r.SourceID == sourceID && r.Sequence >= after {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Sequence < out[j].Sequence })
	return out, nil
}

// CheckDedup reports whether (sourceID, seq) was already delivered with the SAME contentHash (no-op),
// returns ErrContentConflict if delivered with a different hash, else (false, nil).
func (o *Outbox) CheckDedup(sourceID string, seq uint64, contentHash string) (alreadyDelivered bool, err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	h, done := o.delivered[key(sourceID, seq)]
	if !done {
		return false, nil
	}
	if h != contentHash {
		return false, ErrContentConflict
	}
	return true, nil
}

// Deliver pushes still-pending records through the sink at-least-once, deduping via the durable
// delivered-set, and durably marks each delivered. Fail-closed: a sink error stops delivery and the
// record stays pending (to be retried), never silently dropped.
func (o *Outbox) Deliver(sink Sink) error {
	o.mu.Lock()
	pend := make([]Record, 0, len(o.pending))
	for _, r := range o.pending {
		pend = append(pend, r)
	}
	o.mu.Unlock()
	sort.Slice(pend, func(i, j int) bool {
		if pend[i].SourceID != pend[j].SourceID {
			return pend[i].SourceID < pend[j].SourceID
		}
		return pend[i].Sequence < pend[j].Sequence
	})
	for _, rec := range pend {
		already, err := o.CheckDedup(rec.SourceID, rec.Sequence, rec.ContentHash)
		if err != nil {
			return err
		}
		if already {
			continue
		}
		if err := sink.Deliver(rec); err != nil {
			return err
		}
		if err := o.MarkDelivered(rec.SourceID, rec.Sequence); err != nil {
			return err
		}
	}
	return nil
}

// Close closes the durable file.
func (o *Outbox) Close() error { return o.f.Close() }
