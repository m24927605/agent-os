// Package verify is a standalone chain verifier: it recomputes the hash-chain, detects
// tamper/reorder/gap, and verifies the Ed25519 checkpoint. It trusts ONLY the entries + checkpoint
// + public key it is handed — it does NOT import internal/log (depguard enforces this), so "the
// verifier is independent of the producer" is true by construction. It shares the pinned
// hash/frame functions (internal/chain) with the log on purpose: recomputing with the SAME
// definition is the point. Mirrors src/audit/kernel/verify.ts byte-for-byte in Ok/BrokenAt.
package verify

import (
	"crypto/ed25519"
	"fmt"

	"github.com/agent-os/kernel/internal/chain"
)

// VerifyResult reports either success (Ok, Length) or the first break (BrokenAt, Reason).
// Ok and BrokenAt are the byte-for-byte contract; Reason is human-readable, not a contract surface.
type VerifyResult struct {
	Ok       bool
	Length   int
	BrokenAt int
	Reason   string
}

// VerifyChain recomputes the chain in the pinned check order: sequence -> linkage -> entryHash ->
// checkpoint.length -> head -> signature. Fails closed.
func VerifyChain(c chain.SignedChain, publicKey ed25519.PublicKey) VerifyResult {
	prevHash := chain.GenesisPrevHash
	for i := range c.Entries {
		entry := c.Entries[i]
		if entry.Sequence != i {
			return VerifyResult{BrokenAt: i, Reason: fmt.Sprintf("sequence not monotonic: expected %d, got %d", i, entry.Sequence)}
		}
		if entry.PrevHash != prevHash {
			return VerifyResult{BrokenAt: i, Reason: "prev-hash linkage broken (reorder/insert/tamper)"}
		}
		got, err := chain.ComputeEntryHash(entry.Event, entry.PrevHash, entry.Sequence)
		if err != nil || got != entry.EntryHash {
			return VerifyResult{BrokenAt: i, Reason: "entry hash mismatch (tampered content)"}
		}
		prevHash = entry.EntryHash
	}

	if c.Checkpoint.Length != len(c.Entries) {
		return VerifyResult{BrokenAt: len(c.Entries), Reason: "checkpoint length mismatch"}
	}
	headEntryHash := chain.GenesisPrevHash
	if n := len(c.Entries); n > 0 {
		headEntryHash = c.Entries[n-1].EntryHash
	}
	if c.Checkpoint.HeadEntryHash != headEntryHash {
		return VerifyResult{BrokenAt: len(c.Entries), Reason: "checkpoint head mismatch"}
	}
	if !chain.VerifyCheckpoint(publicKey, c.Checkpoint.HeadEntryHash, c.Checkpoint.Length, c.Checkpoint.Signature) {
		return VerifyResult{BrokenAt: len(c.Entries), Reason: "checkpoint signature invalid"}
	}
	return VerifyResult{Ok: true, Length: len(c.Entries)}
}
