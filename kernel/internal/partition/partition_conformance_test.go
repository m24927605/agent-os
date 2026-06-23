package partition

import (
	"crypto/ed25519"
	"crypto/rand"
	"path/filepath"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/signer"
	"github.com/agent-os/kernel/internal/store"
)

// Release-blocking cross-tenant conformance (Go plane) — R8-S6.
//
// This file re-proves the R8-S3 per-tenant kernel-partition isolation invariants as a dedicated,
// release-blocking conformance gate (wired into `pnpm run verify` via the `verify:cross-tenant`
// sub-gate, which selects the `Conformance` test prefix). It introduces NO new mechanism — it only
// re-asserts, following the existing wrong-key-must-reject shape of
// conformance/go_verifies_ts_test.go:146-151, that:
//
//	(A) appending to tenant A never moves tenant B's chain head (chains do not entangle), and
//	(B) a checkpoint signed by tenant A's Ed25519 key is REJECTED under tenant B's public key
//	    (cross-tenant cryptographic unforgeability, fail-closed).
//
// The "RED" for this gate slice is demonstrated out-of-band per the spec: injecting a leak mutation
// into partition.go (e.g. two tenants sharing one head, or one shared signer) flips one of these
// assertions to fail and drives the Go gate to exit != 0.
//
// Keys are GenerateKey()'d at runtime here — never read from disk/fixture (secret-scan safe), and
// these tests use only the package's own exported Append/Checkpoint surface plus chain.Verify.

// confPartition wires two independent tenants (a, b), each with its own durable store + runtime
// Ed25519 key, returning the per-tenant public keys for verification.
func confPartition(t *testing.T) (*PartitionedIngest, map[string]ed25519.PublicKey) {
	t.Helper()
	pubs := map[string]ed25519.PublicKey{}
	cfg := map[string]PartitionConfig{}
	for _, id := range []string{"a", "b"} {
		st, err := store.Open(filepath.Join(t.TempDir(), id+".wal"))
		if err != nil {
			t.Fatalf("open store %s: %v", id, err)
		}
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatalf("genkey %s: %v", id, err)
		}
		pubs[id] = pub
		cfg[id] = PartitionConfig{Store: st, Signer: signer.NewInProcessSigner(priv)}
	}
	p, err := NewPartitionedIngest(cfg)
	if err != nil {
		t.Fatalf("NewPartitionedIngest: %v", err)
	}
	return p, pubs
}

// TestConformanceChainsDoNotEntangle: appending to tenant A must NOT move tenant B's head, and vice
// versa. A leak (shared head) would make B's checkpoint advance off A's append => this fails.
func TestConformanceChainsDoNotEntangle(t *testing.T) {
	p, _ := confPartition(t)

	bBefore, err := p.Checkpoint("b")
	if err != nil {
		t.Fatalf("checkpoint b (genesis): %v", err)
	}

	resp, err := p.Append("a", req("S", 0, `{"action":"x"}`))
	if err != nil {
		t.Fatalf("append a: %v", err)
	}
	if resp.GetReceipt() == nil {
		t.Fatalf("tenant-a append should produce a receipt, got %v", resp.GetError())
	}

	bAfter, err := p.Checkpoint("b")
	if err != nil {
		t.Fatalf("checkpoint b after a-append: %v", err)
	}
	if bAfter.HeadEntryHash != bBefore.HeadEntryHash || bAfter.Length != bBefore.Length {
		t.Fatalf("LEAK: tenant-a append moved tenant-b head: before=%+v after=%+v", bBefore, bAfter)
	}
}

// TestConformanceCrossTenantWrongKeyRejected: tenant A's checkpoint verifies under A's key (true)
// and is REJECTED under tenant B's key (false). A leak (shared signing key) would make B's key
// verify A's checkpoint => this fails. Mirrors go_verifies_ts_test.go:146-151.
func TestConformanceCrossTenantWrongKeyRejected(t *testing.T) {
	p, pubs := confPartition(t)
	if _, err := p.Append("a", req("S", 0, `{"action":"x"}`)); err != nil {
		t.Fatalf("append a: %v", err)
	}
	ck, err := p.Checkpoint("a")
	if err != nil {
		t.Fatalf("checkpoint a: %v", err)
	}
	if !chain.VerifyCheckpoint(pubs["a"], ck.HeadEntryHash, ck.Length, ck.Signature) {
		t.Fatal("tenant-a checkpoint must verify under tenant-a's own public key")
	}
	if chain.VerifyCheckpoint(pubs["b"], ck.HeadEntryHash, ck.Length, ck.Signature) {
		t.Fatal("LEAK: tenant-a checkpoint was accepted under tenant-b's key (cross-tenant forgeable)")
	}
	// Symmetric direction (R8 IV MINOR-2 hardening): tenant B's checkpoint verifies under B's key
	// and is REJECTED under tenant A's key. The one-directional A->B check above misses a
	// "every tenant adopts tenant-A's signer" forgery (B verifiable under A); this closes that gap.
	if _, err := p.Append("b", req("S", 0, `{"action":"y"}`)); err != nil {
		t.Fatalf("append b: %v", err)
	}
	ckB, err := p.Checkpoint("b")
	if err != nil {
		t.Fatalf("checkpoint b: %v", err)
	}
	if !chain.VerifyCheckpoint(pubs["b"], ckB.HeadEntryHash, ckB.Length, ckB.Signature) {
		t.Fatal("tenant-b checkpoint must verify under tenant-b's own public key")
	}
	if chain.VerifyCheckpoint(pubs["a"], ckB.HeadEntryHash, ckB.Length, ckB.Signature) {
		t.Fatal("LEAK: tenant-b checkpoint was accepted under tenant-a's key (cross-tenant forgeable)")
	}
}
