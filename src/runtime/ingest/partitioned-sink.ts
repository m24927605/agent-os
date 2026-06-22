/**
 * createPartitionedIngestSink — the Enterprise per-tenant LIVE WORM sink factory (SLICE-ES2b).
 *
 * This is the Enterprise analogue of Personal's `wormSink` builder (`createPersonalShell` injects
 * `createIngestAppender(...).append`). Given an injected, vendor-neutral `AppendTransport` (the
 * concrete grpc-js RPC adapter is `createRpcAppendTransport`, supplied by the composition root) and a
 * `TenantBinding`, it returns a `(event: AuditEvent) => Promise<AppendReceipt>` sink that ships every
 * AuditEvent across the wire to the kernel's PARTITIONED AppendService bound to THIS tenant:
 *
 *   - `partitionId = binding.partitionId` rides on EVERY request (proto AppendRequest.partition_id,
 *     field 4) so the partitioned kernel routes the append to this tenant's INDEPENDENT WORM chain
 *     (its own head + its own Ed25519 signing key). Closure-bound to ONE binding: the sink has no
 *     argument by which to name another tenant, so cross-tenant write is structurally impossible.
 *   - `sourceId` is PER-TENANT, derived deterministically from `binding.tenantId` (NON-secret routing
 *     metadata, never a credential), so the kernel's monotonic per-source sequence is scoped per tenant.
 *
 * Credential-blind: the canonical bytes are the ALREADY-redacted S0.2 canonical (redact is inside
 * `canonicalizeAuditEvent`, reused via `createIngestAppender`), so the kernel never holds the raw
 * secret; partitionId / sourceId are routing metadata, not secrets.
 *
 * Fail-closed: `createIngestAppender`'s `append` REJECTS on any transport reject/timeout, a dedup
 * conflict, or a non-receipt response (the S1 parser). That reject propagates out of this sink
 * unchanged — the Enterprise `commitBeforeEffect` guard then refuses the effect (no receipt => no
 * observable effect). The sink NEVER resolves a falsy receipt.
 *
 * Vendor-neutral: depends ONLY on the injected `AppendTransport` port + the audit barrel's composed
 * appender. It names no vendor (the grpc-js adapter is wired one layer up), and reaches into no module
 * internals — `createIngestAppender` + the ingest port come through the audit public barrel, so
 * dependency-cruiser `not-to-internal` / `no-vendor-in-core` hold.
 */
import {
  type AppendReceipt,
  type AppendRequestShape,
  type AppendResponseShape,
  type AppendTransport,
  type AuditEvent,
  createIngestAppender,
} from "../../audit/index.js";
import type { TenantBinding } from "../../tenant/index.js";

/**
 * Derive a deterministic, NON-secret per-tenant ingest sourceId from the binding. Distinct per tenant
 * (so the kernel's per-source monotonic sequence is scoped to the tenant) and stable across a tenant's
 * appends (so its own sequence stays monotonic). It is routing metadata — never a credential.
 */
function perTenantSourceId(binding: TenantBinding): string {
  return `enterprise:${binding.tenantId}`;
}

/**
 * Wrap an `AppendTransport` so EVERY request it forwards carries `partitionId = binding.partitionId`.
 * The inner `createIngestClient`/`createIngestAppender` builds a 3-field `AppendRequestShape`
 * (sourceId/sequence/canonicalEvent); this wrapper STAMPS the 4th field (the OPTIONAL partitionId) on
 * the way out, so the per-tenant routing key is added without touching the canonicalize/sequence/dedup
 * machinery. Closure-bound to one partitionId — it can only ever stamp this tenant.
 */
function partitionStampingTransport(inner: AppendTransport, partitionId: string): AppendTransport {
  return {
    append(req: AppendRequestShape): Promise<AppendResponseShape> {
      return inner.append({ ...req, partitionId });
    },
  };
}

/**
 * Build the per-tenant live WORM sink. Mirrors how `createPersonalShell` turns an AuditEvent into a
 * live append, but threads the tenant's `partitionId` + a per-tenant `sourceId` so the governed event
 * lands in the tenant's OWN kernel partition chain.
 */
export function createPartitionedIngestSink(
  transport: AppendTransport,
  binding: TenantBinding,
): (event: AuditEvent) => Promise<AppendReceipt> {
  // Compose the SAME canonicalize/redact/sequence/dedup appender Personal uses, but over a transport
  // that stamps THIS tenant's partitionId on every request and with a PER-TENANT sourceId.
  const appender = createIngestAppender<AuditEvent>({
    transport: partitionStampingTransport(transport, binding.partitionId),
    sourceId: perTenantSourceId(binding),
  });
  return (event: AuditEvent): Promise<AppendReceipt> => appender.append(event);
}
