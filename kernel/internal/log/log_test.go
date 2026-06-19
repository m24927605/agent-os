package log

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
)

func TestAppendMonotonicAndLinked(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	l := NewInMemoryAppendOnlyLog(pub, priv)
	var prevEntryHash string
	for i := 0; i < 3; i++ {
		r, err := l.Append(map[string]any{"action": "fs:read", "resource": "/x"})
		if err != nil {
			t.Fatalf("append: %v", err)
		}
		if r.Sequence != i {
			t.Fatalf("seq=%d want %d", r.Sequence, i)
		}
		if !strings.HasPrefix(r.ContentHash, "sha256:") || !strings.HasPrefix(r.EntryHash, "sha256:") || !strings.HasPrefix(r.PrevHash, "sha256:") {
			t.Fatalf("receipt hashes must be sha256:-prefixed: %+v", r)
		}
		if i == 0 {
			if r.PrevHash != chain.GenesisPrevHash {
				t.Fatalf("first prevHash=%s want genesis", r.PrevHash)
			}
		} else if r.PrevHash != prevEntryHash {
			t.Fatalf("prevHash=%s want prev entryHash=%s", r.PrevHash, prevEntryHash)
		}
		prevEntryHash = r.EntryHash
	}
	if got := l.Entries(); len(got) != 3 {
		t.Fatalf("Entries len=%d want 3", len(got))
	}
}

// The kernel persists only REDACTED events: a canary (assembled at runtime, never a fixture literal)
// must not survive into the serialized chain.
func TestNoCredentialLeak(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	l := NewInMemoryAppendOnlyLog(pub, priv)
	canary := "sk-" + strings.Repeat("a", 40)
	if _, err := l.Append(map[string]any{"apiKey": canary, "resource": "/x/" + canary, "note": "keep"}); err != nil {
		t.Fatalf("append: %v", err)
	}
	blob, err := json.Marshal(l.SignedChain())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(blob)
	if strings.Contains(s, canary) {
		t.Fatalf("canary leaked into SignedChain: %s", s)
	}
	if !strings.Contains(s, "[REDACTED]") {
		t.Fatalf("expected [REDACTED] in chain, got: %s", s)
	}
}
