package canonical

import (
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"testing"
)

type goldenVector struct {
	Name              string `json:"name"`
	Event             any    `json:"event"`
	PrevHash          string `json:"prevHash"`
	Sequence          int64  `json:"sequence"`
	CanonicalBytesHex string `json:"canonicalBytesHex"`
	EntryHash         string `json:"entryHash"`
}

type goldenFile struct {
	GenesisPrevHash string         `json:"genesisPrevHash"`
	Vectors         []goldenVector `json:"vectors"`
}

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	b, err := os.ReadFile("../../testdata/golden-vectors.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var g goldenFile
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatalf("unmarshal golden: %v", err)
	}
	if len(g.Vectors) == 0 {
		t.Fatal("no golden vectors")
	}
	return g
}

func TestCanonicalBytesConformsToGolden(t *testing.T) {
	for _, v := range loadGolden(t).Vectors {
		got, err := CanonicalBytes(v.Event)
		if err != nil {
			t.Fatalf("%s: CanonicalBytes error: %v", v.Name, err)
		}
		if h := hex.EncodeToString(got); h != v.CanonicalBytesHex {
			t.Errorf("%s: canonical bytes mismatch\n got: %s\nwant: %s\n gotStr: %s", v.Name, h, v.CanonicalBytesHex, string(got))
		}
	}
}

func TestCanonicalBytesFailsClosedOnUnserializable(t *testing.T) {
	cases := map[string]any{
		"NaN":             map[string]any{"x": math.NaN()},
		"PosInf":          map[string]any{"x": math.Inf(1)},
		"NegInf":          map[string]any{"x": math.Inf(-1)},
		"func":            map[string]any{"x": func() {}},
		"chan":            map[string]any{"x": make(chan int)},
		"array-nested-fn": map[string]any{"x": []any{1.0, func() {}}},
		"bigint-overflow": map[string]any{"x": json.Number("99999999999999999999999999")},
	}
	for name, ev := range cases {
		if _, err := CanonicalBytes(ev); err == nil {
			t.Errorf("%s: expected error (fail-closed), got nil", name)
		}
	}
}
