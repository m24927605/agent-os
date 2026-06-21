//go:build js && wasm

// WASM entrypoint for the standalone verifier. This is ONLY an I/O boundary: it exposes a single
// JS-callable function `agentosVerifyChain(chainJSON, pubKey)` that delegates straight to
// verifyChainBytes (verify_bytes.go) — it contains ZERO verification logic and does not duplicate
// internal/verify. It runs in a browser / wasm host so an auditor can verify a chain fully offline
// without trusting our platform or toolchain. Trust semantics are unchanged: the public key is
// supplied by the auditor, and the result is fail-closed (a malformed chain / missing key returns
// ok=false; it never reports ok=true unless the chain fully verifies).
package main

import (
	"syscall/js"
)

func main() {
	js.Global().Set("agentosVerifyChain", js.FuncOf(verifyChainJS))
	js.Global().Set("agentosVerifierVersion", js.ValueOf(buildVersion))
	// Block forever so the registered functions stay callable from JS.
	select {}
}

// verifyChainJS is the JS-facing shim. args[0] = chain JSON (string), args[1] = public key (PEM/DER
// string). Returns a plain object mirroring verify.VerifyResult: {ok, length, brokenAt, reason}.
// Fail-closed: any missing/wrong-typed argument yields ok=false with a reason — never ok=true.
func verifyChainJS(this js.Value, args []js.Value) any {
	if len(args) < 2 || args[0].Type() != js.TypeString || args[1].Type() != js.TypeString {
		return map[string]any{
			"ok":       false,
			"length":   0,
			"brokenAt": 0,
			"reason":   "agentosVerifyChain(chainJSON, pubKey): two string arguments are required",
		}
	}
	res := verifyChainBytes([]byte(args[0].String()), []byte(args[1].String()))
	return map[string]any{
		"ok":       res.Ok,
		"length":   res.Length,
		"brokenAt": res.BrokenAt,
		"reason":   res.Reason,
	}
}
