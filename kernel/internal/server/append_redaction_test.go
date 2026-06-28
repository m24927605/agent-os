package server

import (
	"context"
	"strings"
	"testing"

	"github.com/agent-os/kernel/internal/canonical"
	"github.com/agent-os/kernel/internal/chain"
)

// storedEntry reads the durable log back and returns the LAST record's stored event re-serialized to
// canonical bytes (what is actually persisted in the WORM log) plus its committed entryHash. This is
// the ground truth: it inspects the bytes that LANDED, not the inbound request.
func storedEntry(t *testing.T, srv *IngestServer) (eventBytes []byte, entryHash string) {
	t.Helper()
	recs, _, err := srv.store.Load()
	if err != nil {
		t.Fatalf("store load: %v", err)
	}
	if len(recs) == 0 {
		t.Fatal("no records persisted")
	}
	last := recs[len(recs)-1]
	cb, err := canonical.CanonicalBytes(last.Event)
	if err != nil {
		t.Fatalf("re-canonicalize stored event: %v", err)
	}
	return cb, last.EntryHash
}

// TestIngestRedactsCredentialValuesBackstop is the BACKSTOP test: a (buggy/compromised) producer
// appends an event whose canonical_event JSON carries credential-shaped VALUES under non-secret-named
// fields. The kernel MUST scrub those shapes before hashing/storing — so neither the persisted WORM
// bytes nor the bytes entryHash was computed over ever contain the raw secret. RED before the fix
// (the kernel persists inbound bytes verbatim).
func TestIngestRedactsCredentialValuesBackstop(t *testing.T) {
	srv, _ := newTestServer(t)

	// Build secrets at runtime so this fixture never embeds a literal credential.
	openai := "sk-" + strings.Repeat("a", 40)     // sk-... API key shape
	google := "ya29." + strings.Repeat("Z", 40)   // Google OAuth access token
	apiKey := "AIza" + strings.Repeat("B", 35)    // Google API key (exactly 35 trailing)
	bearer := "Bearer " + strings.Repeat("c", 40) // Bearer <token>

	// Secret-shaped values sit under NON-secret-named fields ("resource", "note", "ctx", "auth"),
	// so by-key redaction would miss them; only by-VALUE scrubbing catches them.
	ev := `{"action":"call","resource":"` + openai + `","note":"` + google +
		`","ctx":"` + apiKey + `","auth":"` + bearer + `"}`

	resp, err := srv.Append(context.Background(), appendReq("S", 0, ev))
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if resp.GetReceipt() == nil {
		t.Fatalf("expected receipt, got error %v", resp.GetError())
	}

	storedBytes, storedHash := storedEntry(t, srv)
	stored := string(storedBytes)

	// 1) The STORED WORM bytes (the persisted event re-serialized) must not contain any raw secret,
	//    and must contain [REDACTED] — the credential never landed in the durable WORM record.
	for name, secret := range map[string]string{"sk": openai, "ya29": google, "AIza": apiKey, "Bearer": bearer} {
		if strings.Contains(stored, secret) {
			t.Fatalf("stored WORM event leaked raw %s credential", name)
		}
	}
	if !strings.Contains(stored, canonical.Redacted) {
		t.Fatalf("stored WORM event missing %s token: %s", canonical.Redacted, stored)
	}

	// 2) The HASHED bytes are the kernel's backstop output over the inbound canonical bytes:
	//    RedactCanonicalBytes(inbound). They must contain [REDACTED] and no raw secret, and the
	//    committed entryHash must equal the hash over exactly those bytes (prevHash=genesis, seq=0).
	hashedBytes := canonical.RedactCanonicalBytes([]byte(ev))
	for name, secret := range map[string]string{"sk": openai, "ya29": google, "AIza": apiKey, "Bearer": bearer} {
		if strings.Contains(string(hashedBytes), secret) {
			t.Fatalf("bytes entryHash was computed over leaked raw %s credential", name)
		}
	}
	if !strings.Contains(string(hashedBytes), canonical.Redacted) {
		t.Fatalf("hashed bytes missing %s token: %s", canonical.Redacted, hashedBytes)
	}
	want := chain.EntryHashFromCanonical(hashedBytes, chain.GenesisPrevHash, 0)
	if storedHash != want {
		t.Fatalf("entryHash not computed over redacted bytes: got %s want %s", storedHash, want)
	}

	// 3) Negative control: the hash the kernel WOULD have produced over the RAW inbound bytes must
	//    differ — proving redaction actually changed the hashed bytes on the threat path.
	rawHash := chain.EntryHashFromCanonical([]byte(ev), chain.GenesisPrevHash, 0)
	if storedHash == rawHash {
		t.Fatal("entryHash equals the raw-inbound-bytes hash; credential was hashed verbatim (no backstop)")
	}
}

// TestIngestRedactionNoDriftOnHonestPath is the IDEMPOTENT / NO-DRIFT proof: an already-clean event
// (producer already redacted; no secret-shaped substring) must hash BYTE-IDENTICALLY to the inbound
// canonical bytes — RedactCanonicalBytes is a no-op, so the honest-path chain continuity is unchanged.
func TestIngestRedactionNoDriftOnHonestPath(t *testing.T) {
	srv, _ := newTestServer(t)

	clean := `{"action":"call","resource":"db://users","note":"all good"}`
	resp, err := srv.Append(context.Background(), appendReq("S", 0, clean))
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if resp.GetReceipt() == nil {
		t.Fatalf("expected receipt, got error %v", resp.GetError())
	}

	_, storedHash := storedEntry(t, srv)

	// The committed entryHash must equal the hash over the ORIGINAL inbound bytes (no drift).
	want := chain.EntryHashFromCanonical([]byte(clean), chain.GenesisPrevHash, 0)
	if storedHash != want {
		t.Fatalf("honest-path entryHash drifted: got %s want %s (redaction was NOT a no-op)", storedHash, want)
	}
}

// TestIngestRedactionPreservesChainContinuity proves a multi-entry honest chain links identically to
// the pre-fix behaviour: each entryHash equals the hash over the raw inbound bytes with the correct
// prevHash. A backstop that mutated honest bytes would break this linkage.
func TestIngestRedactionPreservesChainContinuity(t *testing.T) {
	srv, _ := newTestServer(t)

	events := []string{`{"a":1}`, `{"b":2}`, `{"c":3}`}
	prev := chain.GenesisPrevHash
	for i, ev := range events {
		resp, err := srv.Append(context.Background(), appendReq("S", uint64(i), ev))
		if err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
		r := resp.GetReceipt()
		if r == nil {
			t.Fatalf("seq %d: expected receipt, got %v", i, resp.GetError())
		}
		want := chain.EntryHashFromCanonical([]byte(ev), prev, i)
		if r.EntryHash != want {
			t.Fatalf("seq %d entryHash drifted from raw-bytes hash: got %s want %s", i, r.EntryHash, want)
		}
		prev = r.EntryHash
	}
}

// TestRedactCanonicalBytesParity asserts the kernel's byte-level backstop matches the Google/Bearer
// shapes added to src/audit/redact.ts (ya29./AIza/Bearer) — these were NOT redacted before this fix.
func TestRedactCanonicalBytesParity(t *testing.T) {
	google := "ya29." + strings.Repeat("Z", 40)
	apiKey := "AIza" + strings.Repeat("B", 35)
	bearer := "Bearer " + strings.Repeat("c", 40)

	for name, secret := range map[string]string{"ya29": google, "AIza": apiKey, "Bearer": bearer} {
		in := []byte(`{"v":"` + secret + `"}`)
		out := canonical.RedactCanonicalBytes(in)
		if strings.Contains(string(out), secret) {
			t.Fatalf("RedactCanonicalBytes did not redact %s shape: %s", name, out)
		}
		if !strings.Contains(string(out), canonical.Redacted) {
			t.Fatalf("RedactCanonicalBytes missing %s token for %s: %s", canonical.Redacted, name, out)
		}
	}
}

// TestRedactCanonicalBytesIdempotentNoop: clean bytes pass through unchanged, and redacting twice
// equals redacting once (idempotent), so re-redaction on a verifier never drifts the hash.
func TestRedactCanonicalBytesIdempotentNoop(t *testing.T) {
	clean := []byte(`{"action":"x","resource":"db://users"}`)
	if got := canonical.RedactCanonicalBytes(clean); string(got) != string(clean) {
		t.Fatalf("clean bytes mutated by RedactCanonicalBytes: %s", got)
	}

	dirty := []byte(`{"v":"sk-` + strings.Repeat("a", 40) + `"}`)
	once := canonical.RedactCanonicalBytes(dirty)
	twice := canonical.RedactCanonicalBytes(once)
	if string(once) != string(twice) {
		t.Fatalf("RedactCanonicalBytes not idempotent: once=%s twice=%s", once, twice)
	}
}
