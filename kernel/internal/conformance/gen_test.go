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
	if err := GenerateFixture(
		"../../../conformance/cross-lang/events.json",
		"../../../conformance/cross-lang/testdata/go-chain.json",
	); err != nil {
		t.Fatalf("generate go-chain.json: %v", err)
	}
}
