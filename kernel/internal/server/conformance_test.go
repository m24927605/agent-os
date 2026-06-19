package server

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
)

// The ingest path hashes canonical_event bytes directly; assert that path is byte-for-byte conformant
// to the TS-produced golden vectors (reuses kernel/testdata/golden-vectors.json from P1-S2).
func TestIngestEntryHashConformsToGolden(t *testing.T) {
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
	if len(g.Vectors) == 0 {
		t.Fatal("no golden vectors")
	}
	for _, v := range g.Vectors {
		cb, err := hex.DecodeString(v.CanonicalBytesHex)
		if err != nil {
			t.Fatalf("%s: %v", v.Name, err)
		}
		if got := chain.EntryHashFromCanonical(cb, v.PrevHash, int(v.Sequence)); got != v.EntryHash {
			t.Errorf("%s: ingest entryHash %s != golden %s", v.Name, got, v.EntryHash)
		}
	}
}
