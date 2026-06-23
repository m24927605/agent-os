// Package signer defines the CheckpointSigner PORT and its in-tree implementations. It exists so the
// kernel PROCESS is STRUCTURALLY unable to hold the raw checkpoint-signing private key: the kernel
// computes the bytes to sign (chain.CheckpointBytes(head, length)) and hands them to a
// CheckpointSigner; it never receives or stores an ed25519.PrivateKey. Two implementations ship:
//
//   - InProcessSigner — today's behavior: wraps an in-process ed25519.PrivateKey (operator-held).
//     Byte-equivalent to chain.SignCheckpoint, so K1/K2/PK1 conformance is unchanged.
//   - CommandSigner — out-of-process: the private key lives behind an external command (argv) and
//     NEVER enters the kernel process; only the command's argv + the obtained public key are held.
//
// ── KMS / HSM / remote-attested adapter contract (for TR2) ──────────────────────────────────────────
//
// A real trust-root-externalized signer (AWS/GCP KMS, an HSM/PKCS#11 token, a TPM/SGX-attested
// service) is just a third CheckpointSigner implementation that satisfies the SAME two-method contract.
// To be a correct drop-in it MUST:
//
//	1. Sign(message []byte) ([]byte, error)
//	     - message is exactly chain.CheckpointBytes(headEntryHash, length) — sign it AS GIVEN
//	       (Ed25519 PureEdDSA, no extra hashing/prefixing; chain.VerifyCheckpoint must accept it).
//	     - return the raw 64-byte Ed25519 signature, or an error. FAIL-CLOSED: on any backend error,
//	       timeout, throttle, permission denial, or a wrong-length result, return an error and NEVER
//	       fabricate, zero-fill, or partially return a signature. The kernel's Checkpoint path treats an
//	       errored signer as "refuse the checkpoint" — never "emit it unsigned".
//	2. Public() ed25519.PublicKey
//	     - the public half ATTESTED by the backend (the key the signature verifies under). It is
//	       obtained once from the external boundary (e.g. KMS GetPublicKey, an HSM cert, an attestation
//	       document) and is the key a third party uses with chain.VerifyCheckpoint.
//
// The defining property — and the reason TR2 (not TR1) establishes operator-unforgeability — is that
// the PRIVATE key NEVER leaves the external boundary: the kernel process holds only a handle (a KMS key
// ARN, a PKCS#11 slot, an attested endpoint) plus the public key. CommandSigner is the in-repo proof
// that this seam is real (the key is out of process); a KMS/HSM adapter makes the boundary
// operator-inaccessible, which depends on the deployment's key protection — that is TR2.
package signer

import "crypto/ed25519"

// CheckpointSigner is the kernel's ONLY interface to a checkpoint signing key. The kernel signs by:
//
//	msg := chain.CheckpointBytes(head, length)
//	raw, err := signer.Sign(msg)          // fail-closed on err
//	sigBase64 := base64.StdEncoding.EncodeToString(raw)
//
// and publishes signer.Public() (as SPKI/PKIX DER) so a third party verifies with
// chain.VerifyCheckpoint. The raw private key is NEVER exposed through this interface — there is no
// method that returns private key material.
type CheckpointSigner interface {
	// Sign returns the raw Ed25519 signature over message (PureEdDSA, message signed as given), or an
	// error. Implementations MUST be fail-closed: never return a fabricated/partial signature on error.
	Sign(message []byte) ([]byte, error)
	// Public returns the Ed25519 public key the signature verifies under.
	Public() ed25519.PublicKey
}
