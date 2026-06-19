// Package commitgate enforces the synchronous commit-before-effect happens-before: the evidence is
// durably committed to the outbox BEFORE the side effect is allowed to run. If the commit fails or
// is not durable, the effect is never called (fail-closed). It knows nothing about how evidence is
// stored (only the outbox public Enqueuer) nor about the effect's business meaning (a func() error).
package commitgate

import (
	"context"
	"errors"

	"github.com/agent-os/kernel/internal/outbox"
)

// Enqueuer is the outbox-side dependency: a durable commit that returns a receipt.
type Enqueuer interface {
	Enqueue(rec outbox.RecordInput) (outbox.CommitReceipt, error)
}

// Gate enforces commit-before-effect.
type Gate struct {
	ob Enqueuer
}

// New builds a Gate over an Enqueuer (e.g. *outbox.Outbox).
func New(ob Enqueuer) *Gate { return &Gate{ob: ob} }

// Guard durably commits the evidence first, then — only on a durable receipt — runs effect.
// Commit failure or a non-durable receipt returns an error with effect NEVER called.
func (g *Gate) Guard(ctx context.Context, rec outbox.RecordInput, effect func() error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	receipt, err := g.ob.Enqueue(rec)
	if err != nil {
		return err // effect NOT called
	}
	if !receipt.Durable {
		return errors.New("commitgate: evidence not durably committed; refusing to run effect")
	}
	return effect()
}
