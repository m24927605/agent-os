package commitgate

import (
	"context"
	"errors"
	"testing"

	"github.com/agent-os/kernel/internal/outbox"
)

type enqueuerFunc func(outbox.RecordInput) (outbox.CommitReceipt, error)

func (f enqueuerFunc) Enqueue(r outbox.RecordInput) (outbox.CommitReceipt, error) { return f(r) }

func TestCommitBeforeEffect(t *testing.T) {
	var order []string
	g := New(enqueuerFunc(func(r outbox.RecordInput) (outbox.CommitReceipt, error) {
		order = append(order, "commit")
		return outbox.CommitReceipt{SourceID: r.SourceID, ContentHash: r.ContentHash, Durable: true}, nil
	}))
	if err := g.Guard(context.Background(), outbox.RecordInput{SourceID: "s", ContentHash: "sha256:x"}, func() error {
		order = append(order, "effect")
		return nil
	}); err != nil {
		t.Fatalf("guard: %v", err)
	}
	if len(order) != 2 || order[0] != "commit" || order[1] != "effect" {
		t.Fatalf("want [commit effect] (happens-before), got %v", order)
	}
}

func TestCommitFailEffectNotCalled(t *testing.T) {
	called := 0
	g := New(enqueuerFunc(func(r outbox.RecordInput) (outbox.CommitReceipt, error) {
		return outbox.CommitReceipt{}, errors.New("fsync failed")
	}))
	if err := g.Guard(context.Background(), outbox.RecordInput{SourceID: "s"}, func() error { called++; return nil }); err == nil {
		t.Fatal("expected error when commit fails")
	}
	if called != 0 {
		t.Fatalf("effect must NOT be called when commit fails, called=%d", called)
	}
}

func TestNonDurableReceiptFailsClosed(t *testing.T) {
	called := 0
	g := New(enqueuerFunc(func(r outbox.RecordInput) (outbox.CommitReceipt, error) {
		return outbox.CommitReceipt{Durable: false}, nil // committed but NOT durable
	}))
	if err := g.Guard(context.Background(), outbox.RecordInput{SourceID: "s"}, func() error { called++; return nil }); err == nil {
		t.Fatal("non-durable receipt must fail closed")
	}
	if called != 0 {
		t.Fatalf("effect must NOT run on non-durable commit, called=%d", called)
	}
}
