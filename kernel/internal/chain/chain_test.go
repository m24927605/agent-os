package chain

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

type goldenVector struct {
	Name      string `json:"name"`
	Event     any    `json:"event"`
	PrevHash  string `json:"prevHash"`
	Sequence  int64  `json:"sequence"`
	EntryHash string `json:"entryHash"`
}

func loadVectors(t *testing.T) []goldenVector {
	t.Helper()
	b, err := os.ReadFile("../../testdata/golden-vectors.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var g struct {
		Vectors []goldenVector `json:"vectors"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatalf("unmarshal golden: %v", err)
	}
	if len(g.Vectors) == 0 {
		t.Fatal("no golden vectors")
	}
	return g.Vectors
}

var entryHashRe = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func TestComputeEntryHashConformsToGolden(t *testing.T) {
	for _, v := range loadVectors(t) {
		got, err := ComputeEntryHash(v.Event, v.PrevHash, int(v.Sequence))
		if err != nil {
			t.Fatalf("%s: ComputeEntryHash error: %v", v.Name, err)
		}
		if got != v.EntryHash {
			t.Errorf("%s: entryHash mismatch\n got %s\nwant %s", v.Name, got, v.EntryHash)
		}
		if !entryHashRe.MatchString(got) {
			t.Errorf("%s: bad entryHash format %s", v.Name, got)
		}
	}
}

func TestGenesisPrevHash(t *testing.T) {
	want := "sha256:" + strings.Repeat("0", 64)
	if GenesisPrevHash != want {
		t.Errorf("GenesisPrevHash = %q, want %q", GenesisPrevHash, want)
	}
}
