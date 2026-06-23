package signer

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"errors"
	"fmt"
	"os/exec"
)

// CommandSigner is an OUT-OF-PROCESS CheckpointSigner: the private key lives behind an external
// command and NEVER enters the kernel process. The kernel holds ONLY the command argv + the public key
// obtained at construction — there is no field, anywhere, that can hold the private key.
//
// ── Command protocol (documented contract) ──────────────────────────────────────────────────────────
//
//	<cmd...> pubkey
//	    stdout = the Ed25519 public key as SPKI / PKIX DER (the same encoding x509.MarshalPKIXPublicKey
//	    produces and the released verifier's x509.ParsePKIXPublicKey consumes). Run ONCE at construction.
//
//	<cmd...> sign
//	    stdin  = the message to sign, as RAW bytes (here: chain.CheckpointBytes(head, length)).
//	    stdout = the RAW 64-byte Ed25519 signature (NOT base64; the kernel base64-encodes it itself,
//	             exactly as for the in-process path, so the wire signature is identical).
//
// FAIL-CLOSED in every failure mode — the kernel must never emit an UNSIGNED or fabricated checkpoint:
//   - empty argv / command not found / cannot launch          -> construction error (no signer returned)
//   - `pubkey` non-zero exit / unparseable DER / non-Ed25519   -> construction error
//   - `sign` non-zero exit                                     -> Sign error (no bytes)
//   - `sign` returns a wrong-length signature (!= 64 bytes)    -> Sign error (no bytes)
//
// On Sign error the caller (server/partition Checkpoint) already refuses the checkpoint, so an external
// signer failure can never degrade to a silent or forged signature.
//
// HONEST BOUNDARY: the private key being out of the kernel process is what TR1 proves. Whether the
// OPERATOR can also reach it depends on how the external command protects its key (HSM/KMS/IAM) — a
// pure-software command run by the same operator is NOT yet operator-unforgeable. That guarantee is
// TR2 / deployment.
type CommandSigner struct {
	argv []string          // the external signer command (argv[0] = program, argv[1:] = base args)
	pub  ed25519.PublicKey // obtained once via `<cmd> pubkey`; the verifying key (no private material)
}

// NewCommandSigner constructs a CommandSigner from a command argv. It runs `<cmd> pubkey` ONCE to
// obtain (and validate) the public key. It returns an error — and NO usable signer — on any failure,
// so a misconfigured external signer can never silently yield a signer with a fabricated key.
func NewCommandSigner(argv []string) (*CommandSigner, error) {
	if len(argv) == 0 {
		return nil, errors.New("signer: command argv is empty (fail-closed)")
	}
	// Defensive copy so a later mutation of the caller's slice cannot swap the signing command.
	cmdArgv := make([]string, len(argv))
	copy(cmdArgv, argv)

	out, err := runCommand(cmdArgv, "pubkey", nil)
	if err != nil {
		return nil, fmt.Errorf("signer: obtain public key via %q pubkey: %w", cmdArgv[0], err)
	}
	anyPub, err := x509.ParsePKIXPublicKey(out)
	if err != nil {
		return nil, fmt.Errorf("signer: parse public key (expect SPKI/PKIX DER) from %q pubkey: %w", cmdArgv[0], err)
	}
	pub, ok := anyPub.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("signer: %q pubkey is not an Ed25519 public key: %T", cmdArgv[0], anyPub)
	}
	if len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("signer: %q pubkey has wrong Ed25519 size %d", cmdArgv[0], len(pub))
	}
	return &CommandSigner{argv: cmdArgv, pub: pub}, nil
}

// Sign runs `<cmd> sign` with message on stdin and returns the raw 64-byte signature from stdout.
// FAIL-CLOSED: any launch/exit failure or a wrong-length result returns an error and NO bytes — it
// never fabricates a signature.
func (s *CommandSigner) Sign(message []byte) ([]byte, error) {
	out, err := runCommand(s.argv, "sign", message)
	if err != nil {
		return nil, fmt.Errorf("signer: %q sign failed (fail-closed; checkpoint refused): %w", s.argv[0], err)
	}
	if len(out) != ed25519.SignatureSize {
		return nil, fmt.Errorf("signer: %q sign returned a wrong-length signature %d (want %d); refusing (fail-closed)", s.argv[0], len(out), ed25519.SignatureSize)
	}
	return out, nil
}

// Public returns the verifying key obtained at construction. No private key material is ever held.
func (s *CommandSigner) Public() ed25519.PublicKey {
	return s.pub
}

// runCommand executes argv with `subcommand` appended, writing stdin (may be nil) and returning stdout.
// A non-zero exit or launch failure is an error.
func runCommand(argv []string, subcommand string, stdin []byte) ([]byte, error) {
	args := append(append([]string{}, argv[1:]...), subcommand)
	cmd := exec.Command(argv[0], args...) //nolint:gosec // operator-supplied external signer command, by design (TR1 seam).
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return stdout.Bytes(), nil
}
