// Command verifier is the standalone evidence-chain verifier: read a SignedChain JSON + an Ed25519
// public key, recompute + verify, and exit 0 (intact) or non-zero (any break / unparseable input /
// missing key). It depends only on internal/verify + internal/chain — never on the producer (log),
// so an auditor can trust this small binary instead of our platform. Fail-closed: it never exits 0
// unless the chain fully verifies.
package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/verify"
)

func main() {
	os.Exit(verifyMain(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// verifyMain is the testable entrypoint. Returns the process exit code.
func verifyMain(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("verifier", flag.ContinueOnError)
	fs.SetOutput(stderr)
	chainPath := fs.String("chain", "", "path to SignedChain JSON (default: stdin)")
	pubPath := fs.String("pubkey", "", "path to Ed25519 public key (PEM or DER)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *pubPath == "" {
		fmt.Fprintln(stderr, "error: --pubkey is required")
		return 2
	}

	var raw []byte
	var err error
	if *chainPath != "" {
		raw, err = os.ReadFile(*chainPath)
	} else {
		raw, err = io.ReadAll(stdin)
	}
	if err != nil {
		fmt.Fprintf(stderr, "error reading chain: %v\n", err)
		return 2
	}

	var sc chain.SignedChain
	if err := json.Unmarshal(raw, &sc); err != nil {
		fmt.Fprintf(stderr, "error parsing chain JSON: %v\n", err)
		return 2
	}

	pub, err := loadEd25519PublicKey(*pubPath)
	if err != nil {
		fmt.Fprintf(stderr, "error loading public key: %v\n", err)
		return 2
	}

	res := verify.VerifyChain(sc, pub)
	if res.Ok {
		fmt.Fprintf(stdout, "ok length=%d\n", res.Length)
		return 0
	}
	fmt.Fprintf(stderr, "broken at %d: %s\n", res.BrokenAt, res.Reason)
	return 1
}

// loadEd25519PublicKey reads a PKIX public key (PEM-wrapped or raw DER) and asserts it is Ed25519.
func loadEd25519PublicKey(path string) (ed25519.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
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
