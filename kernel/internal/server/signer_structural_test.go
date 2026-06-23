package server

import (
	"context"
	"crypto/ed25519"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/ingestpb"
	"github.com/agent-os/kernel/internal/signer"
	"github.com/agent-os/kernel/internal/store"
)

// SLICE-TR1 STRUCTURAL: the kernel PROCESS must be structurally unable to hold the raw signing key.
//
// (c.1) IngestServer.signer's declared type is signer.CheckpointSigner (an interface), NOT
// ed25519.PrivateKey. With raw key material removed as a field, the server CANNOT touch private bytes;
// it can only call the port. (Mutation: keep `signer ed25519.PrivateKey` as the field -> this RED.)
func TestIngestServerSignerFieldIsPort(t *testing.T) {
	f, ok := reflect.TypeOf(IngestServer{}).FieldByName("signer")
	if !ok {
		t.Fatal("IngestServer has no 'signer' field")
	}
	want := reflect.TypeOf((*signer.CheckpointSigner)(nil)).Elem()
	if f.Type != want {
		t.Fatalf("IngestServer.signer must be signer.CheckpointSigner (the port), got %s — the kernel process must NOT hold a raw ed25519.PrivateKey field", f.Type)
	}
	if f.Type == reflect.TypeOf(ed25519.PrivateKey(nil)) {
		t.Fatal("IngestServer.signer is ed25519.PrivateKey — the kernel process still structurally holds the raw key")
	}
}

// (c.2) The kernel signs via the port only: Checkpoint calls Sign exactly once and Public for the
// read-back, and NEVER reaches behind the interface to raw key bytes. (Mutation: Checkpoint reads a
// raw key field instead of calling the port -> signCalls stays 0 -> this RED.)
func TestCheckpointUsesPortOnly(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "k.wal"))
	if err != nil {
		t.Fatal(err)
	}
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	spy := &portSpy{inner: signer.NewInProcessSigner(priv)}
	srv, err := NewIngestServer(st, &auditSpy{}, WithSigner(spy))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := srv.Append(context.Background(), appendReq("S", 0, `{}`)); err != nil {
		t.Fatalf("append: %v", err)
	}
	cp, err := srv.Checkpoint(context.Background(), &ingestpb.CheckpointRequest{})
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	if spy.signCalls != 1 {
		t.Fatalf("Checkpoint must sign EXACTLY via the port's Sign (got %d calls); it must not read raw key bytes", spy.signCalls)
	}
	if spy.pubCalls < 1 {
		t.Fatal("Checkpoint must obtain the public key via the port's Public()")
	}
	if !chain.VerifyCheckpoint(pub, cp.GetHeadEntryHash(), 1, cp.GetCheckpointSignature()) {
		t.Fatal("port-signed checkpoint did not verify")
	}
}

// portSpy is a CheckpointSigner that only exposes Sign/Public and counts calls — proof the kernel
// holds NO raw key, only the interface.
type portSpy struct {
	inner     signer.CheckpointSigner
	signCalls int
	pubCalls  int
}

func (p *portSpy) Sign(message []byte) ([]byte, error) {
	p.signCalls++
	return p.inner.Sign(message)
}

func (p *portSpy) Public() ed25519.PublicKey {
	p.pubCalls++
	return p.inner.Public()
}
