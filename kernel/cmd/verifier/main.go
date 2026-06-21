//go:build !(js && wasm)

// Command verifier is the standalone evidence-chain verifier: read a SignedChain JSON + an Ed25519
// public key, recompute + verify, and exit 0 (intact) or non-zero (any break / unparseable input /
// missing key). It depends only on internal/verify + internal/chain — never on the producer (log),
// so an auditor can trust this small binary instead of our platform. Fail-closed: it never exits 0
// unless the chain fully verifies.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
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
	showVersion := fs.Bool("version", false, "print the verifier release version and exit")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *showVersion {
		fmt.Fprintln(stdout, buildVersion)
		return 0
	}
	if *pubPath == "" {
		fmt.Fprintln(stderr, "error: --pubkey is required")
		return 2
	}

	var chainBytes []byte
	var err error
	if *chainPath != "" {
		chainBytes, err = os.ReadFile(*chainPath)
	} else {
		chainBytes, err = io.ReadAll(stdin)
	}
	if err != nil {
		fmt.Fprintf(stderr, "error reading chain: %v\n", err)
		return 2
	}

	pubBytes, err := os.ReadFile(*pubPath)
	if err != nil {
		fmt.Fprintf(stderr, "error reading public key: %v\n", err)
		return 2
	}

	res, inputErr := verifyChainBytesDetailed(chainBytes, pubBytes)
	if inputErr != nil {
		fmt.Fprintf(stderr, "error: %v\n", inputErr)
		return 2
	}
	if res.Ok {
		fmt.Fprintf(stdout, "ok length=%d\n", res.Length)
		return 0
	}
	fmt.Fprintf(stderr, "broken at %d: %s\n", res.BrokenAt, res.Reason)
	return 1
}
