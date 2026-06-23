package server

import (
	"context"
	"crypto/x509"
	"encoding/base64"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/ingestpb"
)

// Checkpoint atomically captures a consistent snapshot anchor under the SAME mutex that serializes
// Append (append.go), so a caller can never observe a torn (half-written) tail: the chain head
// entryHash, the head record's sequence, and the per-source next-sequence map are all read at one
// instant in which no Append is mid-flight (design §41/§60).
//
// READ-ONLY by construction: it acquires the lock, copies the in-memory anchor, SIGNS it, releases,
// and returns. It NEVER appends, rewrites, truncates, or mutates s.head / s.headSeq / s.length /
// s.next / the durable store — it does not widen the append-only surface (this is the safe replacement
// for the infeasible ftruncate-to-N of design §49 correction 1). Empty log => head_entry_hash is the
// genesis hash, length is 0, and per_source_next_seq is an empty map (fail-safe boundary).
//
// SIGNING (K1): it captures the head + length under the mutex, then signs via the CheckpointSigner
// PORT — msg := chain.CheckpointBytes(head, length); raw, err := signer.Sign(msg); base64(raw) — so
// the raw private key is NEVER touched here (the server holds only the interface; the key may even be
// out of this process via CommandSigner). It exposes the signature + the kernel's public key (SPKI/
// PKIX DER from signer.Public()) so a third party can verify the operator's ACTUAL chain head with
// chain.VerifyCheckpoint / the released verifier. The signed bytes are CheckpointBytes(head_entry_hash,
// length) — the EXACT pair returned — so the verifier reconstructs identical bytes. FAIL-CLOSED: with
// no signer configured, OR if the signer errors (e.g. an out-of-process command failed), it returns an
// error and NEVER an unsigned/fabricated checkpoint. The control plane (actor) holds no key and cannot
// reach this path's signer — attester != actor holds to the process boundary.
func (s *IngestServer) Checkpoint(_ context.Context, _ *ingestpb.CheckpointRequest) (*ingestpb.CheckpointResponse, error) {
	s.mu.Lock()
	// Copy the per-source map so the returned snapshot cannot be mutated by a later Append racing on
	// s.next after the lock is released. The copy is taken inside the critical section.
	perSource := make(map[string]uint64, len(s.next))
	for src, n := range s.next {
		perSource[src] = n
	}
	head := s.head
	headSeq := s.headSeq
	length := s.length
	signer := s.signer
	s.mu.Unlock()

	// FAIL-CLOSED: never emit an UNSIGNED checkpoint. A misconfigured server (no signer) errors here
	// rather than silently handing back an empty checkpoint_signature.
	if signer == nil {
		return nil, status.Error(codes.FailedPrecondition, "kernel has no signing key configured (fail-closed; refusing to emit an unsigned checkpoint)")
	}
	derPub, err := x509.MarshalPKIXPublicKey(signer.Public())
	if err != nil {
		// Cannot expose a usable public key -> fail closed (the signature would be unverifiable).
		return nil, status.Error(codes.Internal, "marshal kernel public key failed")
	}
	// Sign via the PORT over the EXACT bytes the verifier reconstructs. FAIL-CLOSED on any signer
	// error (e.g. an out-of-process command failed) — never fabricate or emit an unsigned checkpoint.
	raw, err := signer.Sign(chain.CheckpointBytes(head, length))
	if err != nil {
		return nil, status.Error(codes.Internal, "checkpoint signer failed (fail-closed; refusing to emit an unsigned checkpoint)")
	}
	sig := base64.StdEncoding.EncodeToString(raw)

	return &ingestpb.CheckpointResponse{
		HeadEntryHash:       head,
		HeadSequence:        headSeq,
		PerSourceNextSeq:    perSource,
		CheckpointSignature: sig,
		PublicKey:           derPub,
	}, nil
}
