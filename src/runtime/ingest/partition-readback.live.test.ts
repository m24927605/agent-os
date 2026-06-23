/**
 * SLICE-PK2 — the Enterprise per-tenant moat made REAL: EACH tenant of a PARTITIONED kernel independently
 * verifies ITS OWN signed chain with the SEPARATELY-RELEASED Go verifier, AND one tenant's chain CANNOT
 * be verified under another tenant's public key (per-tenant ATTESTER ISOLATION), cross-language.
 *
 * This is the step beyond K2 (which verified ONE single-chain kernel) and ES2b (which proved per-tenant
 * WRITE-face isolation at the kernel WAL): PK2 closes the loop on the READ + VERIFY face. The REAL Go
 * kernel runs in PARTITIONED mode (>=2 tenants, each with its OWN Ed25519 signing key); each tenant gets
 * >=1 distinct event; the PK2 partition-aware `createSignedChainReader({partitionId})` reconstructs each
 * tenant's `SignedChain` + that tenant's SELF-REPORTED pubkey; and the released, CHECKSUM-VERIFIED
 * verifier proves:
 *   (a) A's chain under A's pubkey   -> exit 0 (intact),
 *   (b) B's chain under B's pubkey   -> exit 0 (intact)  — each tenant verifies its OWN chain,
 *   (c) A's chain under B's pubkey   -> NON-ZERO (rejected) — PER-TENANT ATTESTER ISOLATION (the load-
 *       bearing assertion: a tenant cannot use ANOTHER tenant's key to verify/forge its chain),
 *   (d) cross-tenant ENTRIES isolation: A's read-back entries carry A's marker and NEVER B's,
 *   (e) TAMPER caught: flip a char in an entry of A's chain -> exit 1 (broken), non-vacuously.
 *
 * GATED (stays out of hermetic `pnpm run verify`): runs ONLY when ALL of
 *   AGENTOS_LIVE_PARTITION_VERIFY=1  AND  AGENTOS_LIVE_KERNEL_ENDPOINT  AND  AGENTOS_VERIFIER_BIN
 * are set — exactly what `scripts/e2e-live-partition-verify.sh` exports after it BUILDS + starts the
 * PARTITIONED kernel and BUILDS + CHECKSUM-VERIFIES the released verifier. Without the env this
 * `describe.skip`s, so `pnpm run verify` never builds a binary or spawns a process.
 *
 * HONEST BOUNDARY (mirrors the spec §3 Out-of-scope): each tenant's signing key is generated IN-MEMORY by
 * the kernel process (ES2a), so per-tenant attester != actor holds TO THE PROCESS BOUNDARY (the control
 * plane can only Append and holds no key). The kernel SELF-REPORTS each tenant's pubkey, so per-tenant key
 * externalization (HSM / per-tenant KMS / trust-root endorsement of which key is which tenant's) is P4 —
 * NOT solved here. PK2 proves: GIVEN each tenant's self-reported pubkey, each tenant's real chain is
 * independently verifiable INTACT, A's chain is REJECTED under B's key, and entries never cross.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AppendRequestShape,
  type AppendResponseShape,
  type AppendTransport,
  type AuditEvent,
  createAuditEvent,
  createIngestAppender,
} from "../../audit/index.js";
import { createSignedChainReader } from "./signed-read-transport.js";
import { createRpcAppendTransport } from "./transport.js";

// GATE: the explicit live flag AND a kernel endpoint AND a concrete verifier binary path must be present.
const ENDPOINT = process.env.AGENTOS_LIVE_KERNEL_ENDPOINT;
const VERIFIER_BIN = process.env.AGENTOS_VERIFIER_BIN;
const LIVE =
  process.env.AGENTOS_LIVE_PARTITION_VERIFY === "1" && Boolean(ENDPOINT) && Boolean(VERIFIER_BIN);
const d = LIVE ? describe : describe.skip;

// The two tenant partition IDs the harness provisions (kernel --partitions "tenant-a,tenant-b"). A unique
// per-tenant, NON-secret marker rides the AuditEvent `resource` => the canonical bytes => the read-back
// entries, so we can prove A's chain holds A's marker and NOT B's (cross-tenant entries isolation).
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const MARKER_A = `pk2-tenant-a-${"a".repeat(8)}`;
const MARKER_B = `pk2-tenant-b-${"b".repeat(8)}`;

function mkEvent(tenantId: string, marker: string): AuditEvent {
  return createAuditEvent({
    actorId: "agent:pk2",
    tenantId,
    projectId: `proj-${tenantId}`,
    taskId: `task-${tenantId}`,
    requestId: `req-${tenantId}-${Date.now()}`,
    action: "tool:invoke",
    // The unique per-tenant marker lands in the canonical bytes (=> the read-back entries' event).
    resource: marker,
    policyDecision: { effect: "allow", reason: "ok" },
    result: "success",
  });
}

/**
 * Wrap an `AppendTransport` so every request it forwards carries `partitionId` (the PK2 / ES2b field-4
 * stamp). Closure-bound to ONE tenant — it can only ever route to that tenant's chain. Mirrors the
 * production `createPartitionedIngestSink`'s `partitionStampingTransport`, inlined so the live proof has
 * no dependency beyond the ingest seam under test.
 */
function partitionStamping(inner: AppendTransport, partitionId: string): AppendTransport {
  return {
    append: (req: AppendRequestShape): Promise<AppendResponseShape> =>
      inner.append({ ...req, partitionId }),
  };
}

/** Append >=1 governed/audit event to ONE tenant's partition via the REAL grpc-js ingest appender. */
async function appendToTenant(tenantId: string, marker: string): Promise<void> {
  const appender = createIngestAppender<AuditEvent>({
    transport: partitionStamping(
      createRpcAppendTransport({ endpoint: ENDPOINT as string }),
      tenantId,
    ),
    // A distinct per-tenant sourceId so the kernel's per-source monotonic sequence is scoped per tenant.
    sourceId: `pk2:${tenantId}`,
  });
  await appender.append(mkEvent(tenantId, marker));
}

/** Spawn the RELEASED verifier across a PROCESS boundary: `--pubkey <pem> --chain <json>`. */
function runVerifier(pemPath: string, chainPath: string): ReturnType<typeof spawnSync> {
  return spawnSync(VERIFIER_BIN as string, ["--pubkey", pemPath, "--chain", chainPath], {
    encoding: "utf8",
  });
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pk2-partition-readback-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

d(
  "PK2 — each Enterprise tenant independently verifies ITS OWN partition chain (per-tenant attester isolation)",
  () => {
    it("(a/b) INTACT per tenant, (c) A's chain REJECTED under B's pubkey, (d) entries never cross, (e) tamper -> broken", async () => {
      // Append a distinct, per-tenant event to EACH tenant's INDEPENDENT partition chain.
      await appendToTenant(TENANT_A, MARKER_A);
      await appendToTenant(TENANT_B, MARKER_B);

      // PK2 partition-aware read-back: reconstruct EACH tenant's SignedChain + that tenant's SELF-REPORTED
      // pubkey (the partitioned kernel returns the partition's OWN public_key from its OWN signing key).
      const a = await createSignedChainReader({
        endpoint: ENDPOINT as string,
        partitionId: TENANT_A,
      });
      const b = await createSignedChainReader({
        endpoint: ENDPOINT as string,
        partitionId: TENANT_B,
      });
      expect(a.chain.entries.length).toBeGreaterThanOrEqual(1);
      expect(b.chain.entries.length).toBeGreaterThanOrEqual(1);
      expect(a.chain.checkpoint.signature.length).toBeGreaterThan(0);
      expect(b.chain.checkpoint.signature.length).toBeGreaterThan(0);
      // Two INDEPENDENT signers: the per-tenant pubkeys differ (each partition has its own key).
      expect(a.publicKeyPem).not.toBe(b.publicKeyPem);

      // (d) CROSS-TENANT ENTRIES ISOLATION: A's read-back holds A's marker and NEVER B's (and v.v.). The
      //     canonical bytes carry the per-tenant marker; the partitioned ListEntries returns ONLY that
      //     tenant's entries — so a leak (B's marker in A's chain) would fail here.
      const aEntriesJson = JSON.stringify(a.chain.entries);
      const bEntriesJson = JSON.stringify(b.chain.entries);
      expect(aEntriesJson.includes(MARKER_A)).toBe(true);
      expect(aEntriesJson.includes(MARKER_B)).toBe(false);
      expect(bEntriesJson.includes(MARKER_B)).toBe(true);
      expect(bEntriesJson.includes(MARKER_A)).toBe(false);

      // Materialize each tenant's chain JSON + pubkey PEM for the released verifier.
      const aChainPath = join(tmp, "a-chain.json");
      const aPemPath = join(tmp, "a.pem");
      const bChainPath = join(tmp, "b-chain.json");
      const bPemPath = join(tmp, "b.pem");
      writeFileSync(aChainPath, JSON.stringify(a.chain));
      writeFileSync(aPemPath, a.publicKeyPem);
      writeFileSync(bChainPath, JSON.stringify(b.chain));
      writeFileSync(bPemPath, b.publicKeyPem);

      // (a) A's chain under A's pubkey -> exit 0 INTACT (A verifies its OWN chain, cross-language).
      const aIntact = runVerifier(aPemPath, aChainPath);
      expect(aIntact.error).toBeUndefined();
      expect(aIntact.status).toBe(0);

      // (b) B's chain under B's pubkey -> exit 0 INTACT (B verifies its OWN chain).
      const bIntact = runVerifier(bPemPath, bChainPath);
      expect(bIntact.error).toBeUndefined();
      expect(bIntact.status).toBe(0);

      // (c) PER-TENANT ATTESTER ISOLATION (the load-bearing proof): A's chain under B's pubkey -> NON-ZERO.
      //     A's checkpoint signature was made by A's key; verifying it under B's key fails the Ed25519
      //     checkpoint signature. A tenant CANNOT use another tenant's key to verify/forge its chain.
      const crossAB = runVerifier(bPemPath, aChainPath);
      expect(crossAB.error).toBeUndefined();
      expect(crossAB.status).not.toBe(0);
      // Symmetric: B's chain under A's pubkey -> NON-ZERO (isolation is mutual, not one-directional).
      const crossBA = runVerifier(aPemPath, bChainPath);
      expect(crossBA.error).toBeUndefined();
      expect(crossBA.status).not.toBe(0);

      // (e) TAMPER caught on A's chain (non-vacuity): flip the last hex char of an entry's entryHash so
      //     the verifier's recompute-and-compare MUST mismatch -> exit 1 (broken; NOT 0, NOT 2).
      const tampered = JSON.parse(JSON.stringify(a.chain)) as {
        entries: Array<{ entryHash: string }>;
      };
      const e0 = tampered.entries[0];
      expect(e0).toBeDefined();
      if (!e0) return;
      const original = e0.entryHash;
      e0.entryHash = original.slice(0, -1) + (original.slice(-1) === "0" ? "1" : "0");
      expect(e0.entryHash).not.toBe(original);
      const tamperedPath = join(tmp, "a-tampered.json");
      writeFileSync(tamperedPath, JSON.stringify(tampered));

      const aBroken = runVerifier(aPemPath, tamperedPath);
      expect(aBroken.error).toBeUndefined();
      expect(aBroken.status).toBe(1); // 1 == broken (NOT 0 intact, NOT 2 bad-input)
    });
  },
);
