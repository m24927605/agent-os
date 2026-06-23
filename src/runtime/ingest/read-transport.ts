/**
 * WORM read-back reader (slice P2R-PV-S3b) — the read counterpart of the RPC AppendTransport.
 *
 * This is the runtime-side seam that lets a composition root reconstruct a timeline from the REAL
 * kernel WORM (not an in-memory log): it calls the kernel `ListEntries` RPC over the SAME grpc-js
 * channel as Append (the vendor `@grpc/grpc-js` stays confined to `grpc-client.ts` — this module names
 * only the vendor-neutral generated `AppendService` contract, so `no-vendor-in-core` holds and the
 * grpc-js boundary is intact), then folds each returned `Entry` into a core `LogEntry`:
 *   - `JSON.parse(textDecode(canonical_event))` -> the (already-redacted) `AuditEvent`,
 *   - carry `sequence`, `prev_hash`, `entry_hash` verbatim from the durable record.
 *
 * FAIL-CLOSED (the load-bearing invariant): a `ListEntries` RPC reject, a missing response, OR a
 * canonical_event that is not valid JSON makes the WHOLE read REJECT. It NEVER returns a partial array
 * — a downstream timeline must reconstruct from a COMPLETE consistent snapshot or from nothing. The
 * kernel already guarantees ListEntries returns a consistent snapshot or an Internal error (never a
 * partial slice); this reader preserves that contract across the parse step.
 */
import type { AuditEvent, LogEntry } from "../../audit/index.js";
import type { AppendService } from "../_generated/ingest/ingest.js";
import { grpcAppendService } from "./grpc-client.js";

export interface EntriesReaderOpts {
  /** Kernel AppendService endpoint (host:port). Used to build the grpc-js client when `client` is absent. */
  readonly endpoint: string;
  /** Read the chain tail with sequence >= fromSequence; defaults to 0 (the whole log). */
  readonly fromSequence?: number;
  /**
   * Injected typed `AppendService` (the generated contract). Production omits it and a grpc-js client
   * is built from `endpoint`; tests inject an in-process stub (no network). Mirrors transport.ts.
   */
  readonly client?: AppendService;
}

/**
 * Build a reader `() => Promise<readonly LogEntry[]>` backed by the kernel `ListEntries` RPC. Resolves
 * the COMPLETE chain snapshot folded into `LogEntry[]`; REJECTS (fail-closed) on any RPC failure or any
 * non-JSON canonical_event — never a partial array.
 */
export function createEntriesReader(opts: EntriesReaderOpts): () => Promise<readonly LogEntry[]> {
  const fromSequence = opts.fromSequence ?? 0;
  // Build the real grpc-js-backed client lazily ONLY when none is injected (keeps tests network-free).
  const client = opts.client ?? grpcAppendService(opts.endpoint);
  const dec = new TextDecoder();

  return async (): Promise<readonly LogEntry[]> => {
    // partitionId: "" — single-chain (Personal) reader; the partitioned (Enterprise) field stays empty
    // and is omitted on the wire (proto3 default), so this single-chain read is byte-identical (PK1).
    const resp = await client.ListEntries({ fromSequence, partitionId: "" });
    // Fold the consistent snapshot. A throw here (a non-JSON canonical_event) propagates as a reject,
    // so the WHOLE read fails closed — we never resolve a partially-folded slice.
    return resp.entries.map((entry): LogEntry => {
      const event = JSON.parse(dec.decode(entry.canonicalEvent)) as AuditEvent;
      return {
        sequence: entry.sequence,
        event,
        prevHash: entry.prevHash,
        entryHash: entry.entryHash,
      };
    });
  };
}
