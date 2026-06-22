/**
 * Vendor-neutral transport PORT for the cross-plane append seam (slice P2R-R2-S1).
 *
 * This is the ONLY surface the core IngestClient (S2+) depends on. It binds no concrete RPC client
 * (connect-es / grpc-js) — those land as an injected adapter under src/runtime/ (S6), keeping the
 * `no-vendor-in-core` boundary intact (.dependency-cruiser.cjs). The shapes mirror
 * proto/ingest.proto:15-45 (AppendRequest / AppendResponse oneof{receipt|error}) so the eventual
 * RPC adapter is a thin mapping with no semantic gap.
 *
 * Scope: TYPES ONLY. No canonicalize, no dedup, no network, no behavior. Parsing of a returned
 * AppendResponseShape (fail-closed) lives in ./parse.ts.
 */

/**
 * The append request shape — mirrors proto AppendRequest (proto/ingest.proto:15-18).
 * `canonicalEvent` is ALREADY-redacted canonical bytes (the kernel never holds the raw secret);
 * this port does not produce them — the IngestClient (S2) supplies them from canonicalizeAuditEvent.
 */
export type AppendRequestShape = {
  readonly sourceId: string;
  readonly sequence: number;
  readonly canonicalEvent: Uint8Array;
  /**
   * OPTIONAL kernel tenant-partition routing (proto AppendRequest.partition_id, field 4; SLICE-ES2b).
   * ABSENT/empty => the single-chain (Personal) path: the RPC adapter sends the proto3 default "" so a
   * single-chain server ignores it and the wire stays byte-identical. SET (the Enterprise per-tenant
   * path) => the partitioned kernel routes the append to that tenant's independent WORM chain. Optional
   * so existing 3-field (Personal) callers are unaffected.
   */
  readonly partitionId?: string;
};

/**
 * The append response shape — mirrors proto AppendResponse.oneof{receipt|error}
 * (proto/ingest.proto:40-45). Exactly one of `receipt` / `error` is expected to be set; any other
 * combination (both, neither, or CODE_UNSPECIFIED) is denied by ./parse.ts (fail-closed).
 */
export type AppendResponseShape = {
  receipt?: {
    sequence: number;
    contentHash: string;
    prevHash: string;
    entryHash: string;
  };
  error?: { code: string; detail: string };
};

/**
 * Append-only transport port. Exposes ONLY `append` — there is intentionally no
 * Update/Delete/Overwrite (mirrors kernel/internal/client/client.go:24-27), so a caller cannot
 * bypass the append-only surface. Connection / timeout handling is an adapter (S6) concern; this
 * port's contract is "given a request, resolve an AppendResponseShape (or reject on transport error)".
 */
export interface AppendTransport {
  append(req: AppendRequestShape): Promise<AppendResponseShape>;
}
