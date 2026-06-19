package conformance

import (
	"encoding/hex"
	"encoding/json"
	"os"

	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"strings"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/verify"
)

const (
	tsFixture = "../../../conformance/cross-lang/testdata/ts-chain.json"
	goFixture = "../../../conformance/cross-lang/testdata/go-chain.json"
)

// boundaryScenarios are the supplementary empty + single-entry chains (the multi-entry chain is the
// main subject above). Each has a TS-produced and a Go-produced fixture.
var boundaryScenarios = []struct{ ts, goFx string }{
	{"../../../conformance/cross-lang/testdata/ts-chain-single.json", "../../../conformance/cross-lang/testdata/go-chain-single.json"},
	{"../../../conformance/cross-lang/testdata/ts-chain-empty.json", "../../../conformance/cross-lang/testdata/go-chain-empty.json"},
}

func TestGoVerifiesTSChainBoundaries(t *testing.T) {
	for _, sc := range boundaryScenarios {
		c, err := Load(sc.ts)
		if err != nil {
			t.Fatalf("load %s: %v", sc.ts, err)
		}
		pub, err := c.PublicKey25519()
		if err != nil {
			t.Fatal(err)
		}
		if res := verify.VerifyChain(c.SignedChain(), pub); !res.Ok || res.Length != len(c.Entries) {
			t.Fatalf("%s: Go must verify the TS chain: %+v", sc.ts, res)
		}
	}
}

func TestCrossEqualityBoundaries(t *testing.T) {
	for _, sc := range boundaryScenarios {
		ts, err := Load(sc.ts)
		if err != nil {
			t.Fatal(err)
		}
		gofx, err := Load(sc.goFx)
		if err != nil {
			t.Fatalf("go boundary fixture missing (regenerate with AGENTOS_GEN_FIXTURE=1): %v", err)
		}
		if ts.Checkpoint.HeadEntryHash != gofx.Checkpoint.HeadEntryHash || ts.Checkpoint.Signature != gofx.Checkpoint.Signature {
			t.Errorf("%s vs %s: head/signature differ (empty/single boundary)", sc.ts, sc.goFx)
		}
	}
}

// 2^53-1 (Number.MAX_SAFE_INTEGER) sequence cross-equality is proven against the P1-S2 TS-produced
// golden (the append API assigns 0-based sequences, so the large value is exercised via the golden's
// "large-sequence" vector). >2^53-1 is out of scope (TS number cannot round-trip it).
func TestBigSequenceConformsToTSGolden(t *testing.T) {
	b, err := os.ReadFile("../../testdata/golden-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Vectors []struct {
			Name              string `json:"name"`
			PrevHash          string `json:"prevHash"`
			Sequence          int64  `json:"sequence"`
			CanonicalBytesHex string `json:"canonicalBytesHex"`
			EntryHash         string `json:"entryHash"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, v := range g.Vectors {
		if v.Sequence != 9007199254740991 { // 2^53-1
			continue
		}
		found = true
		cb, err := hex.DecodeString(v.CanonicalBytesHex)
		if err != nil {
			t.Fatal(err)
		}
		if got := chain.EntryHashFromCanonical(cb, v.PrevHash, int(v.Sequence)); got != v.EntryHash {
			t.Fatalf("2^53-1 sequence: Go %s != TS golden %s", got, v.EntryHash)
		}
	}
	if !found {
		t.Fatal("expected a golden vector with sequence 2^53-1 (large-sequence)")
	}
}

// Direction A: Go verifies a chain PRODUCED BY TS.
func TestGoVerifiesTSChain(t *testing.T) {
	c, err := Load(tsFixture)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := c.PublicKey25519()
	if err != nil {
		t.Fatal(err)
	}
	if res := verify.VerifyChain(c.SignedChain(), pub); !res.Ok || res.Length != len(c.Entries) {
		t.Fatalf("Go must verify the TS-produced chain: %+v", res)
	}
}

func TestGoDetectsTamperInTSChain(t *testing.T) {
	c, _ := Load(tsFixture)
	pub, _ := c.PublicKey25519()
	sc := c.SignedChain()
	sc.Entries[1].Event = map[string]any{"action": "TAMPERED"} // change content, keep entryHash
	if res := verify.VerifyChain(sc, pub); res.Ok || res.BrokenAt != 1 || !strings.Contains(res.Reason, "entry hash mismatch") {
		t.Fatalf("Go must detect tamper in the TS chain: %+v", res)
	}
}

func TestGoDetectsReorderInTSChain(t *testing.T) {
	c, _ := Load(tsFixture)
	pub, _ := c.PublicKey25519()
	sc := c.SignedChain()
	sc.Entries[0], sc.Entries[1] = sc.Entries[1], sc.Entries[0]
	if res := verify.VerifyChain(sc, pub); res.Ok || res.BrokenAt != 0 || !strings.Contains(res.Reason, "sequence not monotonic") {
		t.Fatalf("Go must detect reorder in the TS chain: %+v", res)
	}
}

func TestGoDetectsGapInTSChain(t *testing.T) {
	c, _ := Load(tsFixture)
	pub, _ := c.PublicKey25519()
	sc := c.SignedChain()
	sc.Entries = []chain.LogEntry{sc.Entries[0], sc.Entries[2]} // drop middle, keep original sequences (0,2)
	if res := verify.VerifyChain(sc, pub); res.Ok || res.BrokenAt != 1 || !strings.Contains(res.Reason, "sequence not monotonic") {
		t.Fatalf("Go must detect gap in the TS chain: %+v", res)
	}
}

func TestGoDetectsBadSigInTSChain(t *testing.T) {
	c, _ := Load(tsFixture)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	if res := verify.VerifyChain(c.SignedChain(), otherPub); res.Ok || res.BrokenAt != len(c.Entries) || !strings.Contains(res.Reason, "checkpoint signature invalid") {
		t.Fatalf("Go must reject the TS chain under the wrong key: %+v", res)
	}
}

// publicKey SPKI<->raw round-trip: bad-sig (signature swapped) and wrong-key (pubkey swapped) must be
// separable; that requires byte-exact key encoding both ways.
func TestPublicKeySPKIRoundTrip(t *testing.T) {
	c, _ := Load(tsFixture)
	pub, err := c.PublicKey25519()
	if err != nil {
		t.Fatal(err)
	}
	want, ok := ed25519.NewKeyFromSeed(testSeed()).Public().(ed25519.PublicKey)
	if !ok {
		t.Fatal("seed key public type")
	}
	if !pub.Equal(want) {
		t.Fatal("parsed SPKI pubkey != seeded key (encoding not byte-exact)")
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	again, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		t.Fatal(err)
	}
	if ap, ok := again.(ed25519.PublicKey); !ok || !ap.Equal(pub) {
		t.Fatal("SPKI marshal->parse round-trip mismatch")
	}
}

// The actual conformance: TS-produced and Go-produced fixtures (same events + seed) agree byte-for-byte
// on entryHash (per entry), head, and signature.
func TestCrossEqualityTSvsGo(t *testing.T) {
	ts, err := Load(tsFixture)
	if err != nil {
		t.Fatal(err)
	}
	gofx, err := Load(goFixture)
	if err != nil {
		t.Fatalf("go fixture missing (regenerate: AGENTOS_GEN_FIXTURE=1 go test -run TestGenerateGoFixture ./internal/conformance/): %v", err)
	}
	if len(ts.Entries) != len(gofx.Entries) {
		t.Fatalf("entry count differs: ts=%d go=%d", len(ts.Entries), len(gofx.Entries))
	}
	for i := range ts.Entries {
		if ts.Entries[i].EntryHash != gofx.Entries[i].EntryHash {
			t.Errorf("entry %d entryHash differs:\n ts %s\n go %s", i, ts.Entries[i].EntryHash, gofx.Entries[i].EntryHash)
		}
		if ts.Entries[i].PrevHash != gofx.Entries[i].PrevHash {
			t.Errorf("entry %d prevHash differs", i)
		}
	}
	if ts.Checkpoint.HeadEntryHash != gofx.Checkpoint.HeadEntryHash {
		t.Errorf("head differs: ts %s go %s", ts.Checkpoint.HeadEntryHash, gofx.Checkpoint.HeadEntryHash)
	}
	if ts.Checkpoint.Signature != gofx.Checkpoint.Signature {
		t.Errorf("checkpoint signature differs (deterministic Ed25519 should match): ts %.16s go %.16s", ts.Checkpoint.Signature, gofx.Checkpoint.Signature)
	}
}
