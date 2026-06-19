package store

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agent-os/kernel/internal/canonical"
	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/verify"
)

func buildRecords(t *testing.T, events []any) []LogRecord {
	t.Helper()
	recs := make([]LogRecord, 0, len(events))
	prev := chain.GenesisPrevHash
	for i, ev := range events {
		eh, err := chain.ComputeEntryHash(ev, prev, i)
		if err != nil {
			t.Fatalf("entryhash: %v", err)
		}
		recs = append(recs, LogRecord{Sequence: i, Event: ev, PrevHash: prev, EntryHash: eh, SourceID: "src-a", SourceSeq: uint64(i)})
		prev = eh
	}
	return recs
}

func TestDurableRoundTripVerifies(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log.wal")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	events := []any{
		map[string]any{"action": "fs:read", "resource": "/a"},
		map[string]any{"action": "fs:read", "resource": "/b"},
		map[string]any{"action": "net:dial", "resource": "/c"},
	}
	recs := buildRecords(t, events)
	for _, r := range recs {
		if _, err := s.Append(r); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	_ = s.Close()

	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	loaded, head, err := s2.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded) != 3 || head != recs[2].EntryHash {
		t.Fatalf("loaded=%d head=%s want 3 / %s", len(loaded), head, recs[2].EntryHash)
	}
	// startup self-check is done by the CALLER (store does not import verify): reloaded chain verifies.
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	entries := make([]chain.LogEntry, len(loaded))
	for i, r := range loaded {
		entries[i] = chain.LogEntry{Sequence: r.Sequence, Event: r.Event, PrevHash: r.PrevHash, EntryHash: r.EntryHash}
	}
	cp := chain.Checkpoint{Length: len(entries), HeadEntryHash: head, Signature: chain.SignCheckpoint(priv, head, len(entries))}
	if res := verify.VerifyChain(chain.SignedChain{Entries: entries, Checkpoint: cp}, pub); !res.Ok {
		t.Fatalf("reloaded chain failed to verify: %+v", res)
	}
}

func TestLoadRejectsTornPartialLengthPrefix(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t1.wal")
	s, _ := Open(path)
	_, _ = s.Append(buildRecords(t, []any{map[string]any{"a": "1"}})[0])
	_ = s.Close()
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.Write([]byte{0, 0, 0}) // 3 stray bytes < 8-byte length prefix
	_ = f.Close()
	s1, _ := Open(path)
	if _, _, err := s1.Load(); err == nil {
		t.Fatal("torn partial length-prefix must error (no silent truncation)")
	}
}

func TestLoadRejectsTruncatedBody(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t2.wal")
	s, _ := Open(path)
	_, _ = s.Append(buildRecords(t, []any{map[string]any{"a": "1"}})[0])
	_ = s.Close()
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	var lb [8]byte
	binary.BigEndian.PutUint64(lb[:], 100) // claim 100 bytes...
	_, _ = f.Write(lb[:])
	_, _ = f.Write([]byte("short")) // ...but only 5 present
	_ = f.Close()
	s2, _ := Open(path)
	if _, _, err := s2.Load(); err == nil {
		t.Fatal("truncated body must error (no silent truncation)")
	}
}

func TestPersistedRecordRedacted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.wal")
	s, _ := Open(path)
	canary := "sk-" + strings.Repeat("a", 40)
	ev := canonical.RedactEvent(map[string]any{"apiKey": canary, "resource": "/x/" + canary})
	eh, _ := chain.ComputeEntryHash(ev, chain.GenesisPrevHash, 0)
	if _, err := s.Append(LogRecord{Sequence: 0, Event: ev, PrevHash: chain.GenesisPrevHash, EntryHash: eh, SourceID: "s", SourceSeq: 0}); err != nil {
		t.Fatalf("append: %v", err)
	}
	_ = s.Close()
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), canary) {
		t.Fatalf("canary leaked into durable file")
	}
	if !strings.Contains(string(raw), "[REDACTED]") {
		t.Fatalf("expected [REDACTED] in durable file")
	}
}
