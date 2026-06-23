package server

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/client"
	"github.com/agent-os/kernel/internal/ingestpb"
	"github.com/agent-os/kernel/internal/store"
)

// newSignedTestServer builds a kernel server that holds an Ed25519 signing key (via WithSigner) and
// returns the matching public key for verification. This is the K1 wiring: the kernel (attester
// process) signs its own checkpoint; nobody else holds the key.
func newSignedTestServer(t *testing.T) (*IngestServer, ed25519.PublicKey) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "k.wal"))
	if err != nil {
		t.Fatal(err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	srv, err := NewIngestServer(st, &auditSpy{}, WithSigner(priv))
	if err != nil {
		t.Fatal(err)
	}
	return srv, pub
}

// parsePub recovers the Ed25519 public key a third party would use from the read-back public_key
// (SPKI/PKIX DER), exactly as the released verifier would.
func parsePub(t *testing.T, der []byte) ed25519.PublicKey {
	t.Helper()
	if len(der) == 0 {
		t.Fatal("public_key is empty — read-back exposed no kernel key (UNSIGNED)")
	}
	anyPub, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		t.Fatalf("parse public_key PKIX DER: %v", err)
	}
	pub, ok := anyPub.(ed25519.PublicKey)
	if !ok {
		t.Fatalf("public_key is not Ed25519: %T", anyPub)
	}
	return pub
}

// (a) After some Appends, Checkpoint() returns a checkpoint_signature that PASSES VerifyCheckpoint,
// using the public key parsed from the read-back public_key. length = entry count (here 4).
func TestCheckpointSignatureVerifies(t *testing.T) {
	srv, _ := newSignedTestServer(t)
	const n = 4
	for i := uint64(0); i < n; i++ {
		if _, err := srv.Append(context.Background(), appendReq("S", i, `{"i":`+itoa(i)+`}`)); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}

	cp, err := srv.Checkpoint(context.Background(), &ingestpb.CheckpointRequest{})
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	if cp.GetCheckpointSignature() == "" {
		t.Fatal("checkpoint_signature is empty — checkpoint exposed UNSIGNED")
	}
	pub := parsePub(t, cp.GetPublicKey())

	if !chain.VerifyCheckpoint(pub, cp.GetHeadEntryHash(), n, cp.GetCheckpointSignature()) {
		t.Fatal("checkpoint_signature did NOT verify over CheckpointBytes(head_entry_hash, length)")
	}
}

// (b) NON-VACUITY / TAMPER: verifying the same signature against a DIFFERENT head_entry_hash or a
// DIFFERENT length must FAIL. (Mutation that flips this RED: sign the wrong bytes, e.g. a constant
// head/length — then a tampered head would still "verify" because the signature never bound the head.)
func TestCheckpointSignatureTamperFails(t *testing.T) {
	srv, _ := newSignedTestServer(t)
	const n = 3
	for i := uint64(0); i < n; i++ {
		if _, err := srv.Append(context.Background(), appendReq("S", i, `{}`)); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	cp, err := srv.Checkpoint(context.Background(), &ingestpb.CheckpointRequest{})
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	pub := parsePub(t, cp.GetPublicKey())

	// sanity: the honest tuple verifies (otherwise the negatives below are vacuous).
	if !chain.VerifyCheckpoint(pub, cp.GetHeadEntryHash(), n, cp.GetCheckpointSignature()) {
		t.Fatal("precondition: honest checkpoint must verify")
	}

	// tampered head_entry_hash -> must fail
	tamperedHead := "sha256:" + "deadbeef" + cp.GetHeadEntryHash()[len("sha256:deadbeef"):]
	if tamperedHead == cp.GetHeadEntryHash() {
		t.Fatal("test bug: tampered head equals real head")
	}
	if chain.VerifyCheckpoint(pub, tamperedHead, n, cp.GetCheckpointSignature()) {
		t.Fatal("VERIFY ACCEPTED A TAMPERED head_entry_hash — signature does not bind the head")
	}

	// tampered length -> must fail
	if chain.VerifyCheckpoint(pub, cp.GetHeadEntryHash(), n+1, cp.GetCheckpointSignature()) {
		t.Fatal("VERIFY ACCEPTED A TAMPERED length — signature does not bind the length")
	}
}

// (c) GENESIS: the empty-log checkpoint also signs and verifies (length 0, head == genesis).
func TestCheckpointGenesisSignsAndVerifies(t *testing.T) {
	srv, _ := newSignedTestServer(t)
	cp, err := srv.Checkpoint(context.Background(), &ingestpb.CheckpointRequest{})
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	if cp.GetCheckpointSignature() == "" {
		t.Fatal("genesis checkpoint_signature is empty — UNSIGNED genesis")
	}
	if cp.GetHeadEntryHash() != genesisHash {
		t.Fatalf("genesis head %q != genesis hash", cp.GetHeadEntryHash())
	}
	pub := parsePub(t, cp.GetPublicKey())
	if !chain.VerifyCheckpoint(pub, cp.GetHeadEntryHash(), 0, cp.GetCheckpointSignature()) {
		t.Fatal("genesis checkpoint_signature did NOT verify (length 0)")
	}
}

// (d) FAIL-CLOSED: a server constructed WITHOUT a signer must NEVER emit an empty/unsigned
// checkpoint_signature silently — it either refuses construction or its Checkpoint errors.
// (Mutation that flips this RED: let an unsigned server return CheckpointResponse with an empty
// signature instead of failing closed.)
func TestCheckpointNoSignerFailsClosed(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "k.wal"))
	if err != nil {
		t.Fatal(err)
	}
	srv, ctorErr := NewIngestServer(st, &auditSpy{}) // no WithSigner
	if ctorErr != nil {
		return // refused construction -> fail-closed, acceptable
	}
	// constructed -> Checkpoint MUST error, never return an unsigned checkpoint.
	cp, err := srv.Checkpoint(context.Background(), &ingestpb.CheckpointRequest{})
	if err == nil {
		t.Fatalf("no-signer Checkpoint must fail closed, got response: %+v", cp)
	}
	if cp != nil {
		t.Fatalf("no-signer Checkpoint must NOT return a (silently unsigned) response, got: %+v", cp)
	}
}

// (e) ATTESTER != ACTOR: the append-only control-plane client must expose NO signing API and hold no
// key — signing is server-side only. Asserted STRUCTURALLY: the client interface has only Append.
func TestControlPlaneClientHasNoSigningAPI(t *testing.T) {
	typ := reflect.TypeOf((*client.AppendOnlyClient)(nil)).Elem()
	if typ.NumMethod() != 1 {
		var names []string
		for i := 0; i < typ.NumMethod(); i++ {
			names = append(names, typ.Method(i).Name)
		}
		t.Fatalf("AppendOnlyClient must expose exactly one method (Append); got %v", names)
	}
	if m := typ.Method(0); m.Name != "Append" {
		t.Fatalf("AppendOnlyClient sole method must be Append, got %q", m.Name)
	}
	// no signing/key surface anywhere on the client contract or its inputs.
	for _, banned := range []string{"Sign", "Checkpoint", "Key", "PrivateKey", "Signer", "Public"} {
		if _, ok := typ.MethodByName(banned); ok {
			t.Fatalf("control plane client must NOT expose %q — attester != actor (control plane holds no key)", banned)
		}
	}
}
