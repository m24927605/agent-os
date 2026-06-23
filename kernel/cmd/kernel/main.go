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
	"github.com/agent-os/kernel/internal/signer"
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
	// -signer-command externalizes signing to an OUT-OF-PROCESS command (argv, space-separated): the
	// private key NEVER enters the kernel process. The command implements `<cmd> pubkey` (stdout =
	// SPKI/PKIX DER) and `<cmd> sign` (message on stdin -> raw 64-byte signature on stdout). When set,
	// it takes precedence over -signing-key. Single-chain mode only.
	signerCommand := flag.String("signer-command", "", "out-of-process signer command (argv); the private key never enters the kernel process. Implements `<cmd> pubkey` and `<cmd> sign`. Takes precedence over -signing-key")
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
			// Wrap in the in-process port (today's behavior; the raw key is no longer a partition field).
			cfg[id] = partition.PartitionConfig{Store: st, Signer: signer.NewInProcessSigner(priv)}
		}
		pi, err := partition.NewPartitionedIngest(cfg)
		if err != nil {
			log.Fatalf("init partitioned ingest: %v", err)
		}
		ingestpb.RegisterAppendServiceServer(gs, server.NewPartitionAppendServer(pi))
		log.Printf("agent-os kernel ingest listening on %s (append-only, PARTITIONED: %d tenants; in-memory per-tenant keys = attester==operator, real key provision is P4)", *addr, len(ids))
	} else {
		// SINGLE-CHAIN mode (default): Personal's live path. No partition_id is consulted. The kernel
		// (attester process) signs its Checkpoint read-back via a CheckpointSigner PORT — a third party
		// can verify the operator's ACTUAL chain head. The signer is selected by flag (see the HONEST
		// log lines below): -signer-command (out-of-process, key NOT in this process) takes precedence
		// over -signing-key (in-process, operator-held), then generated in-memory (in-process).
		ckptSigner, err := selectSigner(*signerCommand, *signingKeyPath)
		if err != nil {
			log.Fatalf("kernel signing key: %v", err)
		}
		chainStore, err := store.Open(*chainPath)
		if err != nil {
			log.Fatalf("open chain store: %v", err)
		}
		srv, err := server.NewIngestServer(chainStore, audit, server.WithSigner(ckptSigner))
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

// selectSigner picks the kernel's CheckpointSigner and emits the HONEST boundary log line for the
// chosen mode. Precedence: -signer-command (out-of-process) > -signing-key (in-process file) >
// generated in-memory (in-process). FAIL-CLOSED: a misconfigured external command or key file surfaces
// an error rather than silently minting a different identity or running unsigned.
//
//   - -signer-command: the private key is NOT in the kernel process; it lives behind the external
//     command. attester != actor holds at the process boundary, and the key is OUT of this process —
//     but operator-unforgeability depends on how that command protects its key (HSM/KMS/IAM) =
//     deployment (TR2). TR1 does NOT claim a pure-software command is operator-unforgeable.
//   - -signing-key / generated: the private key lives IN this process (operator-held), so at this layer
//     attester == operator (P4). Real operator-inaccessible externalization is TR2 / deployment.
func selectSigner(signerCommand, signingKeyPath string) (signer.CheckpointSigner, error) {
	if signerCommand != "" {
		argv := strings.Fields(signerCommand)
		cs, err := signer.NewCommandSigner(argv)
		if err != nil {
			return nil, fmt.Errorf("init out-of-process signer command %q: %w", signerCommand, err)
		}
		// HONEST boundary (do NOT remove): the private key is NOT in the kernel process.
		log.Printf("agent-os kernel: out-of-process signer command %q — the private key is NOT in the kernel process; attester!=actor holds at the PROCESS boundary, and operator-unforgeability depends on the external command's key protection (HSM/KMS/IAM) = DEPLOYMENT (TR2). TR1 does NOT claim a pure-software command is operator-unforgeable", signerCommand)
		return cs, nil
	}
	priv, generated, err := loadOrGenerateKey(signingKeyPath)
	if err != nil {
		return nil, err
	}
	if generated {
		// HONEST boundary (do NOT remove): the key lives in THIS process and was generated here.
		log.Printf("agent-os kernel: in-memory signing key generated — IN-PROCESS key, operator-held; at this layer attester==operator. attester!=actor holds to the PROCESS boundary (control plane cannot sign); real key externalization / HSM / KMS / remote-attestation = TR2/deployment")
	} else {
		log.Printf("agent-os kernel: signing key loaded from %q — IN-PROCESS key, operator-held; at this layer attester==operator. attester!=actor holds to the PROCESS boundary (control plane cannot sign); real key externalization / HSM / KMS / remote-attestation = TR2/deployment", signingKeyPath)
	}
	return signer.NewInProcessSigner(priv), nil
}

// loadOrGenerateKey returns the kernel's in-process Ed25519 signing key. With an empty path it
// GENERATES an in-memory key (generated=true). With a path it loads a PEM or raw-DER PKCS#8 Ed25519
// private key, FAIL-CLOSED on any malformed/wrong-type key (it never falls back to generating a key
// when an explicit path was given — a misconfigured key must surface, not silently mint a different
// identity). The raw key is wrapped in an InProcessSigner by the caller and never escapes main.
func loadOrGenerateKey(path string) (ed25519.PrivateKey, bool, error) {
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
