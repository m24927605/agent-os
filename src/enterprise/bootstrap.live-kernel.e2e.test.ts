/**
 * LIVE Go-kernel end-to-end for the ENTERPRISE VERTICAL per-tenant WORM partitions (SLICE-ES2b).
 *
 * ES1 wired `createEnterpriseFleet` over a purely IN-MEMORY per-tenant WORM (a `Map<partitionId,
 * InMemoryAppendOnlyLog>`). ES2b proves the SAME composition root, with each tenant's WORM sink INJECTED
 * to a REAL grpc-js partitioned ingest appender (`createPartitionedIngestSink(transport, binding)`),
 * lands each tenant's governed event into its OWN INDEPENDENT chain inside the REAL running
 * `kernel/cmd/kernel --partitions "tenant-a,tenant-b"` PartitionedIngest — i.e. cross-tenant isolation
 * holds at the KERNEL layer (each partition has its own head + its own Ed25519 key), not merely in
 * in-memory test doubles. This is the Enterprise analogue of Personal's S2 live append.
 *
 * GATED on AGENTOS_LIVE_KERNEL: under plain `pnpm run verify` (no env) this SKIPS, keeping the gate
 * hermetic (no kernel build, no spawn). Run it with the real kernel via `pnpm run e2e:live-enterprise`
 * (scripts/e2e-live-enterprise.sh builds + spawns ONE partitioned kernel with a per-partition chain
 * dir, sets the env, runs this file, tears down).
 *
 * The partitioned AppendService implements ONLY Append (no per-partition ListEntries RPC; per-tenant
 * live read-back projection is out-of-scope, ES2b §3). So the cross-tenant isolation proof reads each
 * partition's DURABLE WAL FILE directly (the harness exports the partition dir) — the kernel's own
 * durable record of what each tenant's chain holds.
 *
 * What it asserts on the live wire:
 *   (a) tenant-A submit -> approve drives the FULL Enterprise spine and the receipt comes from tenant-A's
 *       REAL partition chain (DecideOutcome `executed`, append receipt in hand);
 *   (b) tenant-B's partition is INDEPENDENT: B's own submit -> approve also succeeds at sequence 0 (B's
 *       per-source monotonic counter is untouched by A's append — separate chains, not a shared one);
 *   (c) KERNEL-LEVEL cross-tenant isolation: tenant-A's unique canonical marker is present in tenant-A's
 *       partition WAL and ABSENT from tenant-B's partition WAL (A's event never enters B's chain);
 *   (d) credential-blind: the runtime-assembled secret canary never appears in EITHER partition WAL.
 *
 * HONEST LIMITATION (restated, NOT re-solved): the kernel's per-tenant Ed25519 keys are generated
 * in-memory by the operator process at wire time (ES2a) — at this layer attester==operator. Real
 * per-tenant key provision / KMS / root-trust externalization is P4. ES2b proves the partition ROUTING
 * + write-face isolation contract, not independent tenant root trust.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPartitionedIngestSink } from "../enterprise/index.js";
import type { GovernedCall } from "../orchestration/index.js";
import { createRpcAppendTransport } from "../runtime/ingest/transport.js";
import type { TenantBinding } from "../tenant/index.js";
import { createEnterpriseFleet } from "./bootstrap.js";

const ENDPOINT = process.env.AGENTOS_LIVE_KERNEL_ENDPOINT;
const PARTITION_DIR = process.env.AGENTOS_LIVE_PARTITION_DIR;
const LIVE = process.env.AGENTOS_LIVE_KERNEL;

// Skip cleanly when not driven by the harness -> `pnpm run verify` stays hermetic (no spawn/build).
const d = LIVE && ENDPOINT && PARTITION_DIR ? describe : describe.skip;

// A runtime-ASSEMBLED secret canary — never a literal in source, so scan_secrets.sh stays clean.
const SECRET_CANARY = `sk-${"d".repeat(24)}`;
// A unique, NON-secret per-tenant marker embedded in the governed tool string (=> the AuditEvent
// `resource`, => the canonical bytes => the partition WAL JSON). Lets us find A's event in A's WAL and
// prove its ABSENCE from B's WAL. `fleet:` prefix keeps the PDP allow rule (`fleet:*`) satisfied.
const MARKER_A = `fleet:run-tenant-a-${"a".repeat(8)}`;
const MARKER_B = `fleet:run-tenant-b-${"b".repeat(8)}`;

function ctxFor(tenantId: string) {
  return {
    actorId: "agent:enterprise-live",
    tenantId,
    projectId: `proj-${tenantId}`,
    taskId: `task-${tenantId}-live`,
    requestId: `req-${tenantId}-live`,
  };
}

/** A GovernedCall whose `tool` carries the per-tenant marker; `args` rides the screen guard. */
function callFor(
  tenantId: string,
  marker: string,
  args: Record<string, unknown> = {},
): GovernedCall {
  return { tool: marker, context: ctxFor(tenantId), ...{ args } } as GovernedCall;
}

/**
 * Read a partition's durable WAL file as a string (length-prefixed JSON records; text-searchable).
 * The kernel keys partitions by the fleet's binding.partitionId (ES1: partition-<tenantId>), so the WAL
 * filename is partition-<tenantId>.wal — matching what createPartitionedIngestSink stamps on the wire.
 */
function readPartitionWal(tenantId: string): string {
  return readFileSync(join(PARTITION_DIR as string, `partition-${tenantId}.wal`), "utf8");
}

d(
  "ES2b — Enterprise fleet -> live Go-kernel per-tenant WORM partitions (cross-tenant isolation)",
  () => {
    it("tenant-A append lands in A's REAL partition; B's partition is independent; A's event never enters B's chain (canary-free)", async () => {
      // The LIVE per-tenant sinks: each binding -> a partitioned ingest sink over the SAME kernel endpoint,
      // stamping that tenant's partition_id. createEnterpriseFleet synthesizes the AuditEvents; these sinks
      // ship them across the real wire to the partitioned kernel's per-tenant chains.
      const fleet = createEnterpriseFleet({
        tenants: ["tenant-a", "tenant-b"],
        wormSinkFor: (binding: TenantBinding) =>
          createPartitionedIngestSink(
            createRpcAppendTransport({ endpoint: ENDPOINT as string }),
            binding,
          ),
      });

      // (a) tenant-A governed action -> A's REAL partition chain.
      const subA = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a", MARKER_A));
      expect(subA.status).toBe("pending");
      if (subA.status !== "pending") return;
      const decidedA = await fleet.approve(ctxFor("tenant-a"), subA.id);
      expect(decidedA.status).toBe("executed");
      if (decidedA.status !== "executed") return;
      expect(decidedA.outcome.status).toBe("executed");
      if (decidedA.outcome.status !== "executed") return;
      // The receipt came from a REAL partition chain (sequence 0 for tenant-A's first append in its chain).
      expect(decidedA.outcome.receipt.sequence).toBe(0);
      expect(decidedA.outcome.receipt.entryHash.startsWith("sha256:")).toBe(true);

      // (b) tenant-B's partition is INDEPENDENT: B's first append also settles at sequence 0 (a SHARED
      // chain/source counter would have advanced past 0 after A's append).
      const subB = fleet.submitForApproval(ctxFor("tenant-b"), callFor("tenant-b", MARKER_B));
      expect(subB.status).toBe("pending");
      if (subB.status !== "pending") return;
      const decidedB = await fleet.approve(ctxFor("tenant-b"), subB.id);
      expect(decidedB.status).toBe("executed");
      if (decidedB.status !== "executed") return;
      expect(decidedB.outcome.status).toBe("executed");
      if (decidedB.outcome.status !== "executed") return;
      expect(decidedB.outcome.receipt.sequence).toBe(0);

      // (c) KERNEL-LEVEL cross-tenant isolation, read from the DURABLE per-partition WAL files:
      const walA = readPartitionWal("tenant-a");
      const walB = readPartitionWal("tenant-b");
      // A's marker is in A's chain...
      expect(walA.includes(MARKER_A)).toBe(true);
      // ...and B's marker is in B's chain...
      expect(walB.includes(MARKER_B)).toBe(true);
      // ...but A's event NEVER entered B's chain, and vice-versa (the load-bearing isolation assertion).
      expect(walB.includes(MARKER_A)).toBe(false);
      expect(walA.includes(MARKER_B)).toBe(false);

      // (d) credential-blind end to end: the secret canary never appears in EITHER partition WAL (the
      // kernel holds already-redacted canonical bytes; partition_id/sourceId are non-secret routing keys).
      const subSecret = fleet.submitForApproval(
        ctxFor("tenant-a"),
        callFor("tenant-a", `${MARKER_A}-2`, { note: SECRET_CANARY }),
      );
      if (subSecret.status === "pending") {
        // Denied@screen (the secret never reaches the WORM) — the action does not even commit.
        const decidedSecret = await fleet.approve(ctxFor("tenant-a"), subSecret.id);
        expect(decidedSecret.status).toBe("denied");
      }
      expect(readPartitionWal("tenant-a").includes(SECRET_CANARY)).toBe(false);
      expect(readPartitionWal("tenant-b").includes(SECRET_CANARY)).toBe(false);
    });
  },
);
