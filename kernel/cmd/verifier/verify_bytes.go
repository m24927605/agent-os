package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/verify"
)

// buildVersion is the release tag for this artifact. It is overridable at build time via
// `-ldflags "-X main.buildVersion=<tag>"` (see scripts/build-verifier-release.sh). It is a SEPARATE
// label from internal/version.KernelContractVersion() (the pinned contract version, unchanged) —
// the release tag identifies the produced artifact, not the chain contract. It lives in this
// untagged file so BOTH the native CLI and the WASM entrypoint can read it. Default "dev".
var buildVersion = "dev"

// verifyChainBytes is the pure, IO-free core shared by the native CLI (main.go) and the WASM
// entrypoint (wasm_main.go). It parses a SignedChain JSON + an Ed25519 public key (PEM or DER) and
// delegates the actual recomputation to internal/verify.VerifyChain — the verification logic is NOT
// duplicated here. Fail-closed: any parse/key failure returns a non-Ok VerifyResult (it never
// returns Ok=true for malformed input or a missing key), preserving the verifier's trust semantics
// (kernel/cmd/verifier/main.go:35-38). Both the native and WASM I/O boundaries call this; they only
// differ in how they obtain the bytes and report the result.
func verifyChainBytes(chainJSON, pubKeyPEMorDER []byte) verify.VerifyResult {
	res, inputErr := verifyChainBytesDetailed(chainJSON, pubKeyPEMorDER)
	if inputErr != nil {
		return verify.VerifyResult{Reason: inputErr.Error()}
	}
	return res
}

// verifyChainBytesDetailed is verifyChainBytes with the bad-input signal separated out so the native
// CLI can preserve its exit-code contract (exit 2 = unparseable input / missing-bad key; exit 1 =
// parseable-but-broken chain; exit 0 = intact). inputErr != nil iff the chain JSON or public key
// could not be parsed (a bad-input condition, not a chain break).
func verifyChainBytesDetailed(chainJSON, pubKeyPEMorDER []byte) (verify.VerifyResult, error) {
	pub, err := parseEd25519PublicKey(pubKeyPEMorDER)
	if err != nil {
		return verify.VerifyResult{}, fmt.Errorf("invalid public key: %w", err)
	}
	var sc chain.SignedChain
	if err := json.Unmarshal(chainJSON, &sc); err != nil {
		return verify.VerifyResult{}, fmt.Errorf("error parsing chain JSON: %w", err)
	}
	return verify.VerifyChain(sc, pub), nil
}

// parseEd25519PublicKey decodes a PKIX public key (PEM-wrapped or raw DER) and asserts Ed25519.
// Fail-closed: an empty/short key, or any non-Ed25519 key, is an error.
func parseEd25519PublicKey(data []byte) (ed25519.PublicKey, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("public key is required")
	}
	der := data
	if block, _ := pem.Decode(data); block != nil {
		der = block.Bytes
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("not a PKIX public key: %w", err)
	}
	pub, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("public key is not Ed25519 (%T)", parsed)
	}
	return pub, nil
}
