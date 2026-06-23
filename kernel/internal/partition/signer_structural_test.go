package partition

import (
	"crypto/ed25519"
	"reflect"
	"testing"

	"github.com/agent-os/kernel/internal/signer"
)

// SLICE-TR1 STRUCTURAL (partition / PK1): a per-tenant partition must be structurally unable to hold
// the raw signing key — both the public config (PartitionConfig.Signer) and the internal state
// (partitionState.signer) must be signer.CheckpointSigner (the port), NOT ed25519.PrivateKey.
//
// (c.partition) Mutation: keep `Signer ed25519.PrivateKey` / `signer ed25519.PrivateKey` -> this RED.
func TestPartitionSignerFieldsArePort(t *testing.T) {
	port := reflect.TypeOf((*signer.CheckpointSigner)(nil)).Elem()
	rawKey := reflect.TypeOf(ed25519.PrivateKey(nil))

	cfgField, ok := reflect.TypeOf(PartitionConfig{}).FieldByName("Signer")
	if !ok {
		t.Fatal("PartitionConfig has no 'Signer' field")
	}
	if cfgField.Type == rawKey {
		t.Fatal("PartitionConfig.Signer is ed25519.PrivateKey — a partition still structurally holds the raw key")
	}
	if cfgField.Type != port {
		t.Fatalf("PartitionConfig.Signer must be signer.CheckpointSigner (the port), got %s", cfgField.Type)
	}

	stField, ok := reflect.TypeOf(partitionState{}).FieldByName("signer")
	if !ok {
		t.Fatal("partitionState has no 'signer' field")
	}
	if stField.Type == rawKey {
		t.Fatal("partitionState.signer is ed25519.PrivateKey — a partition still structurally holds the raw key")
	}
	if stField.Type != port {
		t.Fatalf("partitionState.signer must be signer.CheckpointSigner (the port), got %s", stField.Type)
	}
}
