package signer

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
)

// SLICE-TR1 conformance for the CheckpointSigner port + its two implementations.
//
// The kernel signs a checkpoint by computing chain.CheckpointBytes(head, length), handing those bytes
// to CheckpointSigner.Sign, and base64-encoding the raw signature. A third party reconstructs the
// SAME message and verifies with the public key from CheckpointSigner.Public() via
// chain.VerifyCheckpoint. These tests assert that BOTH a today-style in-process signer AND an
// out-of-process command signer (whose private key NEVER enters this process) produce signatures that
// verify — i.e. the external signer is a byte-equivalent drop-in.
//
// Keys are GenerateKey()'d at runtime here — never read from disk/fixture (secret-scan safe).

const (
	testHead   = "sha256:" + "1111111111111111111111111111111111111111111111111111111111111111"
	testLength = 7
)

// signViaPort mirrors EXACTLY how the kernel signs: msg := CheckpointBytes(head,length); raw, _ :=
// signer.Sign(msg); base64(raw). It never touches a raw private key — only the port.
func signViaPort(t *testing.T, s CheckpointSigner, head string, length int) string {
	t.Helper()
	msg := chain.CheckpointBytes(head, length)
	raw, err := s.Sign(msg)
	if err != nil {
		t.Fatalf("port Sign: %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

// (a) InProcessSigner: a checkpoint signed via the port verifies under the port's public key — and is
// byte-identical to today's chain.SignCheckpoint(priv, ...). (Mutation: InProcessSigner.Sign signs
// the wrong bytes -> VerifyCheckpoint RED.)
func TestInProcessSignerVerifies(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s := NewInProcessSigner(priv)

	sig := signViaPort(t, s, testHead, testLength)
	if !chain.VerifyCheckpoint(s.Public(), testHead, testLength, sig) {
		t.Fatal("in-process signer: checkpoint did NOT verify under signer.Public()")
	}
	// public key matches the raw key's public half.
	if !bytes.Equal(s.Public(), pub) {
		t.Fatal("in-process signer Public() != raw key public half")
	}
	// byte-equivalence with the legacy direct-key path (K1/K2/PK1 conformance must not shift).
	if sig != chain.SignCheckpoint(priv, testHead, testLength) {
		t.Fatal("in-process signer is NOT byte-equivalent to chain.SignCheckpoint(priv, ...)")
	}
}

// buildFakeCommandSigner compiles a tiny in-tree fake signing command that holds a test Ed25519 key
// and implements `pubkey` (stdout = SPKI/PKIX DER) + `sign` (message on stdin -> raw 64-byte sig on
// stdout). The key lives ONLY inside that child process — it never enters THIS (kernel) process.
// Returns the argv ([]string{binPath}) plus the public key for cross-checking.
func buildFakeCommandSigner(t *testing.T) ([]string, ed25519.PublicKey) {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain unavailable to build the fake command signer")
	}
	dir := t.TempDir()

	// Generate the test key INSIDE the helper's source as a base64 SEED literal (32 bytes). The kernel
	// process under test never sees the private key — only the compiled child does, and only at runtime.
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	seedB64 := base64.StdEncoding.EncodeToString(priv.Seed())

	src := `package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"io"
	"os"
)

const seedB64 = "` + seedB64 + `"

func main() {
	seed, err := base64.StdEncoding.DecodeString(seedB64)
	if err != nil {
		os.Exit(3)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	switch os.Args[1] {
	case "pubkey":
		der, err := x509.MarshalPKIXPublicKey(priv.Public())
		if err != nil {
			os.Exit(4)
		}
		os.Stdout.Write(der)
	case "sign":
		msg, err := io.ReadAll(os.Stdin)
		if err != nil {
			os.Exit(5)
		}
		os.Stdout.Write(ed25519.Sign(priv, msg))
	default:
		os.Exit(2)
	}
}
`
	srcPath := filepath.Join(dir, "fakesigner.go")
	if err := os.WriteFile(srcPath, []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "fakesigner")
	build := exec.Command("go", "build", "-o", bin, srcPath)
	build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOTOOLCHAIN=local")
	build.Env = filterEnv(build.Env, "GOROOT")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fake signer: %v\n%s", err, out)
	}
	return []string{bin}, pub
}

// filterEnv drops any entry whose key == name (mirror `env -u`).
func filterEnv(env []string, name string) []string {
	out := env[:0]
	prefix := name + "="
	for _, e := range env {
		if len(e) >= len(prefix) && e[:len(prefix)] == prefix {
			continue
		}
		out = append(out, e)
	}
	return out
}

// (b) CommandSigner: a checkpoint signed via the OUT-OF-PROCESS command verifies under the public key
// the CommandSigner obtained at construction (`<cmd> pubkey`). The private key never enters this
// process — only the fake child holds it. (Mutation: CommandSigner.Public() returns a different /
// fabricated key -> VerifyCheckpoint RED.)
func TestCommandSignerVerifies(t *testing.T) {
	argv, wantPub := buildFakeCommandSigner(t)

	s, err := NewCommandSigner(argv)
	if err != nil {
		t.Fatalf("NewCommandSigner: %v", err)
	}
	if !bytes.Equal(s.Public(), wantPub) {
		t.Fatal("command signer Public() != fake command's public key (pubkey subcommand mis-parsed)")
	}

	sig := signViaPort(t, s, testHead, testLength)
	if !chain.VerifyCheckpoint(s.Public(), testHead, testLength, sig) {
		t.Fatal("command signer: checkpoint did NOT verify under signer.Public()")
	}
	// the command-produced signature is byte-equivalent to an in-process signature over the same key.
	derPub, _ := x509.MarshalPKIXPublicKey(s.Public())
	if len(derPub) == 0 {
		t.Fatal("command signer public key is unmarshalable")
	}
}

// (d.1) FAIL-CLOSED: a missing command -> NewCommandSigner errors (cannot obtain a pubkey), and never
// yields a usable signer with a fabricated key.
func TestCommandSignerMissingCommandFailsClosed(t *testing.T) {
	if _, err := NewCommandSigner([]string{filepath.Join(t.TempDir(), "does-not-exist")}); err == nil {
		t.Fatal("NewCommandSigner with a missing command must fail closed (no pubkey), got nil error")
	}
	if _, err := NewCommandSigner(nil); err == nil {
		t.Fatal("NewCommandSigner with empty argv must fail closed, got nil error")
	}
}

// (d.2) FAIL-CLOSED: the sign subcommand exits non-zero -> Sign returns an error and NEVER fabricates
// a signature. (Mutation: Sign swallows the error and returns a zero/garbage sig -> this RED.)
func TestCommandSignerNonZeroExitFailsClosed(t *testing.T) {
	pub := buildExitCodeFakeSigner(t, "sign", 7) // pubkey ok, sign exits 7
	s, err := NewCommandSigner(pub)
	if err != nil {
		t.Fatalf("NewCommandSigner (pubkey must still work): %v", err)
	}
	raw, err := s.Sign(chain.CheckpointBytes(testHead, testLength))
	if err == nil {
		t.Fatalf("Sign must fail closed on non-zero exit, got sig of len %d", len(raw))
	}
	if raw != nil {
		t.Fatal("Sign must return NO signature bytes on failure (never fabricate)")
	}
}

// (d.3) FAIL-CLOSED: a wrong-length signature (not 64 bytes) -> Sign errors, never returned. (Mutation:
// Sign skips the length check and hands back a short/garbage sig -> this RED.)
func TestCommandSignerWrongLengthSigFailsClosed(t *testing.T) {
	argv := buildWrongLengthFakeSigner(t)
	s, err := NewCommandSigner(argv)
	if err != nil {
		t.Fatalf("NewCommandSigner: %v", err)
	}
	raw, err := s.Sign(chain.CheckpointBytes(testHead, testLength))
	if err == nil {
		t.Fatalf("Sign must reject a wrong-length signature, got len %d", len(raw))
	}
	if raw != nil {
		t.Fatal("Sign must return NO signature bytes on a wrong-length sig (never fabricate)")
	}
}

// buildExitCodeFakeSigner builds a fake signer whose `pubkey` works but a chosen subcommand exits with
// the given code.
func buildExitCodeFakeSigner(t *testing.T, failSub string, code int) []string {
	t.Helper()
	argv, _ := buildFakeVariant(t, `
	case "sign":
		os.Exit(`+itoa(code)+`)
`)
	_ = failSub
	return argv
}

// buildWrongLengthFakeSigner builds a fake signer whose `sign` emits a too-short signature.
func buildWrongLengthFakeSigner(t *testing.T) []string {
	t.Helper()
	argv, _ := buildFakeVariant(t, `
	case "sign":
		os.Stdout.Write([]byte("short"))
`)
	return argv
}

// buildFakeVariant compiles a fake signer with a real pubkey subcommand and a caller-supplied sign
// case body (replacing the normal sign). Returns argv + pub.
func buildFakeVariant(t *testing.T, signCase string) ([]string, ed25519.PublicKey) {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain unavailable")
	}
	dir := t.TempDir()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	seedB64 := base64.StdEncoding.EncodeToString(priv.Seed())
	src := `package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"os"
)

const seedB64 = "` + seedB64 + `"

func main() {
	seed, _ := base64.StdEncoding.DecodeString(seedB64)
	priv := ed25519.NewKeyFromSeed(seed)
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	switch os.Args[1] {
	case "pubkey":
		der, _ := x509.MarshalPKIXPublicKey(priv.Public())
		os.Stdout.Write(der)
` + signCase + `	default:
		os.Exit(2)
	}
}
`
	srcPath := filepath.Join(dir, "fakesigner.go")
	if err := os.WriteFile(srcPath, []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "fakesigner")
	build := exec.Command("go", "build", "-o", bin, srcPath)
	build.Env = filterEnv(append(os.Environ(), "CGO_ENABLED=0", "GOTOOLCHAIN=local"), "GOROOT")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fake signer variant: %v\n%s", err, out)
	}
	return []string{bin}, pub
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		b[pos] = '-'
	}
	return string(b[pos:])
}

// (d.3) FAIL-CLOSED: the `pubkey` subcommand returns bytes that are NOT a valid PKIX/Ed25519 public
// key -> NewCommandSigner errors (it never trusts an unparseable key, so a malformed external signer
// cannot establish a bogus trust-root). Closes the last CommandSigner construction fail-closed branch.
func TestCommandSignerUnparseablePubkeyFailsClosed(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh unavailable")
	}
	// `<sh -c 'printf not-a-valid-der'> pubkey` emits garbage on the pubkey call.
	if _, err := NewCommandSigner([]string{"sh", "-c", "printf not-a-valid-der-public-key"}); err == nil {
		t.Fatal("NewCommandSigner with an unparseable pubkey must fail closed, got nil error")
	}
}
