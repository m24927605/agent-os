package conformance

import (
	"os"
	"testing"
)

// Regenerate the Go-produced fixture: AGENTOS_GEN_FIXTURE=1 go test -run TestGenerateGoFixture ./internal/conformance/
// (deterministic — same seed + same events.json -> same bytes). Skipped in normal runs.
func TestGenerateGoFixture(t *testing.T) {
	if os.Getenv("AGENTOS_GEN_FIXTURE") != "1" {
		t.Skip("set AGENTOS_GEN_FIXTURE=1 to regenerate go-chain.json")
	}
	const events = "../../../conformance/cross-lang/events.json"
	for _, sc := range []struct {
		out   string
		count int
	}{
		{"../../../conformance/cross-lang/testdata/go-chain.json", -1},
		{"../../../conformance/cross-lang/testdata/go-chain-single.json", 1},
		{"../../../conformance/cross-lang/testdata/go-chain-empty.json", 0},
	} {
		if err := GenerateFixture(events, sc.out, sc.count); err != nil {
			t.Fatalf("generate %s: %v", sc.out, err)
		}
	}
}
