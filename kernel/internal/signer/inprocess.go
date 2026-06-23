package signer

import "crypto/ed25519"

// InProcessSigner is the today/fallback CheckpointSigner: it wraps an in-process ed25519.PrivateKey.
// Sign is exactly ed25519.Sign(priv, msg) (PureEdDSA), so a checkpoint signed via this port is
// byte-identical to chain.SignCheckpoint(priv, head, length) once base64-encoded — K1/K2/PK1
// conformance is unchanged.
//
// HONEST BOUNDARY: with InProcessSigner the private key lives in the KERNEL PROCESS (operator-held —
// generated in-memory or loaded from an operator file). attester != actor holds to the PROCESS
// BOUNDARY (the control plane cannot sign), but the operator who runs the kernel CAN reach the key.
// Real operator-inaccessible externalization (HSM/KMS/remote attestation) is TR2 / deployment.
type InProcessSigner struct {
	priv ed25519.PrivateKey
}

// NewInProcessSigner wraps a raw Ed25519 private key as a CheckpointSigner. Callers that previously
// held an ed25519.PrivateKey field now hold this port instead, so the raw key is no longer a
// server/partition field.
func NewInProcessSigner(priv ed25519.PrivateKey) *InProcessSigner {
	return &InProcessSigner{priv: priv}
}

// Sign signs message with the in-process key (PureEdDSA). It returns an error (fail-closed) if the
// wrapped key is not a valid Ed25519 private key rather than letting ed25519.Sign panic.
func (s *InProcessSigner) Sign(message []byte) ([]byte, error) {
	if len(s.priv) != ed25519.PrivateKeySize {
		return nil, errInvalidInProcessKey
	}
	return ed25519.Sign(s.priv, message), nil
}

// Public returns the public half of the wrapped key.
func (s *InProcessSigner) Public() ed25519.PublicKey {
	if len(s.priv) != ed25519.PrivateKeySize {
		return nil
	}
	return s.priv.Public().(ed25519.PublicKey)
}

type inProcessError string

func (e inProcessError) Error() string { return string(e) }

const errInvalidInProcessKey inProcessError = "signer: in-process key is not a valid Ed25519 private key"
