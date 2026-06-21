package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"strings"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
)

// buildChainBytes produces (chainJSON, pubPEM) for a 2-entry signed chain. When tamper is true the
// second entry's event is mutated AFTER hashing so recomputation must fail (fail-closed).
func buildChainBytes(t *testing.T, tamper bool) (chainJSON, pubPEM []byte) {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	events := []any{
		map[string]any{"action": "fs:read", "resource": "/a"},
		map[string]any{"action": "fs:read", "resource": "/b"},
	}
	entries := make([]chain.LogEntry, 0, len(events))
	prev := chain.GenesisPrevHash
	for i, ev := range events {
		eh, err := chain.ComputeEntryHash(ev, prev, i)
		if err != nil {
			t.Fatalf("ComputeEntryHash: %v", err)
		}
		entries = append(entries, chain.LogEntry{Sequence: i, Event: ev, PrevHash: prev, EntryHash: eh})
		prev = eh
	}
	head := entries[len(entries)-1].EntryHash
	sc := chain.SignedChain{
		Entries:    entries,
		Checkpoint: chain.Checkpoint{Length: len(entries), HeadEntryHash: head, Signature: chain.SignCheckpoint(priv, head, len(entries))},
	}
	if tamper {
		sc.Entries[1].Event = map[string]any{"action": "fs:read", "resource": "/etc/passwd"}
	}
	b, _ := json.Marshal(sc)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	return b, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
}

// verifyChainBytes is the pure, IO-free helper shared by the native CLI (main.go) and the WASM
// entrypoint (wasm_main.go). It must NOT duplicate the verification logic (delegates to
// internal/verify.VerifyChain) and must fail closed on bad input / missing key.

func TestVerifyChainBytesIntact(t *testing.T) {
	cj, pk := buildChainBytes(t, false)
	res := verifyChainBytes(cj, pk)
	if !res.Ok || res.Length != 2 {
		t.Fatalf("intact chain must verify: %+v", res)
	}
}

func TestVerifyChainBytesTampered(t *testing.T) {
	cj, pk := buildChainBytes(t, true)
	res := verifyChainBytes(cj, pk)
	if res.Ok {
		t.Fatal("tampered chain must NOT verify (fail-closed)")
	}
	if !strings.Contains(res.Reason, "entry hash mismatch") {
		t.Fatalf("tampered chain reason should map to verify.go entry hash mismatch, got %q", res.Reason)
	}
}

func TestVerifyChainBytesMissingPubkey(t *testing.T) {
	cj, _ := buildChainBytes(t, false)
	res := verifyChainBytes(cj, nil)
	if res.Ok {
		t.Fatal("missing/empty pubkey must NOT verify (fail-closed)")
	}
}

func TestVerifyChainBytesBadPubkey(t *testing.T) {
	cj, _ := buildChainBytes(t, false)
	res := verifyChainBytes(cj, []byte("-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----\n"))
	if res.Ok {
		t.Fatal("malformed pubkey must NOT verify (fail-closed)")
	}
}

func TestVerifyChainBytesUnparseable(t *testing.T) {
	_, pk := buildChainBytes(t, false)
	res := verifyChainBytes([]byte("{not json"), pk)
	if res.Ok {
		t.Fatal("unparseable chain must NOT verify (fail-closed)")
	}
}
