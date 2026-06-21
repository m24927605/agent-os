package partition

import (
	"crypto/ed25519"
	"crypto/rand"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/ingestpb"
	"github.com/agent-os/kernel/internal/store"
)

const genesis = "sha256:" + "0000000000000000000000000000000000000000000000000000000000000000"

// newTestPartition wires two tenants (a, b), each with its own durable store + runtime-generated
// Ed25519 key. Keys are GenerateKey()'d at runtime — never read from disk/fixture (secret-scan safe).
func newTestPartition(t *testing.T) (*PartitionedIngest, map[string]ed25519.PublicKey) {
	t.Helper()
	pubs := map[string]ed25519.PublicKey{}
	cfg := map[string]PartitionConfig{}
	for _, id := range []string{"a", "b"} {
		st, err := store.Open(filepath.Join(t.TempDir(), id+".wal"))
		if err != nil {
			t.Fatalf("open store %s: %v", id, err)
		}
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatalf("genkey %s: %v", id, err)
		}
		pubs[id] = pub
		cfg[id] = PartitionConfig{Store: st, Signer: priv}
	}
	p, err := NewPartitionedIngest(cfg)
	if err != nil {
		t.Fatalf("NewPartitionedIngest: %v", err)
	}
	return p, pubs
}

func req(source string, seq uint64, ev string) *ingestpb.AppendRequest {
	return &ingestpb.AppendRequest{SourceId: source, Sequence: seq, CanonicalEvent: []byte(ev)}
}

// ① Chains do not entangle: appending to tenant-a must NOT move tenant-b's head.
func TestChainsDoNotEntangle(t *testing.T) {
	p, _ := newTestPartition(t)

	ckB0, err := p.Checkpoint("b")
	if err != nil {
		t.Fatalf("checkpoint b (genesis): %v", err)
	}
	if ckB0.HeadEntryHash != genesis || ckB0.Length != 0 {
		t.Fatalf("tenant-b should start at genesis/len0, got %+v", ckB0)
	}

	resp, err := p.Append("a", req("S", 0, `{"action":"x"}`))
	if err != nil {
		t.Fatalf("append a: %v", err)
	}
	if resp.GetReceipt() == nil {
		t.Fatalf("tenant-a append should produce a receipt, got %v", resp.GetError())
	}

	ckB1, err := p.Checkpoint("b")
	if err != nil {
		t.Fatalf("checkpoint b after a-append: %v", err)
	}
	if ckB1.HeadEntryHash != genesis || ckB1.Length != 0 {
		t.Fatalf("tenant-a append moved tenant-b head: %+v", ckB1)
	}

	// symmetric: appending to b must not move a's head past its own single entry
	aHead := resp.GetReceipt().EntryHash
	if _, err := p.Append("b", req("S", 0, `{"action":"y"}`)); err != nil {
		t.Fatalf("append b: %v", err)
	}
	ckA, err := p.Checkpoint("a")
	if err != nil {
		t.Fatalf("checkpoint a: %v", err)
	}
	if ckA.HeadEntryHash != aHead || ckA.Length != 1 {
		t.Fatalf("tenant-b append disturbed tenant-a head: got %+v want head %s len 1", ckA, aHead)
	}
}

// ② Cryptographic isolation: tenant-a's checkpoint verifies under a's key (true) and is REJECTED
// under tenant-b's key (false) — wrong-key-must-reject, fail-closed.
func TestCrossTenantWrongKeyRejected(t *testing.T) {
	p, pubs := newTestPartition(t)
	if _, err := p.Append("a", req("S", 0, `{"action":"x"}`)); err != nil {
		t.Fatalf("append a: %v", err)
	}
	ck, err := p.Checkpoint("a")
	if err != nil {
		t.Fatalf("checkpoint a: %v", err)
	}
	if !chain.VerifyCheckpoint(pubs["a"], ck.HeadEntryHash, ck.Length, ck.Signature) {
		t.Fatal("tenant-a checkpoint must verify under tenant-a's own public key")
	}
	if chain.VerifyCheckpoint(pubs["b"], ck.HeadEntryHash, ck.Length, ck.Signature) {
		t.Fatal("tenant-a checkpoint MUST be rejected under tenant-b's public key (cross-tenant unforgeable)")
	}
}

// ③ fail-closed: an unknown partitionId Append is denied — no default tenant is created, no chain written.
func TestUnknownPartitionFailsClosed(t *testing.T) {
	p, _ := newTestPartition(t)
	resp, err := p.Append("ghost", req("S", 0, `{"action":"x"}`))
	if err == nil {
		t.Fatalf("unknown partition must error (fail-closed), got resp=%v", resp)
	}
	if resp != nil {
		t.Fatalf("unknown partition must not return a response, got %v", resp)
	}
	// no default tenant was created: Checkpoint on the unknown id must still fail.
	if _, cerr := p.Checkpoint("ghost"); cerr == nil {
		t.Fatal("unknown partition Checkpoint must fail (no default tenant materialized)")
	}
}

// ④ Intra-tenant invariants preserved: sequence gap/replay still denied within a tenant.
func TestIntraTenantSequenceInvariants(t *testing.T) {
	p, _ := newTestPartition(t)

	// gap: next=0, sequence=5
	gap, err := p.Append("a", req("S", 5, `{}`))
	if err != nil {
		t.Fatalf("gap append errored unexpectedly: %v", err)
	}
	if gap.GetReceipt() != nil || gap.GetError().Code != ingestpb.AppendError_SEQUENCE_GAP {
		t.Fatalf("want SEQUENCE_GAP, got %v", gap)
	}

	if _, err := p.Append("a", req("S", 0, `{"v":"orig"}`)); err != nil {
		t.Fatalf("seed append: %v", err)
	}
	// replay: sequence 0 again
	replay, err := p.Append("a", req("S", 0, `{"v":"REWRITE"}`))
	if err != nil {
		t.Fatalf("replay append errored unexpectedly: %v", err)
	}
	if replay.GetReceipt() != nil || replay.GetError().Code != ingestpb.AppendError_SEQUENCE_REPLAY {
		t.Fatalf("want SEQUENCE_REPLAY, got %v", replay)
	}

	// malformed: not canonical JSON
	mal, err := p.Append("a", req("S", 1, "not json"))
	if err != nil {
		t.Fatalf("malformed append errored unexpectedly: %v", err)
	}
	if mal.GetReceipt() != nil || mal.GetError().Code != ingestpb.AppendError_MALFORMED {
		t.Fatalf("want MALFORMED, got %v", mal)
	}
}

// ⑤ commit-before-effect: if the durable commit fails, no Receipt is returned and the head does not move.
func TestCommitBeforeEffect(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_ = pub
	st, err := store.Open(filepath.Join(t.TempDir(), "a.wal"))
	if err != nil {
		t.Fatal(err)
	}
	// close the store so Append's durable write fails (fsync/write on closed file).
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	p, err := NewPartitionedIngest(map[string]PartitionConfig{"a": {Store: st, Signer: priv}})
	if err != nil {
		t.Fatal(err)
	}
	resp, aerr := p.Append("a", req("S", 0, `{"action":"x"}`))
	if aerr == nil {
		t.Fatalf("durable commit failure must NOT return a Receipt; got resp=%v", resp)
	}
	// head must remain genesis (commit-before-effect: no effect on rejected commit)
	ck, cerr := p.Checkpoint("a")
	if cerr != nil {
		t.Fatalf("checkpoint after failed commit: %v", cerr)
	}
	if ck.HeadEntryHash != genesis || ck.Length != 0 {
		t.Fatalf("failed commit moved the head: %+v", ck)
	}
}

// guard: secret-scan note — keys are runtime-generated; this string is the canary the test must NOT echo.
func TestDenyDoesNotLeakCanary(t *testing.T) {
	p, _ := newTestPartition(t)
	canary := "sk-" + strings.Repeat("z", 40)
	resp, err := p.Append("a", req("S", 0, "not-json-"+canary))
	if err != nil {
		t.Fatalf("malformed append errored: %v", err)
	}
	if e := resp.GetError(); e == nil || strings.Contains(e.Detail, canary) {
		t.Fatalf("AppendError.detail must not echo canary: %v", e)
	}
}
