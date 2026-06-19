package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
)

func writeChainAndKey(t *testing.T, tamper bool) (chainPath, pubPath string) {
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
	dir := t.TempDir()
	chainPath = filepath.Join(dir, "chain.json")
	b, _ := json.Marshal(sc)
	if err := os.WriteFile(chainPath, b, 0o600); err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	pubPath = filepath.Join(dir, "pub.pem")
	if err := os.WriteFile(pubPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	return chainPath, pubPath
}

func TestVerifierCLIIntact(t *testing.T) {
	cp, pp := writeChainAndKey(t, false)
	var out, errb strings.Builder
	if code := verifyMain([]string{"--chain", cp, "--pubkey", pp}, nil, &out, &errb); code != 0 || !strings.Contains(out.String(), "ok length=2") {
		t.Fatalf("intact: code=%d out=%q err=%q", code, out.String(), errb.String())
	}
}

func TestVerifierCLITampered(t *testing.T) {
	cp, pp := writeChainAndKey(t, true)
	var out, errb strings.Builder
	if code := verifyMain([]string{"--chain", cp, "--pubkey", pp}, nil, &out, &errb); code == 0 {
		t.Fatalf("tampered must exit nonzero; out=%q", out.String())
	}
}

func TestVerifierCLIUnparseable(t *testing.T) {
	dir := t.TempDir()
	cp := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(cp, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, pp := writeChainAndKey(t, false)
	var out, errb strings.Builder
	if code := verifyMain([]string{"--chain", cp, "--pubkey", pp}, nil, &out, &errb); code == 0 {
		t.Fatal("unparseable input must exit nonzero (fail-closed)")
	}
}

func TestVerifierCLIMissingPubkey(t *testing.T) {
	cp, _ := writeChainAndKey(t, false)
	var out, errb strings.Builder
	if code := verifyMain([]string{"--chain", cp}, nil, &out, &errb); code == 0 {
		t.Fatal("missing pubkey must exit nonzero (fail-closed)")
	}
}
