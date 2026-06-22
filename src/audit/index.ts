/**
 * Audit module public surface (the depth-1 barrel cross-module consumers import through).
 *
 * Cross-module imports MUST go through this barrel, not a module-internal file (dependency-cruiser
 * `not-to-internal`). The runtime RPC transport adapter (src/runtime/ingest, slice P2R-R2-S6) consumes
 * the vendor-neutral ingest port + fail-closed parser from here; it never reaches into `./ingest/*`
 * internals. The top-level `src/index.ts` aggregates the individual audit files directly (it predates
 * this barrel and is the repo's own public surface), so this barrel intentionally re-exports only the
 * surfaces a sibling MODULE needs — today the ingest seam.
 */
export type {
  AppendRequestShape,
  AppendResponseShape,
  AppendTransport,
} from "./ingest/index.js";
export { parseAppendResponse } from "./ingest/index.js";
// The composed ingest appender (S7 `createIngestAppender`): canonicalize -> redact -> per-source
// monotonic sequence -> send via the injected AppendTransport -> fail-closed parse, as ONE
// CommitAppender. Sibling modules wiring a LIVE WORM sink (the Personal shell + the Enterprise
// per-tenant partitioned sink, SLICE-ES2b) consume it through this barrel — never the internal
// ./ingest/wire.ts — so dependency-cruiser `not-to-internal` holds.
export { createIngestAppender } from "./ingest/index.js";
export type { IngestAppender, IngestAppenderDeps } from "./ingest/index.js";
// Read-only WORM projection types (Audit Completeness invariant 3). The Personal surface
// TaskTimeline (slice P2R-R7-S5) folds these into plain-language events through this barrel,
// never the internal ./event.ts / ./kernel/log.ts, so dependency-cruiser `not-to-internal` holds.
export type { AuditEvent, AuditPolicyDecision, AuditResult } from "./event.js";
export type { AppendReceipt, LogEntry } from "./kernel/log.js";
// AuditEvent SYNTHESIS + the in-memory WORM log (additive, slice P2R-PV-S1). The Personal-shell
// composition root (`src/personal/bootstrap.ts`) wires the critical appender↔timeline seam: it
// synthesizes a real AuditEvent from the pipeline's structural event and appends it to a SHARED
// InMemoryAppendOnlyLog that `buildTaskTimeline` then reads. It MUST consume these through this
// public barrel — never the internal ./event.ts / ./kernel/log.ts — so `not-to-internal` holds.
export { createAuditEvent } from "./event.js";
export type { AuditClock, AuditEventInput } from "./event.js";
export { GENESIS_PREV_HASH, InMemoryAppendOnlyLog } from "./kernel/log.js";
export type { AppendOnlyLog, Checkpoint, SignedChain } from "./kernel/log.js";
// Entry/exit redaction (Credential Non-Leak invariant). Sibling modules — e.g. the Personal
// surface IntentGateway (slice P2R-R7-S1) — redact text through this barrel, never the internal
// ./redact.ts, so dependency-cruiser `not-to-internal` stays satisfied.
export { REDACTED, redactSecrets } from "./redact.js";
