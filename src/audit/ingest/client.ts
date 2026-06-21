/**
 * Sync-commit IngestClient core (slice P2R-R2-S2, design §2/§4/§6).
 *
 * `createIngestClient({transport, sourceId})` returns an object satisfying
 * `CommitAppender<AuditEvent, AppendReceipt>` (../../commitgate). Its `append(event)`:
 *   1. `canonicalizeAuditEvent(event)` — redact is ALREADY inside canonical (../canonical.ts), so the
 *      bytes sent are the kernel's "already-redacted canonical bytes"; the client never re-redacts.
 *   2. assigns a per-source monotonic `sequence` (client-held counter from 0, aligned with the Go
 *      server's per-source monotonic expectation, kernel/internal/server/append.go).
 *   3. `transport.append({sourceId, sequence, canonicalEvent})` (the injected vendor-neutral port).
 *   4. `parseAppendResponse` (S1) -> durable `AppendReceipt`.
 *
 * Fail-closed / deny-by-default: any transport reject OR parse throw PROPAGATES (commitgate aborts;
 * the external effect never becomes observable). The counter advances ONLY on success — a reject
 * leaves it unchanged so a retry resends the SAME sequence (the kernel is the dedup authority).
 *
 * This is the production replacement for the P2-I in-memory appender: same `AppendReceipt` shape and
 * single-argument `append(event)` signature as `AppendOnlyLog.append`, so wiring it in is zero-type-
 * change. Dedup (S3) and a capped outbox (S4) layer on top; the concrete RPC transport is S6.
 */
import type { CommitAppender } from "../../commitgate/index.js";
import { canonicalizeAuditEvent } from "../canonical.js";
import type { AuditEvent } from "../event.js";
import type { AppendReceipt } from "../kernel/log.js";
import { parseAppendResponse } from "./parse.js";
import type { AppendTransport } from "./transport.js";

export interface IngestClientDeps {
  readonly transport: AppendTransport;
  /** Bound at construction so `append(event)` keeps the single-arg CommitAppender signature. */
  readonly sourceId: string;
}

export function createIngestClient(
  deps: IngestClientDeps,
): CommitAppender<AuditEvent, AppendReceipt> {
  const { transport, sourceId } = deps;
  // Per-source monotonic counter; advanced ONLY after a durable receipt (fail-closed on reject).
  let sequence = 0;

  return {
    async append(event: AuditEvent): Promise<AppendReceipt> {
      const canonicalEvent = canonicalizeAuditEvent(event);
      // Both `transport.append` (transport error) and `parseAppendResponse` (error oneof / empty /
      // CODE_UNSPECIFIED) reject/throw on failure — neither path reaches the counter advance below.
      const response = await transport.append({ sourceId, sequence, canonicalEvent });
      const receipt = parseAppendResponse(response);
      sequence += 1;
      return receipt;
    },
  };
}
