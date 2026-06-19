// Package conformance is the Go side of the TS<->Go cross-language conformance harness (P1-S7).
// It loads the language-neutral chain fixture (pure JSON — the ONLY cross-plane coupling; zero shared
// code) and can generate the Go-produced fixture from the SAME shared events.json + SAME seeded key
// as the TS generator. Test-only; lives under internal/ so it is not importable outside the kernel.
package conformance

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/log"
)

// Entry / Checkpoint / CrossLangChain mirror the language-neutral fixture schema.
type Entry struct {
	Sequence  int    `json:"sequence"`
	Event     any    `json:"event"`
	PrevHash  string `json:"prevHash"`
	EntryHash string `json:"entryHash"`
}

type Checkpoint struct {
	Length        int    `json:"length"`
	HeadEntryHash string `json:"headEntryHash"`
	Signature     string `json:"signature"`
}

type CrossLangChain struct {
	Version    string     `json:"version"`
	PublicKey  string     `json:"publicKey"`
	Entries    []Entry    `json:"entries"`
	Checkpoint Checkpoint `json:"checkpoint"`
}

// Load reads a fixture from disk.
func Load(path string) (CrossLangChain, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return CrossLangChain{}, err
	}
	var c CrossLangChain
	if err := json.Unmarshal(b, &c); err != nil {
		return CrossLangChain{}, err
	}
	return c, nil
}

// PublicKey25519 parses the "ed25519:<base64(SPKI DER)>" field into a raw 32-byte ed25519.PublicKey
// (Go's ed25519.PublicKey is raw bytes, not SPKI — so SPKI must go through x509.ParsePKIXPublicKey).
func (c CrossLangChain) PublicKey25519() (ed25519.PublicKey, error) {
	const prefix = "ed25519:"
	if !strings.HasPrefix(c.PublicKey, prefix) {
		return nil, fmt.Errorf("conformance: unsupported public key encoding: %q", c.PublicKey)
	}
	der, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(c.PublicKey, prefix))
	if err != nil {
		return nil, err
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	pub, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("conformance: not an ed25519 public key: %T", parsed)
	}
	return pub, nil
}

// SignedChain converts the fixture into the chain.SignedChain the P1-S3 verifier consumes.
func (c CrossLangChain) SignedChain() chain.SignedChain {
	entries := make([]chain.LogEntry, len(c.Entries))
	for i, e := range c.Entries {
		entries[i] = chain.LogEntry{Sequence: e.Sequence, Event: e.Event, PrevHash: e.PrevHash, EntryHash: e.EntryHash}
	}
	return chain.SignedChain{
		Entries:    entries,
		Checkpoint: chain.Checkpoint{Length: c.Checkpoint.Length, HeadEntryHash: c.Checkpoint.HeadEntryHash, Signature: c.Checkpoint.Signature},
	}
}

// testSeed is the fixed 32-byte ed25519 seed shared with the TS generator (test-only, not a credential).
func testSeed() []byte {
	s := make([]byte, 32)
	for i := range s {
		s[i] = 7
	}
	return s
}

// GenerateFixture produces the Go-side fixture from the first eventCount events of the shared
// events.json (same key + same events as the TS generator), so the two fixtures are cross-verifiable
// and entryHash/head/signature-equal. eventCount<0 means "all". The canary is assembled at runtime and
// redacted on append (the log stores only redacted events).
func GenerateFixture(eventsPath, outPath string, eventCount int) error {
	raw, err := os.ReadFile(eventsPath)
	if err != nil {
		return err
	}
	canary := "sk-" + strings.Repeat("a", 40)
	var events []any
	if err := json.Unmarshal([]byte(strings.ReplaceAll(string(raw), "__CANARY__", canary)), &events); err != nil {
		return err
	}
	if eventCount >= 0 && eventCount < len(events) {
		events = events[:eventCount]
	}

	priv := ed25519.NewKeyFromSeed(testSeed())
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return fmt.Errorf("conformance: unexpected public key type")
	}

	l := log.NewInMemoryAppendOnlyLog(pub, priv)
	for _, ev := range events {
		if _, err := l.Append(ev); err != nil { // the log redacts before storing/hashing
			return err
		}
	}
	logEntries := l.Entries()
	cp := l.Checkpoint()

	entries := make([]Entry, len(logEntries))
	for i, e := range logEntries {
		entries[i] = Entry{Sequence: e.Sequence, Event: e.Event, PrevHash: e.PrevHash, EntryHash: e.EntryHash}
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return err
	}
	out := CrossLangChain{
		Version:    "agentos.cross-lang-chain.v1",
		PublicKey:  "ed25519:" + base64.StdEncoding.EncodeToString(der),
		Entries:    entries,
		Checkpoint: Checkpoint{Length: cp.Length, HeadEntryHash: cp.HeadEntryHash, Signature: cp.Signature},
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(outPath, append(b, '\n'), 0o600)
}
