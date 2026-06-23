package server

import (
	"bytes"
	"context"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/ingestpb"
)

// Server-level (gRPC-handler) conformance for the PARTITIONED signed READ-BACK surface (SLICE-PK1).
//
// These tests drive the PartitionedIngest THROUGH the gRPC Checkpoint / ListEntries handlers
// (req.partition_id routing) and prove that each Enterprise tenant can independently verify ITS OWN
// chain: tenant-a's checkpoint signature verifies under the public_key the handler returns for a, and
// is REJECTED under the public_key returned for b (per-tenant attester isolation — THE new proof of
// this slice). They are RED-first: written before PartitionAppendServer.Checkpoint / .ListEntries
// exist (they currently route through UnimplementedAppendServiceServer -> codes.Unimplemented) and
// before PartitionedIngest exposes the per-partition public key + a per-partition ListEntries.
//
// Keys are GenerateKey()'d at runtime (newTestPartitionServer); never read from disk/fixture
// (secret-scan safe). The per-tenant key being held in the kernel process means attester==operator at
// THIS layer (honest ES2a/in-memory limitation; per-tenant key externalization / HSM / KMS = P4).
//
// Non-vacuity (mutations that FLIP each assertion, per spec §6):
//   - (b) per-tenant attester isolation: if both tenants shared one signing key (or the handler
//     returned a's public_key for b), a's signature would verify under b's key -> the isolation
//     assertion RED. Conversely if the handler signed a's checkpoint with b's signer, the
//     verify-under-a assertion RED.
//   - (c) per-tenant ListEntries isolation: if ListEntries read the shared/other tenant's store,
//     a's read-back would contain b's distinct marker -> RED.
//   - (d) cross-tenant head independence: if append to a moved b's head, b's checkpoint would change
//     after a-append -> RED.
//   - (e) empty/unknown partition_id: if empty/unknown fell through to a default/first tenant instead
//     of denying, a checkpoint/read-back would succeed -> the deny assertions RED.

// mustAppend drives the partitioned Append handler and asserts a receipt (a write landed).
func mustAppend(t *testing.T, srv *PartitionAppendServer, partitionID, source string, seq uint64, ev string) {
	t.Helper()
	resp, err := srv.Append(context.Background(), preq(partitionID, source, seq, ev))
	if err != nil {
		t.Fatalf("append %s seq %d: transport error %v", partitionID, seq, err)
	}
	if resp.GetReceipt() == nil {
		t.Fatalf("append %s seq %d must produce a receipt, got error %v", partitionID, seq, resp.GetError())
	}
}

// parsePub (SPKI/PKIX DER -> ed25519.PublicKey, the released-verifier's exact path) is shared with
// checkpoint_signing_test.go in this package.

// (a) tenant-a's checkpoint signature verifies via chain.VerifyCheckpoint using the pubkey PARSED FROM
//     the Checkpoint response's public_key field (a released verifier's exact path).
// (b) PER-TENANT ATTESTER ISOLATION (the new proof): a's signature verified with B's pubkey -> FALSE.
func TestPartitionReadback_PerTenantAttesterIsolation(t *testing.T) {
	srv, _, _ := newTestPartitionServer(t)
	ctx := context.Background()

	mustAppend(t, srv, "a", "S", 0, `{"action":"a-event"}`)
	mustAppend(t, srv, "b", "S", 0, `{"action":"b-event"}`)

	ckA, err := srv.Checkpoint(ctx, &ingestpb.CheckpointRequest{PartitionId: "a"})
	if err != nil {
		t.Fatalf("checkpoint a: %v", err)
	}
	ckB, err := srv.Checkpoint(ctx, &ingestpb.CheckpointRequest{PartitionId: "b"})
	if err != nil {
		t.Fatalf("checkpoint b: %v", err)
	}

	pubA := parsePub(t, ckA.GetPublicKey())
	pubB := parsePub(t, ckB.GetPublicKey())

	// load-bearing fields: head_entry_hash + checkpoint_signature + public_key.
	if ckA.GetCheckpointSignature() == "" {
		t.Fatal("tenant-a checkpoint must carry a signature")
	}
	if ckA.GetHeadEntryHash() == "" {
		t.Fatal("tenant-a checkpoint must carry a head_entry_hash")
	}

	// (a) a's signature verifies under a's OWN pubkey (the verifier reconstructs CheckpointBytes from
	//     the returned head_entry_hash + length).
	if !chain.VerifyCheckpoint(pubA, ckA.GetHeadEntryHash(), 1, ckA.GetCheckpointSignature()) {
		t.Fatal("tenant-a checkpoint must verify under tenant-a's own public key")
	}
	// (b) a's signature must be REJECTED under b's pubkey (per-tenant attester isolation).
	if chain.VerifyCheckpoint(pubB, ckA.GetHeadEntryHash(), 1, ckA.GetCheckpointSignature()) {
		t.Fatal("LEAK: tenant-a checkpoint was accepted under tenant-b's public key (cross-tenant forgeable)")
	}
	// symmetric: b under b verifies, b under a rejects.
	if !chain.VerifyCheckpoint(pubB, ckB.GetHeadEntryHash(), 1, ckB.GetCheckpointSignature()) {
		t.Fatal("tenant-b checkpoint must verify under tenant-b's own public key")
	}
	if chain.VerifyCheckpoint(pubA, ckB.GetHeadEntryHash(), 1, ckB.GetCheckpointSignature()) {
		t.Fatal("LEAK: tenant-b checkpoint was accepted under tenant-a's public key (cross-tenant forgeable)")
	}
	// the two tenants must expose DISTINCT public keys (independent attesters, not a renamed shared key).
	if bytes.Equal(ckA.GetPublicKey(), ckB.GetPublicKey()) {
		t.Fatal("LEAK: tenant-a and tenant-b returned the SAME public key (shared signer = renamed row filter)")
	}
}

// (c) per-tenant ListEntries isolation: ListEntries(a) returns ONLY a's entries (none of b's). Each
//     tenant appends a DISTINCT marker so a cross-tenant read would be detectable.
func TestPartitionReadback_PerTenantListEntriesIsolation(t *testing.T) {
	srv, _, _ := newTestPartitionServer(t)
	ctx := context.Background()

	mustAppend(t, srv, "a", "S", 0, `{"marker":"AAA"}`)
	mustAppend(t, srv, "a", "S", 1, `{"marker":"AAA2"}`)
	mustAppend(t, srv, "b", "S", 0, `{"marker":"BBB"}`)

	respA, err := srv.ListEntries(ctx, &ingestpb.ListEntriesRequest{PartitionId: "a"})
	if err != nil {
		t.Fatalf("listentries a: %v", err)
	}
	if len(respA.GetEntries()) != 2 {
		t.Fatalf("tenant-a read-back must return exactly its own 2 entries, got %d", len(respA.GetEntries()))
	}
	for _, e := range respA.GetEntries() {
		if bytes.Contains(e.GetCanonicalEvent(), []byte("BBB")) {
			t.Fatalf("LEAK: tenant-a read-back contains tenant-b's marker: %s", e.GetCanonicalEvent())
		}
	}

	respB, err := srv.ListEntries(ctx, &ingestpb.ListEntriesRequest{PartitionId: "b"})
	if err != nil {
		t.Fatalf("listentries b: %v", err)
	}
	if len(respB.GetEntries()) != 1 {
		t.Fatalf("tenant-b read-back must return exactly its own 1 entry, got %d", len(respB.GetEntries()))
	}
	for _, e := range respB.GetEntries() {
		if bytes.Contains(e.GetCanonicalEvent(), []byte("AAA")) {
			t.Fatalf("LEAK: tenant-b read-back contains tenant-a's marker: %s", e.GetCanonicalEvent())
		}
	}

	// from_sequence filter applies per-tenant: from_sequence=1 on a returns only the seq-1 entry.
	respAFrom1, err := srv.ListEntries(ctx, &ingestpb.ListEntriesRequest{PartitionId: "a", FromSequence: 1})
	if err != nil {
		t.Fatalf("listentries a from_sequence=1: %v", err)
	}
	if len(respAFrom1.GetEntries()) != 1 || respAFrom1.GetEntries()[0].GetSequence() != 1 {
		t.Fatalf("tenant-a from_sequence=1 must return only its seq-1 entry, got %+v", respAFrom1.GetEntries())
	}
}

// (d) append to a does NOT move b's head/length: b's checkpoint is byte-identical before and after an
//     a-append (cross-tenant head independence, surfaced through the read-back handler).
func TestPartitionReadback_AppendToADoesNotMoveB(t *testing.T) {
	srv, _, _ := newTestPartitionServer(t)
	ctx := context.Background()

	bBefore, err := srv.Checkpoint(ctx, &ingestpb.CheckpointRequest{PartitionId: "b"})
	if err != nil {
		t.Fatalf("checkpoint b (genesis): %v", err)
	}

	mustAppend(t, srv, "a", "S", 0, `{"action":"a-only"}`)

	bAfter, err := srv.Checkpoint(ctx, &ingestpb.CheckpointRequest{PartitionId: "b"})
	if err != nil {
		t.Fatalf("checkpoint b after a-append: %v", err)
	}
	if bAfter.GetHeadEntryHash() != bBefore.GetHeadEntryHash() {
		t.Fatalf("LEAK: tenant-a append moved tenant-b head: before=%q after=%q", bBefore.GetHeadEntryHash(), bAfter.GetHeadEntryHash())
	}
	if bAfter.GetCheckpointSignature() != bBefore.GetCheckpointSignature() {
		t.Fatal("LEAK: tenant-a append changed tenant-b's checkpoint signature")
	}
}

// (e) empty partition_id on Checkpoint AND ListEntries -> fail-closed deny; unknown partition_id ->
//     fail-closed deny (no default tenant). The deny must NOT leak the partition_id value.
func TestPartitionReadback_EmptyAndUnknownDenied(t *testing.T) {
	srv, _, _ := newTestPartitionServer(t)
	ctx := context.Background()

	// empty partition_id -> deny on both read-back RPCs (no default/first tenant).
	if resp, err := srv.Checkpoint(ctx, &ingestpb.CheckpointRequest{PartitionId: ""}); err == nil {
		t.Fatalf("empty partition_id Checkpoint must fail-closed deny, got response %+v", resp)
	}
	if resp, err := srv.ListEntries(ctx, &ingestpb.ListEntriesRequest{PartitionId: ""}); err == nil {
		t.Fatalf("empty partition_id ListEntries must fail-closed deny, got response %+v", resp)
	}

	// unknown partition_id -> deny on both, and must NOT echo the probed value (no enumeration oracle).
	if _, err := srv.Checkpoint(ctx, &ingestpb.CheckpointRequest{PartitionId: "ghost"}); err == nil {
		t.Fatal("unknown partition_id Checkpoint must fail-closed deny")
	} else if leaksValue(err.Error(), "ghost") {
		t.Fatalf("Checkpoint deny leaked the unknown partition_id value: %q", err.Error())
	}
	if _, err := srv.ListEntries(ctx, &ingestpb.ListEntriesRequest{PartitionId: "ghost"}); err == nil {
		t.Fatal("unknown partition_id ListEntries must fail-closed deny")
	} else if leaksValue(err.Error(), "ghost") {
		t.Fatalf("ListEntries deny leaked the unknown partition_id value: %q", err.Error())
	}
}

// leaksValue reports whether the deny text echoes the probed partition_id value (a tenant-enumeration
// oracle). The static deny detail must never embed the requested partition_id.
func leaksValue(detail, probed string) bool {
	return bytes.Contains([]byte(detail), []byte(probed))
}
