package verify

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
)

// wellFormedRestore is a complete, authorized RestoreEvent (admin actor, non-brain source, all
// required fields). Shaped as the JSON the chain carries (map[string]any), matching the TS
// RestoreEvent (src/orchestration/restore.ts:41).
func wellFormedRestore() map[string]any {
	return map[string]any{
		"kind":             "system.restore",
		"restorePhase":     "RestoreInitiated",
		"actor":            "admin:alice",
		"sourceId":         "orchestration",
		"targetSnapshotId": "snap-7",
		"targetSequence":   float64(2), // JSON numbers decode to float64
		"divergenceReport": []any{},
	}
}

// TestVerifyRestoreWellFormed: a chain carrying a complete authorized RestoreEvent verifies ok.
func TestVerifyRestoreWellFormed(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	c := buildChain(t, priv, []any{
		map[string]any{"action": "fs:read", "resource": "/a"},
		map[string]any{"action": "fs:read", "resource": "/b"},
		wellFormedRestore(),
	})
	if res := VerifyRestoreSemantics(c); !res.Ok {
		t.Fatalf("want ok for well-formed RestoreEvent, got %+v", res)
	}
}

// TestVerifyRestoreMissingMarker (adversarial): a restore-semantic event missing required fields
// (here: no targetSnapshotId/targetSequence) is an unauthorized state jump → tamper fail.
func TestVerifyRestoreMissingMarker(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	bad := wellFormedRestore()
	delete(bad, "targetSnapshotId")
	delete(bad, "targetSequence")
	c := buildChain(t, priv, []any{
		map[string]any{"action": "fs:read", "resource": "/a"},
		bad,
	})
	res := VerifyRestoreSemantics(c)
	if res.Ok || res.BrokenAt != 1 || !strings.Contains(res.Reason, "missing-restore-marker") {
		t.Fatalf("want broken@1 missing-restore-marker, got %+v", res)
	}
}

// TestVerifyRestoreBrainForbidden (adversarial): brain cannot restore itself (attester!=actor,
// design §44). sourceId == brain → tamper fail even if all other fields are present.
func TestVerifyRestoreBrainForbidden(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	bad := wellFormedRestore()
	bad["sourceId"] = "brain"
	c := buildChain(t, priv, []any{
		map[string]any{"action": "fs:read", "resource": "/a"},
		bad,
	})
	res := VerifyRestoreSemantics(c)
	if res.Ok || res.BrokenAt != 1 || !strings.Contains(res.Reason, "missing-restore-marker") {
		t.Fatalf("want broken@1 (brain may not restore), got %+v", res)
	}
}

// TestVerifyRestoreNoRestore: a chain with no restore events passes the restore semantic check
// trivially (it only constrains restore-semantic entries).
func TestVerifyRestoreNoRestore(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	c := buildChain(t, priv, events3())
	if res := VerifyRestoreSemantics(c); !res.Ok {
		t.Fatalf("want ok for chain with no restore events, got %+v", res)
	}
}

// TestVerifyRestoreDoesNotWeakenLinkage (regression / adversarial): deleting middle entries and
// reconnecting prevHash must STILL be caught by VerifyChain's linkage check — this slice does not
// open a back door for malicious truncation. VerifyChain runs first; restore semantics only add a
// gate on top of an already-linkage-valid chain.
func TestVerifyRestoreDoesNotWeakenLinkage(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	c := buildChain(t, priv, events3())
	// Drop the middle entry but keep originals' sequence fields (attacker truncation attempt).
	c.Entries = []chain.LogEntry{c.Entries[0], c.Entries[2]}
	c.Checkpoint.Length = 2
	if res := VerifyChain(c, pub); res.Ok {
		t.Fatalf("malicious truncation must be caught by VerifyChain linkage, got ok %+v", res)
	}
}
