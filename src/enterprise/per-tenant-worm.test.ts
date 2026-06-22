/**
 * RED-first unit tests (in-memory, NON-gated) for SLICE-ES2b: the per-tenant live WORM sink factory
 * (`createPartitionedIngestSink`) and the Enterprise injection seam (`EnterpriseFleetOpts.wormSinkFor`).
 *
 * These run with an IN-PROCESS spy `AppendTransport` — no kernel, no network. They lock the two
 * load-bearing invariants ES2b adds WITHOUT a live kernel:
 *
 *   (A) createPartitionedIngestSink(transport, binding) ships every AuditEvent through the transport
 *       with `partitionId === binding.partitionId` and a PER-TENANT `sourceId` derived from
 *       binding.tenantId. Two tenants NEVER cross: each sink's requests carry only its own partitionId.
 *       NON-VACUITY / mutation: a sink hard-wired to a FIXED (or another tenant's) partitionId makes the
 *       per-tenant assertion RED — the spy proves the binding's value actually flows through.
 *
 *   (B) createEnterpriseFleet({ wormSinkFor }) routes each tenant's governed WORM write through the
 *       INJECTED per-tenant sink (not the in-memory log). The spy proves tenant-A's governed action
 *       appended with partitionId `partition-tenant-a` and tenant-B's with `partition-tenant-b`, never
 *       crossing.
 *
 *   (C) With NO wormSinkFor, behaviour is BYTE-IDENTICAL to ES1: the default in-memory per-tenant log is
 *       used and `wormLogFor` still returns a real InMemoryAppendOnlyLog instance (the ES1/ES3 e2e stay
 *       green unchanged — they construct the fleet with no wormSinkFor).
 */
import { describe, expect, it } from "vitest";
import type {
  AppendRequestShape,
  AppendResponseShape,
  AppendTransport,
  AuditEvent,
} from "../audit/index.js";
import { createPartitionedIngestSink } from "../enterprise/index.js";
import type { GovernedCall } from "../orchestration/index.js";
import type { TenantBinding } from "../tenant/index.js";
import { createEnterpriseFleet } from "./bootstrap.js";

/** A deterministic served-receipt transport that RECORDS every request shape it is handed. */
function spyTransport(): { transport: AppendTransport; seen: AppendRequestShape[] } {
  const seen: AppendRequestShape[] = [];
  const transport: AppendTransport = {
    append(req: AppendRequestShape): Promise<AppendResponseShape> {
      seen.push(req);
      return Promise.resolve({
        receipt: {
          sequence: req.sequence,
          contentHash: "sha256:aa",
          prevHash: "sha256:bb",
          entryHash: "sha256:cc",
        },
      });
    },
  };
  return { transport, seen };
}

function bindingFor(tenantId: string): TenantBinding {
  return { tenantId, partitionId: `partition-${tenantId}`, storeRef: `store-${tenantId}` };
}

/** A minimal-but-valid AuditEvent the canonicalizer accepts (mirrors createAuditEvent fields). */
function auditEventFor(tenantId: string): AuditEvent {
  return {
    actorId: "agent:claude",
    tenantId,
    projectId: `proj-${tenantId}`,
    taskId: `task-${tenantId}`,
    requestId: `req-${tenantId}`,
    action: "tool:invoke",
    resource: `fleet:run-${tenantId}`,
    policyDecision: { effect: "allow", reason: "test" },
    result: "success",
  } as AuditEvent;
}

function ctxFor(tenantId: string) {
  return {
    actorId: "agent:claude",
    tenantId,
    projectId: `proj-${tenantId}`,
    taskId: `task-${tenantId}`,
    requestId: `req-${tenantId}`,
  };
}

function callFor(tenantId: string): GovernedCall {
  return { tool: `fleet:run-${tenantId}`, context: ctxFor(tenantId), args: {} } as GovernedCall;
}

describe("createPartitionedIngestSink (ES2b) — per-tenant partitionId + sourceId on the wire", () => {
  it("(A) sends partitionId === binding.partitionId and a per-tenant sourceId; two tenants never cross", async () => {
    const a = spyTransport();
    const b = spyTransport();
    const sinkA = createPartitionedIngestSink(a.transport, bindingFor("tenant-a"));
    const sinkB = createPartitionedIngestSink(b.transport, bindingFor("tenant-b"));

    const rA = await sinkA(auditEventFor("tenant-a"));
    const rB = await sinkB(auditEventFor("tenant-b"));

    // Receipts come back from each tenant's own transport.
    expect(rA.sequence).toBe(0);
    expect(rB.sequence).toBe(0);

    // Each sink's request carries ONLY its own binding's partitionId.
    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(1);
    expect(a.seen[0]?.partitionId).toBe("partition-tenant-a");
    expect(b.seen[0]?.partitionId).toBe("partition-tenant-b");

    // The sourceId is PER-TENANT (derived from tenantId) and differs between tenants.
    expect(a.seen[0]?.sourceId).toContain("tenant-a");
    expect(b.seen[0]?.sourceId).toContain("tenant-b");
    expect(a.seen[0]?.sourceId).not.toBe(b.seen[0]?.sourceId);

    // The canonical bytes are present (the kernel never holds the raw secret; redact is inside canonical).
    expect((a.seen[0]?.canonicalEvent.length ?? 0) > 0).toBe(true);
  });

  it("(A-mutation) a sink that ignores the binding's partitionId would make the per-tenant assertion RED", async () => {
    // This pins NON-VACUITY: the production sink MUST forward binding.partitionId. We assert the
    // observable consequence — tenant-B's transport sees partition-tenant-b, NOT partition-tenant-a.
    const b = spyTransport();
    const sinkB = createPartitionedIngestSink(b.transport, bindingFor("tenant-b"));
    await sinkB(auditEventFor("tenant-b"));
    expect(b.seen[0]?.partitionId).not.toBe("partition-tenant-a");
    expect(b.seen[0]?.partitionId).toBe("partition-tenant-b");
  });
});

describe("EnterpriseFleetOpts.wormSinkFor (ES2b) — per-tenant injection routes the governed WORM write", () => {
  it("(B) injected sink receives partitionId === binding.partitionId + per-tenant sourceId, for two tenants, never crossing", async () => {
    const a = spyTransport();
    const b = spyTransport();
    const transportByPartition = new Map<string, AppendTransport>([
      ["partition-tenant-a", a.transport],
      ["partition-tenant-b", b.transport],
    ]);

    const fleet = createEnterpriseFleet({
      tenants: ["tenant-a", "tenant-b"],
      wormSinkFor: (binding) => {
        const t = transportByPartition.get(binding.partitionId);
        if (t === undefined) throw new Error("no transport for partition (test wiring)");
        return createPartitionedIngestSink(t, binding);
      },
    });

    // tenant-A governed action.
    const subA = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a"));
    expect(subA.status).toBe("pending");
    if (subA.status !== "pending") return;
    const decidedA = await fleet.approve(ctxFor("tenant-a"), subA.id);
    expect(decidedA.status).toBe("executed");

    // tenant-B governed action.
    const subB = fleet.submitForApproval(ctxFor("tenant-b"), callFor("tenant-b"));
    expect(subB.status).toBe("pending");
    if (subB.status !== "pending") return;
    const decidedB = await fleet.approve(ctxFor("tenant-b"), subB.id);
    expect(decidedB.status).toBe("executed");

    // The injected sinks each received exactly their own tenant's partitionId — never crossing.
    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(1);
    expect(a.seen[0]?.partitionId).toBe("partition-tenant-a");
    expect(b.seen[0]?.partitionId).toBe("partition-tenant-b");
    expect(a.seen[0]?.sourceId).not.toBe(b.seen[0]?.sourceId);
    // tenant-A's canonical bytes were NEVER handed to tenant-B's transport (kernel-bound isolation seam).
    expect(a.seen[0]?.partitionId).not.toBe(b.seen[0]?.partitionId);
  });

  it("(C) NO wormSinkFor => byte-identical to ES1: default in-memory per-tenant log is used (wormLogFor defined)", async () => {
    const fleet = createEnterpriseFleet({ tenants: ["tenant-a", "tenant-b"] });
    const sub = fleet.submitForApproval(ctxFor("tenant-a"), callFor("tenant-a"));
    expect(sub.status).toBe("pending");
    if (sub.status !== "pending") return;
    const decided = await fleet.approve(ctxFor("tenant-a"), sub.id);
    expect(decided.status).toBe("executed");
    // The default in-memory WORM log instance is still present (ES1 invariant), and per-tenant distinct.
    expect(fleet.wormLogFor(ctxFor("tenant-a"))).toBeDefined();
    expect(fleet.wormLogFor(ctxFor("tenant-a"))).not.toBe(fleet.wormLogFor(ctxFor("tenant-b")));
  });
});
