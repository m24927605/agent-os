package chain

import (
	"crypto/ed25519"
	"encoding/base64"
)

// SignCheckpoint signs CheckpointBytes(headEntryHash, length) with Ed25519, base64-encoded.
// Matches the TS reference (node:crypto sign(null, checkpointBytes(...), privateKey)).
func SignCheckpoint(priv ed25519.PrivateKey, headEntryHash string, length int) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(priv, CheckpointBytes(headEntryHash, length)))
}

// VerifyCheckpoint verifies a base64 Ed25519 signature over CheckpointBytes(headEntryHash, length).
// Fail-closed: any decode/verify failure returns false. Accepts a signature produced by the TS
// reference using the same public key + message (cross-language acceptance).
func VerifyCheckpoint(pub ed25519.PublicKey, headEntryHash string, length int, sigBase64 string) bool {
	sig, err := base64.StdEncoding.DecodeString(sigBase64)
	if err != nil {
		return false
	}
	return ed25519.Verify(pub, CheckpointBytes(headEntryHash, length), sig)
}
