// Command kernel runs the Agent OS evidence kernel as a SEPARATE PROCESS: a gRPC server exposing
// ONLY the append-only ingest service. The control plane reaches it solely via proto (zero shared
// internals) and can only Append — never rewrite. This is the process boundary that makes
// "attester != attested actor" real. Thin main: no business logic lives here.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"

	"google.golang.org/grpc"

	"github.com/agent-os/kernel/internal/ingestpb"
	"github.com/agent-os/kernel/internal/partition"
	"github.com/agent-os/kernel/internal/server"
	"github.com/agent-os/kernel/internal/store"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:7777", "gRPC listen address")
	chainPath := flag.String("chain", "kernel-chain.wal", "durable chain log path")
	auditPath := flag.String("audit", "kernel-audit.wal", "durable denial-audit log path")
	// -partitions selects the PARTITIONED AppendService (per-tenant chain + signing key, routed by
	// req.partition_id). Empty (the default) keeps the single-chain server unchanged: Personal's live
	// path stays byte-identical and never sets partition_id.
	partitions := flag.String("partitions", "", "comma-separated tenant partition IDs; empty => single-chain mode (default)")
	partitionDir := flag.String("partition-dir", "kernel-partitions", "directory for per-tenant durable chain logs (partitioned mode only)")
	signingKeyPath := flag.String("signing-key", "", "path to the kernel's Ed25519 private key (PEM or raw DER PKCS#8); empty => generate an in-memory key at startup")
	flag.Parse()

	auditStore, err := store.Open(*auditPath)
	if err != nil {
		log.Fatalf("open audit store: %v", err)
	}
	audit, err := server.NewStoreAuditSink(auditStore)
	if err != nil {
		log.Fatalf("init audit sink: %v", err)
	}

	lis, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	gs := grpc.NewServer()

	if ids := splitPartitions(*partitions); len(ids) > 0 {
		// PARTITIONED mode: provision a per-tenant {durable store, Ed25519 signer} and route by
		// req.partition_id. Unknown/empty partition_id fails closed (deny-by-default) in the adapter.
		//
		// HONEST LIMITATION (ES2a, attester==operator): each tenant's signing key is GENERATED HERE,
		// in memory, by the operator process at wire time. So the entity that runs the kernel also
		// holds every tenant's private key — at this layer the attester IS the operator. Real
		// per-tenant key provision (external generation, KMS-held private keys, per-tenant
		// root-trust externalization, rotation) is P4 and is NOT solved by ES2a. This wiring exists
		// to exercise the partition ROUTING contract, not to establish independent tenant root trust.
		// The kernel owns its partition directory: create it (and parents) so the operator only has to
		// pass -partition-dir, not pre-create it. store.Open opens a file and does not mkdir its parent.
		if err := os.MkdirAll(*partitionDir, 0o755); err != nil {
			log.Fatalf("create partition dir %q: %v", *partitionDir, err)
		}
		cfg := make(map[string]partition.PartitionConfig, len(ids))
		for _, id := range ids {
			st, err := store.Open(filepath.Join(*partitionDir, id+".wal"))
			if err != nil {
				log.Fatalf("open partition store %q: %v", id, err)
			}
			_, priv, err := ed25519.GenerateKey(rand.Reader) // P4: replace with externalized per-tenant key provision.
			if err != nil {
				log.Fatalf("generate partition signer %q: %v", id, err)
			}
			cfg[id] = partition.PartitionConfig{Store: st, Signer: priv}
		}
		pi, err := partition.NewPartitionedIngest(cfg)
		if err != nil {
			log.Fatalf("init partitioned ingest: %v", err)
		}
		ingestpb.RegisterAppendServiceServer(gs, server.NewPartitionAppendServer(pi))
		log.Printf("agent-os kernel ingest listening on %s (append-only, PARTITIONED: %d tenants; in-memory per-tenant keys = attester==operator, real key provision is P4)", *addr, len(ids))
	} else {
		// SINGLE-CHAIN mode (default): Personal's live path. No partition_id is consulted. The kernel
		// (attester process) holds an Ed25519 signing key so its Checkpoint read-back is SIGNED — a
		// third party can verify the operator's ACTUAL chain head. The key is loaded from -signing-key
		// or generated in-memory at startup (see the HONEST log line below).
		signer, generated, err := loadOrGenerateSigner(*signingKeyPath)
		if err != nil {
			log.Fatalf("kernel signing key: %v", err)
		}
		if generated {
			// HONEST boundary (do NOT remove): the key lives in THIS process and was generated here.
			log.Printf("agent-os kernel: in-memory signing key generated — operator-held; attester!=actor holds to the PROCESS boundary (control plane cannot sign), real key externalization / HSM / KMS / remote-attestation = P4")
		} else {
			log.Printf("agent-os kernel: signing key loaded from %q — operator-held; attester!=actor holds to the PROCESS boundary (control plane cannot sign), real key externalization / HSM / KMS / remote-attestation = P4", *signingKeyPath)
		}
		chainStore, err := store.Open(*chainPath)
		if err != nil {
			log.Fatalf("open chain store: %v", err)
		}
		srv, err := server.NewIngestServer(chainStore, audit, server.WithSigner(signer))
		if err != nil {
			log.Fatalf("init ingest server: %v", err)
		}
		ingestpb.RegisterAppendServiceServer(gs, srv)
		log.Printf("agent-os kernel ingest listening on %s (append-only, signed checkpoint)", *addr)
	}

	if err := gs.Serve(lis); err != nil {
		log.Fatalf("serve: %v", err)
	}
}

// loadOrGenerateSigner returns the kernel's Ed25519 signing key. With an empty path it GENERATES an
// in-memory key (generated=true; the caller logs the honest in-memory/process-boundary/P4 line). With
// a path it loads a PEM or raw-DER PKCS#8 Ed25519 private key, FAIL-CLOSED on any malformed/wrong-type
// key (it never falls back to generating a key when an explicit path was given — a misconfigured key
// must surface, not silently mint a different identity).
func loadOrGenerateSigner(path string) (ed25519.PrivateKey, bool, error) {
	if path == "" {
		_, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, false, fmt.Errorf("generate in-memory signer: %w", err)
		}
		return priv, true, nil
	}
	raw, err := os.ReadFile(path) //nolint:gosec // operator-supplied key path, by design.
	if err != nil {
		return nil, false, fmt.Errorf("read signing key %q: %w", path, err)
	}
	der := raw
	if block, _ := pem.Decode(raw); block != nil {
		der = block.Bytes // PEM-wrapped PKCS#8; otherwise treat the bytes as raw DER.
	}
	key, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, false, fmt.Errorf("parse signing key %q (expect PKCS#8 Ed25519, PEM or DER): %w", path, err)
	}
	priv, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, false, fmt.Errorf("signing key %q is not Ed25519: %T", path, key)
	}
	if len(priv) != ed25519.PrivateKeySize {
		return nil, false, fmt.Errorf("signing key %q has wrong Ed25519 size", path)
	}
	return priv, false, nil
}

// splitPartitions parses the -partitions flag into a clean, de-duplicated tenant ID list (trimming
// whitespace, dropping empties). An empty flag => no partitions => single-chain mode.
func splitPartitions(s string) []string {
	seen := map[string]bool{}
	var out []string
	for _, raw := range strings.Split(s, ",") {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}
