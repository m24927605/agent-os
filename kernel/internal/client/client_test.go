package client

import (
	"context"
	"net"
	"path/filepath"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"

	"github.com/agent-os/kernel/internal/ingestpb"
	"github.com/agent-os/kernel/internal/server"
	"github.com/agent-os/kernel/internal/store"
)

type noAudit struct{}

func (noAudit) RecordDenial(string, uint64, string, string) error { return nil }

// End-to-end over an in-process gRPC link (bufconn): the append-only client talks to a real kernel
// server. Proves the cross-process contract works and that errors surface through the client.
func TestAppendOnlyClientEndToEnd(t *testing.T) {
	lis := bufconn.Listen(1 << 20)
	st, err := store.Open(filepath.Join(t.TempDir(), "k.wal"))
	if err != nil {
		t.Fatal(err)
	}
	srv, err := server.NewIngestServer(st, noAudit{})
	if err != nil {
		t.Fatal(err)
	}
	gs := grpc.NewServer()
	ingestpb.RegisterAppendServiceServer(gs, srv)
	go func() { _ = gs.Serve(lis) }()
	defer gs.Stop()

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()

	c := New(conn)
	r, err := c.Append(context.Background(), "S", 0, []byte(`{"a":1}`))
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if r.Sequence != 0 || r.EntryHash == "" {
		t.Fatalf("bad receipt: %+v", r)
	}
	// a rejected rewrite must surface as an error through the append-only client
	if _, err := c.Append(context.Background(), "S", 0, []byte(`{"a":2}`)); err == nil {
		t.Fatal("replay must surface an error through the client")
	}
}
