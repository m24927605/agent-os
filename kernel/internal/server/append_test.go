package server

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/agent-os/kernel/internal/ingestpb"
	"github.com/agent-os/kernel/internal/signer"
	"github.com/agent-os/kernel/internal/store"
)

type auditSpy struct{ denials []string }

func (a *auditSpy) RecordDenial(sourceID string, sequence uint64, code, detail string) error {
	a.denials = append(a.denials, code+":"+detail)
	return nil
}

// newTestServer mirrors the real wiring (main.go always provides a signer): a kernel server with an
// Ed25519 signing key so Checkpoint can sign. The dedicated no-signer fail-closed path is asserted
// separately in TestCheckpointNoSignerFailsClosed (which constructs an UNSIGNED server inline).
func newTestServer(t *testing.T) (*IngestServer, *auditSpy) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "k.wal"))
	if err != nil {
		t.Fatal(err)
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	spy := &auditSpy{}
	srv, err := NewIngestServer(st, spy, WithSigner(signer.NewInProcessSigner(priv)))
	if err != nil {
		t.Fatal(err)
	}
	return srv, spy
}

func appendReq(s string, seq uint64, ev string) *ingestpb.AppendRequest {
	return &ingestpb.AppendRequest{SourceId: s, Sequence: seq, CanonicalEvent: []byte(ev)}
}

func TestAppendHappyPathLinks(t *testing.T) {
	srv, _ := newTestServer(t)
	genesis := "sha256:" + strings.Repeat("0", 64)
	var prev string
	for i := uint64(0); i < 3; i++ {
		resp, err := srv.Append(context.Background(), appendReq("S", i, `{"action":"x","i":`+itoa(i)+`}`))
		if err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
		r := resp.GetReceipt()
		if r == nil {
			t.Fatalf("seq %d: expected receipt, got error %v", i, resp.GetError())
		}
		if i == 0 && r.PrevHash != genesis {
			t.Fatalf("first prev_hash not genesis: %s", r.PrevHash)
		}
		if i > 0 && r.PrevHash != prev {
			t.Fatalf("prev_hash not linked: %s vs %s", r.PrevHash, prev)
		}
		if !strings.HasPrefix(r.EntryHash, "sha256:") || !strings.HasPrefix(r.ContentHash, "sha256:") {
			t.Fatalf("hashes must be sha256:-prefixed: %+v", r)
		}
		prev = r.EntryHash
	}
}

func TestAppendRejectsReplayAndDoesNotMutate(t *testing.T) {
	srv, spy := newTestServer(t)
	r0, _ := srv.Append(context.Background(), appendReq("S", 0, `{"v":"orig"}`))
	orig := r0.GetReceipt().EntryHash

	resp, _ := srv.Append(context.Background(), appendReq("S", 0, `{"v":"REWRITE"}`))
	if resp.GetReceipt() != nil {
		t.Fatal("replay/rewrite must NOT be accepted (append-only)")
	}
	if resp.GetError().Code != ingestpb.AppendError_SEQUENCE_REPLAY {
		t.Fatalf("want SEQUENCE_REPLAY, got %v", resp.GetError().Code)
	}
	if len(spy.denials) == 0 {
		t.Fatal("replay must be audited")
	}
	// durable store: sequence 0's entry is unchanged (no rewrite landed)
	recs, _, err := srv.store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 || recs[0].EntryHash != orig {
		t.Fatalf("store mutated by rejected rewrite: %d recs, head %v want %s", len(recs), recs, orig)
	}
}

func TestAppendRejectsGap(t *testing.T) {
	srv, spy := newTestServer(t)
	resp, _ := srv.Append(context.Background(), appendReq("S", 5, `{}`)) // next=0, gap
	if resp.GetReceipt() != nil || resp.GetError().Code != ingestpb.AppendError_SEQUENCE_GAP {
		t.Fatalf("want SEQUENCE_GAP, got %v", resp)
	}
	if len(spy.denials) == 0 {
		t.Fatal("gap must be audited")
	}
}

func TestAppendRejectsStaleAsReplay(t *testing.T) {
	srv, _ := newTestServer(t)
	for i := uint64(0); i < 3; i++ {
		if _, err := srv.Append(context.Background(), appendReq("S", i, `{}`)); err != nil {
			t.Fatalf("seed append %d: %v", i, err)
		}
	}
	resp, _ := srv.Append(context.Background(), appendReq("S", 1, `{}`)) // < next(3) -> rewrite refused
	if resp.GetReceipt() != nil || resp.GetError().Code != ingestpb.AppendError_SEQUENCE_REPLAY {
		t.Fatalf("stale sequence<next must be refused as REPLAY, got %v", resp)
	}
}

func TestAppendRejectsMalformed(t *testing.T) {
	srv, spy := newTestServer(t)
	resp, _ := srv.Append(context.Background(), appendReq("S", 0, "not json"))
	if resp.GetReceipt() != nil || resp.GetError().Code != ingestpb.AppendError_MALFORMED {
		t.Fatalf("want MALFORMED, got %v", resp)
	}
	if len(spy.denials) == 0 {
		t.Fatal("malformed must be audited")
	}
}

func TestAppendNeverFailsOpen(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := srv.Append(context.Background(), appendReq("S", 9, `{}`)) // gap
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if resp.GetReceipt() == nil && resp.GetError() == nil {
		t.Fatal("response oneof must be set (no empty/fail-open)")
	}
	if e := resp.GetError(); e != nil && e.Code == ingestpb.AppendError_CODE_UNSPECIFIED {
		t.Fatal("must never return CODE_UNSPECIFIED (proto3 zero value must not be a result)")
	}
}

func TestDenyDoesNotLeakCanary(t *testing.T) {
	srv, spy := newTestServer(t)
	canary := "sk-" + strings.Repeat("a", 40)
	resp, _ := srv.Append(context.Background(), appendReq("S", 0, "not-json-"+canary))
	if e := resp.GetError(); e == nil || strings.Contains(e.Detail, canary) {
		t.Fatalf("AppendError.detail must not echo canary: %v", e)
	}
	for _, d := range spy.denials {
		if strings.Contains(d, canary) {
			t.Fatalf("audit reason leaked canary: %s", d)
		}
	}
}

type erroringAudit struct{}

func (erroringAudit) RecordDenial(string, uint64, string, string) error {
	return errors.New("audit disk full")
}

// If the durable denial-audit write fails, the server must NOT hand back a typed deny with no audit
// behind it — it fails closed with an internal error (a denial is not recorded until its audit lands).
func TestDenyFailsClosedWhenAuditWriteFails(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "k.wal"))
	if err != nil {
		t.Fatal(err)
	}
	srv, err := NewIngestServer(st, erroringAudit{})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := srv.Append(context.Background(), appendReq("S", 0, "not json")) // would be MALFORMED deny
	if err == nil || status.Code(err) != codes.Internal {
		t.Fatalf("audit-write failure must fail closed with codes.Internal, got resp=%v err=%v", resp, err)
	}
	if resp != nil {
		t.Fatalf("must not return a response when the denial audit fails, got %v", resp)
	}
}

// tiny itoa to avoid strconv import churn in the table
func itoa(u uint64) string {
	if u == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for u > 0 {
		i--
		b[i] = byte('0' + u%10)
		u /= 10
	}
	return string(b[i:])
}
