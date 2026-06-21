/**
 * Public surface for the vendor-neutral ingest transport port + fail-closed response parse
 * (slice P2R-R2-S1). Core, zero-network, zero-vendor.
 *
 * NOTE: `AppendReceipt` is intentionally NOT re-exported here — it is already exported via the top
 * barrel through `./audit/kernel/log.js`, so re-exporting it would be a duplicate-export collision
 * (TS2308). Consumers import AppendReceipt from the kernel surface; from here they get only the new
 * transport-port symbols and the parser.
 */
export type { AppendRequestShape, AppendResponseShape, AppendTransport } from "./transport.js";
export { parseAppendResponse } from "./parse.js";
export { createIngestClient, type IngestClientDeps } from "./client.js";
export { createDedupTable, type DedupResult, type DedupTable } from "./dedup.js";
