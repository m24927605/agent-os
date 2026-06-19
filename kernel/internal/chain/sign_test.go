package chain

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

func TestVerifyCheckpointAcceptsTSSignature(t *testing.T) {
	b, err := os.ReadFile("../../testdata/golden-vectors.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var g struct {
		Checkpoint struct {
			HeadEntryHash       string `json:"headEntryHash"`
			Length              int    `json:"length"`
			PublicKeySpkiBase64 string `json:"publicKeySpkiBase64"`
			SignatureBase64     string `json:"signatureBase64"`
		} `json:"checkpoint"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatalf("unmarshal golden: %v", err)
	}
	der, err := base64.StdEncoding.DecodeString(g.Checkpoint.PublicKeySpkiBase64)
	if err != nil {
		t.Fatalf("decode pub: %v", err)
	}
	pubAny, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		t.Fatalf("parse SPKI pub: %v", err)
	}
	pub, ok := pubAny.(ed25519.PublicKey)
	if !ok {
		t.Fatalf("not an ed25519 public key: %T", pubAny)
	}
	if !VerifyCheckpoint(pub, g.Checkpoint.HeadEntryHash, g.Checkpoint.Length, g.Checkpoint.SignatureBase64) {
		t.Error("Go failed to verify a TS-signed checkpoint (cross-language acceptance)")
	}
	if VerifyCheckpoint(pub, g.Checkpoint.HeadEntryHash, g.Checkpoint.Length+1, g.Checkpoint.SignatureBase64) {
		t.Error("verify must fail on a tampered length")
	}
	if VerifyCheckpoint(pub, g.Checkpoint.HeadEntryHash+"x", g.Checkpoint.Length, g.Checkpoint.SignatureBase64) {
		t.Error("verify must fail on a tampered head")
	}
}

func TestSignVerifyRoundTrip(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	sig := SignCheckpoint(priv, "sha256:abc", 3)
	if !VerifyCheckpoint(pub, "sha256:abc", 3, sig) {
		t.Error("round-trip verify failed")
	}
	if VerifyCheckpoint(pub, "sha256:abc", 4, sig) {
		t.Error("verify must fail on a changed length")
	}
}
