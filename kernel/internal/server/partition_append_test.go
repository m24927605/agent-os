package server

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"path/filepath"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/ingestpb"
	"github.com/agent-os/kernel/internal/partition"
	"github.com/agent-os/kernel/internal/signer"
	"github.com/agent-os/kernel/internal/store"
)

// Server-level (gRPC-handler) conformance for the PARTITIONED AppendService adapter (SLICE-ES2a).
//
// These tests drive the PartitionedIngest THROUGH the gRPC Append handler (req.partition_id routing),
// mirroring the per-tenant isolation assertions of internal/partition/partition_conformance_test.go
// but proven at the live server boundary. They are RED-first: written before
// partition_append.go (NewPartitionAppendServer) exists and before the proto carried partition_id —
// so the package does not compile until contract + adapter land.
//
// Keys are GenerateKey()'d at runtime here — never read from disk/fixture (secret-scan safe). The
// in-memory per-tenant key means attester==operator at this layer (honest ES2a limitation; real
// per-tenant key provision / KMS / root-trust externalization is P4).
//
// Non-vacuity (mutation that flips each assertion, per spec §6):
//   - (a)/(b) isolation: if the adapter (or PartitionedIngest) shared one head across tenants,
//     appending to a would advance b's checkpoint -> TestPartitionAppend_PerTenantIndependent RED.
//   - (c) empty partition_id: if empty fell through to a default/first partition instead of denying,
//     a write would land + the receipt assertion -> TestPartitionAppend_EmptyPartitionDenied RED.
//   - (d) unknown partition_id: if unknown auto-created a tenant instead of fail-closed deny, the
//     "no write, no receipt" assertion -> TestPartitionAppend_UnknownPartitionDenied RED.
//   - (e) wrong-key verify: if tenants shared one signing key, a's checkpoint would verify under b's
//     key -> TestPartitionAppend_PerTenantSigner RED.

// newTestPartitionServer wires the partitioned gRPC adapter over a PartitionedIngest with two tenants
// (a, b), each with its OWN durable store + runtime Ed25519 key, returning the adapter, the underlying
// PartitionedIngest (for direct read-back of per-tenant checkpoints), and the per-tenant public keys.
func newTestPartitionServer(t *testing.T) (*PartitionAppendServer, *partition.PartitionedIngest, map[string]ed25519.PublicKey) {
	t.Helper()
	pubs := map[string]ed25519.PublicKey{}
	cfg := map[string]partition.PartitionConfig{}
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
		cfg[id] = partition.PartitionConfig{Store: st, Signer: signer.NewInProcessSigner(priv)}
	}
	pi, err := partition.NewPartitionedIngest(cfg)
	if err != nil {
		t.Fatalf("NewPartitionedIngest: %v", err)
	}
	return NewPartitionAppendServer(pi), pi, pubs
}

// preq builds an AppendRequest carrying partition_id so routing happens at the gRPC handler.
func preq(partitionID, source string, seq uint64, ev string) *ingestpb.AppendRequest {
	return &ingestpb.AppendRequest{
		PartitionId:    partitionID,
		SourceId:       source,
		Sequence:       seq,
		CanonicalEvent: []byte(ev),
	}
}

// (a) per-tenant sequence independence: the SAME source_id at seq 0 succeeds in BOTH a and b — no
//     cross-tenant gap/replay. If they shared one per-source next-seq, b's seq-0 append would be
//     refused as a replay.
// (b) per-tenant head independence: after appending to a, b's checkpoint is UNCHANGED (genesis),
//     then b accepts its own seq-0 append independently.
func TestPartitionAppend_PerTenantIndependent(t *testing.T) {
	srv, pi, _ := newTestPartitionServer(t)
	ctx := context.Background()

	bBefore, err := pi.Checkpoint("b")
	if err != nil {
		t.Fatalf("checkpoint b (genesis): %v", err)
	}

	respA, err := srv.Append(ctx, preq("a", "S", 0, `{"action":"x"}`))
	if err != nil {
		t.Fatalf("append a: %v", err)
	}
	if respA.GetReceipt() == nil {
		t.Fatalf("tenant-a seq-0 append must produce a receipt, got error %v", respA.GetError())
	}

	// (b) appending to a must NOT move b's head.
	bAfterA, err := pi.Checkpoint("b")
	if err != nil {
		t.Fatalf("checkpoint b after a-append: %v", err)
	}
	if bAfterA.HeadEntryHash != bBefore.HeadEntryHash || bAfterA.Length != bBefore.Length {
		t.Fatalf("LEAK: tenant-a append moved tenant-b head: before=%+v after=%+v", bBefore, bAfterA)
	}

	// (a) the SAME source_id at seq 0 succeeds in b too (independent sequence space — not a replay).
	respB, err := srv.Append(ctx, preq("b", "S", 0, `{"action":"y"}`))
	if err != nil {
		t.Fatalf("append b: %v", err)
	}
	if respB.GetReceipt() == nil {
		t.Fatalf("tenant-b seq-0 append (same source_id as a) must succeed independently, got error %v", respB.GetError())
	}

	// b's head moved exactly once now; a's head is unaffected by b's append.
	bAfterB, err := pi.Checkpoint("b")
	if err != nil {
		t.Fatalf("checkpoint b after b-append: %v", err)
	}
	if bAfterB.Length != bBefore.Length+1 {
		t.Fatalf("tenant-b should have exactly 1 entry after its own append, got length=%d", bAfterB.Length)
	}
}

// (c) empty partition_id -> deny (MALFORMED), and NO write lands in any tenant.
func TestPartitionAppend_EmptyPartitionDenied(t *testing.T) {
	srv, pi, _ := newTestPartitionServer(t)
	ctx := context.Background()

	aBefore, err := pi.Checkpoint("a")
	if err != nil {
		t.Fatalf("checkpoint a (genesis): %v", err)
	}

	resp, err := srv.Append(ctx, preq("", "S", 0, `{"action":"x"}`))
	if err != nil {
		t.Fatalf("empty partition_id must be a typed deny, not a transport error: %v", err)
	}
	if resp.GetReceipt() != nil {
		t.Fatalf("empty partition_id must NOT produce a receipt (fail-closed), got %+v", resp.GetReceipt())
	}
	if resp.GetError() == nil || resp.GetError().GetCode() != ingestpb.AppendError_MALFORMED {
		t.Fatalf("empty partition_id must deny MALFORMED, got %v", resp.GetError())
	}

	// no write may have landed anywhere.
	aAfter, err := pi.Checkpoint("a")
	if err != nil {
		t.Fatalf("checkpoint a after empty deny: %v", err)
	}
	if aAfter.HeadEntryHash != aBefore.HeadEntryHash || aAfter.Length != aBefore.Length {
		t.Fatalf("empty partition_id deny must not move any tenant head: before=%+v after=%+v", aBefore, aAfter)
	}
}

// (d) unknown partition_id -> fail-closed deny, NO write, NO default tenant created.
func TestPartitionAppend_UnknownPartitionDenied(t *testing.T) {
	srv, pi, _ := newTestPartitionServer(t)
	ctx := context.Background()

	resp, err := srv.Append(ctx, preq("ghost", "S", 0, `{"action":"x"}`))
	if err != nil {
		t.Fatalf("unknown partition_id must be a typed deny, not a transport error: %v", err)
	}
	if resp.GetReceipt() != nil {
		t.Fatalf("unknown partition_id must NOT produce a receipt (fail-closed), got %+v", resp.GetReceipt())
	}
	if resp.GetError() == nil {
		t.Fatalf("unknown partition_id must produce a typed deny error")
	}
	// fail-closed: the unknown partition was NOT materialized (no default tenant). A subsequent
	// checkpoint on it must still be unknown (error), proving no chain was created.
	if _, err := pi.Checkpoint("ghost"); err == nil {
		t.Fatalf("unknown partition_id must not have been created (fail-closed); checkpoint should still error")
	}
}

// (e) per-tenant signer: a's checkpoint verifies under a's key but is REJECTED under b's key. Mirrors
//     partition_conformance_test.go's wrong-key-must-reject shape, proven through the server adapter.
func TestPartitionAppend_PerTenantSigner(t *testing.T) {
	srv, pi, pubs := newTestPartitionServer(t)
	ctx := context.Background()

	if resp, err := srv.Append(ctx, preq("a", "S", 0, `{"action":"x"}`)); err != nil {
		t.Fatalf("append a: %v", err)
	} else if resp.GetReceipt() == nil {
		t.Fatalf("append a must succeed, got error %v", resp.GetError())
	}

	ck, err := pi.Checkpoint("a")
	if err != nil {
		t.Fatalf("checkpoint a: %v", err)
	}
	if !chain.VerifyCheckpoint(pubs["a"], ck.HeadEntryHash, ck.Length, ck.Signature) {
		t.Fatal("tenant-a checkpoint must verify under tenant-a's own public key")
	}
	if chain.VerifyCheckpoint(pubs["b"], ck.HeadEntryHash, ck.Length, ck.Signature) {
		t.Fatal("LEAK: tenant-a checkpoint was accepted under tenant-b's key (cross-tenant forgeable)")
	}
}
