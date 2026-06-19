package canonical

import (
	"strings"
	"testing"
)

// Canary assembled at RUNTIME (never a committed literal) so scan_secrets.sh / the fixture stay clean.
func TestRedactBeforeCanonicalize(t *testing.T) {
	canary := "sk-" + strings.Repeat("a", 40)
	ev := map[string]any{
		"apiKey":   canary,                 // by-KEY redaction (value replaced wholesale)
		"resource": "/workspace/" + canary, // by-VALUE redaction (secret-shape under a non-secret key)
		"note":     "keep-this",
	}
	got, err := CanonicalBytes(ev)
	if err != nil {
		t.Fatalf("CanonicalBytes error: %v", err)
	}
	s := string(got)
	if strings.Contains(s, canary) {
		t.Errorf("canary leaked into canonical bytes: %s", s)
	}
	if !strings.Contains(s, "[REDACTED]") {
		t.Errorf("expected [REDACTED] in output, got: %s", s)
	}
	if !strings.Contains(s, "keep-this") {
		t.Errorf("non-secret value must be preserved, got: %s", s)
	}
}
