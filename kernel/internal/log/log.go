// Package log is an in-memory, append-only, hash-chained reference log for the evidence kernel.
// It is REFERENCE ONLY: not durable and not process-isolated (durable storage = P1-S4, separate
// process/identity = P1-S6). It is append-only BY CONSTRUCTION — there is intentionally no
// Update/Delete method. It persists the REDACTED event so credentials never land in the chain.
package log

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"

	"github.com/agent-os/kernel/internal/canonical"
	"github.com/agent-os/kernel/internal/chain"
)

// AppendReceipt is returned to the caller for each appended record.
type AppendReceipt struct {
	Sequence    int
	ContentHash string // "sha256:"-prefixed content address of the (redacted) event
	PrevHash    string
	EntryHash   string
}

// AppendOnlyLog is append-only by construction: no Update/Delete in the interface.
type AppendOnlyLog interface {
	Append(event any) (AppendReceipt, error)
}

// InMemoryAppendOnlyLog is a reference-only, NON-durable AppendOnlyLog.
type InMemoryAppendOnlyLog struct {
	entries []chain.LogEntry
	pub     ed25519.PublicKey
	priv    ed25519.PrivateKey
}

// NewInMemoryAppendOnlyLog creates a reference log signing checkpoints with priv.
func NewInMemoryAppendOnlyLog(pub ed25519.PublicKey, priv ed25519.PrivateKey) *InMemoryAppendOnlyLog {
	return &InMemoryAppendOnlyLog{pub: pub, priv: priv}
}

func contentAddress(event any) (string, error) {
	cb, err := canonical.CanonicalBytes(event)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(cb)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

// Append links a new entry to the chain head and returns its receipt. The event is REDACTED before
// being stored and hashed. Fails closed (returns an error) if the event is not serializable.
func (l *InMemoryAppendOnlyLog) Append(event any) (AppendReceipt, error) {
	redacted := canonical.RedactEvent(event)
	sequence := len(l.entries)
	prevHash := chain.GenesisPrevHash
	if sequence > 0 {
		prevHash = l.entries[sequence-1].EntryHash
	}
	entryHash, err := chain.ComputeEntryHash(redacted, prevHash, sequence)
	if err != nil {
		return AppendReceipt{}, err
	}
	contentHash, err := contentAddress(redacted)
	if err != nil {
		return AppendReceipt{}, err
	}
	l.entries = append(l.entries, chain.LogEntry{Sequence: sequence, Event: redacted, PrevHash: prevHash, EntryHash: entryHash})
	return AppendReceipt{Sequence: sequence, ContentHash: contentHash, PrevHash: prevHash, EntryHash: entryHash}, nil
}

// Entries returns a copy of the entries (never the internal slice).
func (l *InMemoryAppendOnlyLog) Entries() []chain.LogEntry {
	out := make([]chain.LogEntry, len(l.entries))
	copy(out, l.entries)
	return out
}

// Checkpoint signs the chain HEAD (checkpointBytes(headEntryHash, length)) — not a per-entry sig.
func (l *InMemoryAppendOnlyLog) Checkpoint() chain.Checkpoint {
	length := len(l.entries)
	head := chain.GenesisPrevHash
	if length > 0 {
		head = l.entries[length-1].EntryHash
	}
	return chain.Checkpoint{Length: length, HeadEntryHash: head, Signature: chain.SignCheckpoint(l.priv, head, length)}
}

// SignedChain returns the externally-verifiable artifact (entries copy + checkpoint over head).
func (l *InMemoryAppendOnlyLog) SignedChain() chain.SignedChain {
	return chain.SignedChain{Entries: l.Entries(), Checkpoint: l.Checkpoint()}
}
