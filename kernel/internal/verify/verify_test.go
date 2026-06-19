package verify

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
)

// buildChain constructs a valid SignedChain using the pinned chain primitives (NOT internal/log) —
// keeping verify + its tests independent of the producer, as depguard enforces.
func buildChain(t *testing.T, priv ed25519.PrivateKey, events []any) chain.SignedChain {
	t.Helper()
	entries := make([]chain.LogEntry, 0, len(events))
	prevHash := chain.GenesisPrevHash
	for i, ev := range events {
		eh, err := chain.ComputeEntryHash(ev, prevHash, i)
		if err != nil {
			t.Fatalf("ComputeEntryHash: %v", err)
		}
		entries = append(entries, chain.LogEntry{Sequence: i, Event: ev, PrevHash: prevHash, EntryHash: eh})
		prevHash = eh
	}
	head := chain.GenesisPrevHash
	if len(entries) > 0 {
		head = entries[len(entries)-1].EntryHash
	}
	return chain.SignedChain{
		Entries:    entries,
		Checkpoint: chain.Checkpoint{Length: len(entries), HeadEntryHash: head, Signature: chain.SignCheckpoint(priv, head, len(entries))},
	}
}

func events3() []any {
	return []any{
		map[string]any{"action": "fs:read", "resource": "/a"},
		map[string]any{"action": "fs:read", "resource": "/b"},
		map[string]any{"action": "net:dial", "resource": "/c"},
	}
}

func TestVerifyIntact(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	if res := VerifyChain(buildChain(t, priv, events3()), pub); !res.Ok || res.Length != 3 {
		t.Fatalf("want ok len=3, got %+v", res)
	}
}

func TestVerifyTamper(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	c := buildChain(t, priv, events3())
	c.Entries[1].Event = map[string]any{"action": "fs:read", "resource": "/etc/passwd"} // tamper content, keep entryHash
	if res := VerifyChain(c, pub); res.Ok || res.BrokenAt != 1 || !strings.Contains(res.Reason, "entry hash mismatch") {
		t.Fatalf("want broken@1 entry-hash-mismatch, got %+v", res)
	}
}

func TestVerifyReorder(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	c := buildChain(t, priv, events3())
	c.Entries[0], c.Entries[1] = c.Entries[1], c.Entries[0] // swap, keep their original sequence fields
	if res := VerifyChain(c, pub); res.Ok || res.BrokenAt != 0 || !strings.Contains(res.Reason, "sequence not monotonic") {
		t.Fatalf("want broken@0 sequence-not-monotonic, got %+v", res)
	}
}

func TestVerifyGap(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	c := buildChain(t, priv, events3())
	c.Entries = []chain.LogEntry{c.Entries[0], c.Entries[2]} // drop middle, keep originals' sequence (0,2)
	c.Checkpoint.Length = 2
	if res := VerifyChain(c, pub); res.Ok || res.BrokenAt != 1 || !strings.Contains(res.Reason, "sequence not monotonic") {
		t.Fatalf("want broken@1 sequence-not-monotonic (gap), got %+v", res)
	}
}

func TestVerifyBadSig(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	if res := VerifyChain(buildChain(t, priv, events3()), otherPub); res.Ok || res.BrokenAt != 3 || !strings.Contains(res.Reason, "checkpoint signature invalid") {
		t.Fatalf("want broken@3 bad-sig, got %+v", res)
	}
}

func TestVerifyEmptyIntact(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	if res := VerifyChain(buildChain(t, priv, nil), pub); !res.Ok || res.Length != 0 {
		t.Fatalf("want ok len=0 for intact empty chain, got %+v", res)
	}
}

func TestVerifyEmptyForged(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	c := buildChain(t, priv, nil)                                    // empty, valid checkpoint over genesis
	c.Checkpoint.HeadEntryHash = "sha256:" + strings.Repeat("f", 64) // forge head != genesis
	if res := VerifyChain(c, pub); res.Ok {
		t.Fatalf("forged empty chain must NOT verify ok (fail-open guard), got %+v", res)
	}
}
