// Package partition lowers tenant isolation into a CRYPTOGRAPHIC PARTITION rather than a row filter.
// PartitionedIngest holds one independent {head, next, store, signer} per tenant (partitionId =
// tenant), so (1) appending to tenant-a never moves tenant-b's chain head, and (2) a checkpoint
// signed by tenant-a's Ed25519 key is REJECTED under tenant-b's public key (wrong-key-must-reject,
// fail-closed). It REUSES the existing kernel primitives (internal/chain EntryHashFromCanonical +
// the append-only/gap/replay shape from internal/server/append.go + internal/store durable commit)
// and does NOT change canonical/chain/verify algorithms — it only wraps them per tenant.
//
// IMPORTANT: tenant is NOT a SourceID. internal/store/store.go documents that SourceID is an
// ingest-completeness NAMESPACE, NOT a trust boundary. Folding tenant into SourceID would keep one
// shared head + one shared signing key (a renamed row filter). Here each tenant is independent state
// + an independent key. This package is a stand-alone library: it does NOT import, and is NOT
// imported by, internal/server; live gRPC wiring requires a proto partition_id field first (a
// contract-before-consumer slice), out of scope here.
package partition

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/ingestpb"
	"github.com/agent-os/kernel/internal/signer"
	"github.com/agent-os/kernel/internal/store"
)

// PartitionConfig is the per-tenant durable store + CheckpointSigner PORT. The Signer is an interface,
// so a partition is structurally unable to hold a raw ed25519.PrivateKey field: the private key is
// either in-process behind an InProcessSigner (operator-held) or out of process behind a CommandSigner
// — never a private-key field here, and never serialized to source/log/fixture/testdata.
type PartitionConfig struct {
	Store  *store.Store
	Signer signer.CheckpointSigner
}

// partitionState is one tenant's independent chain state: its own head, its own per-source expected
// next sequence, its own durable store, its own signer PORT, and its own entry count (checkpoint
// length). The signer is an interface — no raw private key is held per tenant.
type partitionState struct {
	store  *store.Store
	signer signer.CheckpointSigner
	next   map[string]uint64 // expected next sequence per source within THIS tenant (0 if unseen)
	head   string            // this tenant's chain head entryHash (genesis if empty)
	length int               // number of committed entries in this tenant's chain (checkpoint length)
}

// PartitionedIngest routes Append/Checkpoint by partitionId to per-tenant state. There is no API to
// enumerate partitions or fetch an arbitrary partition's state, and no default tenant is ever
// materialized — an unknown partitionId fails closed.
type PartitionedIngest struct {
	mu    sync.Mutex
	parts map[string]*partitionState
}

// NewPartitionedIngest rebuilds each tenant's next-sequence + head from its OWN durable log (a
// restart cannot silently re-open a gap or accept a replay), keeping per-tenant state independent.
func NewPartitionedIngest(parts map[string]PartitionConfig) (*PartitionedIngest, error) {
	if len(parts) == 0 {
		return nil, errors.New("partition: at least one partition config required")
	}
	states := make(map[string]*partitionState, len(parts))
	for id, cfg := range parts {
		if cfg.Store == nil {
			return nil, fmt.Errorf("partition %q: store is required", id)
		}
		if cfg.Signer == nil {
			return nil, fmt.Errorf("partition %q: a CheckpointSigner is required", id)
		}
		records, head, err := cfg.Store.Load()
		if err != nil {
			return nil, fmt.Errorf("partition %q: load: %w", id, err)
		}
		next := make(map[string]uint64)
		for _, r := range records {
			if r.SourceSeq+1 > next[r.SourceID] {
				next[r.SourceID] = r.SourceSeq + 1
			}
		}
		states[id] = &partitionState{
			store: cfg.Store, signer: cfg.Signer, next: next, head: head, length: len(records),
		}
	}
	return &PartitionedIngest{parts: states}, nil
}

func deny(code ingestpb.AppendError_Code, detail string) *ingestpb.AppendResponse {
	// detail is a static reason / field name only — it never echoes canonical_event content.
	return &ingestpb.AppendResponse{Result: &ingestpb.AppendResponse_Error{Error: &ingestpb.AppendError{Code: code, Detail: detail}}}
}

// Append routes req to the partitionId's tenant state and enforces append-only + monotonic
// per-source sequence WITHIN that tenant. An UNKNOWN partitionId is denied with an error and no
// response (fail-closed: no default tenant is created, no chain is written). On a typed intra-tenant
// rejection (malformed/gap/replay) it returns a typed AppendError and never a Receipt. Durable commit
// happens BEFORE the Receipt (commit-before-effect): if the store write fails, no Receipt is returned
// and the tenant's head does not move.
func (p *PartitionedIngest) Append(partitionID string, req *ingestpb.AppendRequest) (*ingestpb.AppendResponse, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	st, ok := p.parts[partitionID]
	if !ok {
		// FAIL-CLOSED: unknown partition -> deny. Do not fall through to a default tenant.
		return nil, fmt.Errorf("partition %q: unknown partition (deny-by-default)", partitionID)
	}

	if len(req.GetCanonicalEvent()) == 0 || !json.Valid(req.GetCanonicalEvent()) {
		return deny(ingestpb.AppendError_MALFORMED, "canonical_event is empty or not valid canonical JSON"), nil
	}

	expected := st.next[req.GetSourceId()]
	switch {
	case req.GetSequence() > expected:
		return deny(ingestpb.AppendError_SEQUENCE_GAP, "sequence ahead of expected next (gap)"), nil
	case req.GetSequence() < expected:
		return deny(ingestpb.AppendError_SEQUENCE_REPLAY, "sequence already settled; append-only refuses rewrite"), nil
	}

	// accept: hashes are computed from the canonical bytes; the client cannot set them. This tenant's
	// head links the chain — no other tenant's head is read or written.
	prevHash := st.head
	entryHash := chain.EntryHashFromCanonical(req.GetCanonicalEvent(), prevHash, int(req.GetSequence()))
	contentHash := chain.ContentAddress(req.GetCanonicalEvent())

	var ev any
	_ = json.Unmarshal(req.GetCanonicalEvent(), &ev) // persist the already-redacted event object
	if _, err := st.store.Append(store.LogRecord{
		Sequence: int(req.GetSequence()), Event: ev, PrevHash: prevHash, EntryHash: entryHash,
		SourceID: req.GetSourceId(), SourceSeq: req.GetSequence(),
	}); err != nil {
		// durable commit failed -> do NOT return a Receipt (commit-before-effect). head is untouched.
		return nil, fmt.Errorf("partition %q: durable commit failed: %w", partitionID, err)
	}
	st.head = entryHash
	st.length++
	st.next[req.GetSourceId()] = req.GetSequence() + 1
	return &ingestpb.AppendResponse{Result: &ingestpb.AppendResponse_Receipt{Receipt: &ingestpb.Receipt{
		Sequence: req.GetSequence(), ContentHash: contentHash, PrevHash: prevHash, EntryHash: entryHash,
	}}}, nil
}

// Checkpoint signs THIS tenant's current head (over CheckpointBytes(head, length)) via THIS tenant's
// CheckpointSigner PORT — base64(signer.Sign(CheckpointBytes(head, length))) — so no raw private key is
// touched here. An unknown partitionId fails closed (no default tenant). FAIL-CLOSED: if the tenant's
// signer errors (e.g. an out-of-process command failed) it returns an error and NEVER a fabricated /
// unsigned checkpoint. A checkpoint produced here verifies only under the SAME tenant's public key —
// verifying it under another tenant's key returns false (chain.VerifyCheckpoint), which is the
// cross-tenant unforgeability invariant.
func (p *PartitionedIngest) Checkpoint(partitionID string) (chain.Checkpoint, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	st, ok := p.parts[partitionID]
	if !ok {
		return chain.Checkpoint{}, fmt.Errorf("partition %q: unknown partition (deny-by-default)", partitionID)
	}
	head := st.head
	if head == "" {
		head = chain.GenesisPrevHash
	}
	raw, err := st.signer.Sign(chain.CheckpointBytes(head, st.length))
	if err != nil {
		// FAIL-CLOSED: a signer failure (e.g. out-of-process command failed) must not yield an
		// unsigned/fabricated checkpoint.
		return chain.Checkpoint{}, fmt.Errorf("partition %q: checkpoint signer failed (fail-closed): %w", partitionID, err)
	}
	return chain.Checkpoint{
		Length:        st.length,
		HeadEntryHash: head,
		Signature:     base64.StdEncoding.EncodeToString(raw),
	}, nil
}

// PublicKey returns THIS tenant's Ed25519 public key (signer.Public()) so a signed read-back can
// expose the verifying key alongside the Checkpoint signature — letting each tenant be verified
// INDEPENDENTLY (a's signature verifies only under a's key; under b's key it returns false). An
// unknown partitionId fails closed (no default tenant; mirrors Append/Checkpoint). The PRIVATE key is
// never accessible through the CheckpointSigner port — only the public half, which is safe to publish
// to a release verifier.
func (p *PartitionedIngest) PublicKey(partitionID string) (ed25519.PublicKey, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	st, ok := p.parts[partitionID]
	if !ok {
		return nil, fmt.Errorf("partition %q: unknown partition (deny-by-default)", partitionID)
	}
	pub := st.signer.Public()
	if len(pub) != ed25519.PublicKeySize {
		// The signer must expose a valid Ed25519 public key; fail-closed rather than hand back a key
		// that cannot verify the signature.
		return nil, fmt.Errorf("partition %q: signer public key is not a valid Ed25519 key", partitionID)
	}
	return pub, nil
}

// ListEntries returns a consistent snapshot of THIS tenant's durable WORM chain (records with chain
// sequence >= fromSeq), read under the SAME mutex that serializes Append so it cannot observe a torn
// (half-written) tail. It reads ONLY the routed partition's store — no other tenant's store is ever
// touched. An unknown partitionId fails closed (no default tenant; mirrors Append/Checkpoint). It is
// READ-ONLY: it never appends, rewrites, truncates, or mutates head/length/next/the store.
//
// It returns the durable store.LogRecord snapshot; the gRPC adapter re-derives canonical_event from
// each (already-redacted) record.Event via the SAME canonical function the chain used to seal it (so
// EntryHashFromCanonical reproduces entry_hash byte-for-byte), mirroring the single-chain list.go.
func (p *PartitionedIngest) ListEntries(partitionID string, fromSeq uint64) ([]store.LogRecord, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	st, ok := p.parts[partitionID]
	if !ok {
		return nil, fmt.Errorf("partition %q: unknown partition (deny-by-default)", partitionID)
	}
	// Read THIS partition's durable log; fail-closed on a torn/unreadable tail (never a partial slice).
	records, _, err := st.store.Load()
	if err != nil {
		return nil, fmt.Errorf("partition %q: durable log read failed: %w", partitionID, err)
	}
	out := make([]store.LogRecord, 0, len(records))
	for _, r := range records {
		// Filter on the LEAF chain sequence (the value framed into entry_hash), mirroring list.go.
		if uint64(r.Sequence) < fromSeq {
			continue
		}
		out = append(out, r)
	}
	return out, nil
}
