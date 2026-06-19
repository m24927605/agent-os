// Package client is the append-only ingest client. It exposes ONLY Append — there is intentionally
// no Update/Delete/Overwrite/Rewrite method, and the raw generated gRPC stub is not exposed, so a
// caller cannot bypass the append-only surface. This is the control-plane-side reference client
// (TS-side integration is P2); cross-plane talks to the kernel ONLY via the proto.
package client

import (
	"context"
	"fmt"

	"google.golang.org/grpc"

	"github.com/agent-os/kernel/internal/ingestpb"
)

// Receipt is the kernel's acknowledgement of a durably-committed append.
type Receipt struct {
	Sequence    uint64
	ContentHash string
	PrevHash    string
	EntryHash   string
}

// AppendOnlyClient exposes ONLY Append.
type AppendOnlyClient interface {
	Append(ctx context.Context, sourceID string, sequence uint64, canonicalEvent []byte) (Receipt, error)
}

type client struct{ inner ingestpb.AppendServiceClient }

// New wraps a gRPC connection in an append-only client (the raw stub stays unexported).
func New(conn grpc.ClientConnInterface) AppendOnlyClient {
	return &client{inner: ingestpb.NewAppendServiceClient(conn)}
}

func (c *client) Append(ctx context.Context, sourceID string, sequence uint64, canonicalEvent []byte) (Receipt, error) {
	resp, err := c.inner.Append(ctx, &ingestpb.AppendRequest{SourceId: sourceID, Sequence: sequence, CanonicalEvent: canonicalEvent})
	if err != nil {
		return Receipt{}, err
	}
	if e := resp.GetError(); e != nil {
		return Receipt{}, fmt.Errorf("append denied: %s (%s)", e.GetCode().String(), e.GetDetail())
	}
	r := resp.GetReceipt()
	if r == nil {
		return Receipt{}, fmt.Errorf("append: empty response (fail-closed)")
	}
	return Receipt{Sequence: r.GetSequence(), ContentHash: r.GetContentHash(), PrevHash: r.GetPrevHash(), EntryHash: r.GetEntryHash()}, nil
}
