// Command kernel runs the Agent OS evidence kernel as a SEPARATE PROCESS: a gRPC server exposing
// ONLY the append-only ingest service. The control plane reaches it solely via proto (zero shared
// internals) and can only Append — never rewrite. This is the process boundary that makes
// "attester != attested actor" real. Thin main: no business logic lives here.
package main

import (
	"flag"
	"log"
	"net"

	"google.golang.org/grpc"

	"github.com/agent-os/kernel/internal/ingestpb"
	"github.com/agent-os/kernel/internal/server"
	"github.com/agent-os/kernel/internal/store"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:7777", "gRPC listen address")
	chainPath := flag.String("chain", "kernel-chain.wal", "durable chain log path")
	auditPath := flag.String("audit", "kernel-audit.wal", "durable denial-audit log path")
	flag.Parse()

	chainStore, err := store.Open(*chainPath)
	if err != nil {
		log.Fatalf("open chain store: %v", err)
	}
	auditStore, err := store.Open(*auditPath)
	if err != nil {
		log.Fatalf("open audit store: %v", err)
	}
	audit, err := server.NewStoreAuditSink(auditStore)
	if err != nil {
		log.Fatalf("init audit sink: %v", err)
	}
	srv, err := server.NewIngestServer(chainStore, audit)
	if err != nil {
		log.Fatalf("init ingest server: %v", err)
	}

	lis, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	gs := grpc.NewServer()
	ingestpb.RegisterAppendServiceServer(gs, srv)
	log.Printf("agent-os kernel ingest listening on %s (append-only)", *addr)
	if err := gs.Serve(lis); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
