/**
 * Forensic Replay fold engine — read-only truth reconstruction, ZERO kernel change
 * (SLICE-P2R-R10-S1; design docs/design/time-travel-snapshot-replay.md §10, §56 Build-list #1).
 *
 * `state(T) = fold(events[0..N])`. Given a sequence of WORM-derived event projections (a caller
 * supplies `{ sequence, event }` projected off the kernel's `LogRecord` — a STRUCTURAL contract,
 * never an import of the kernel), this rebuilds a deterministic `TaskTimeline`: the folded state at
 * any sequence cut-point, plus a content-addressed `timelineHash` so an independent verifier can
 * recompute the same address from the same log.
 *
 * Hard guarantees (design §10 honesty gate):
 *  - PURE / READ-ONLY: never re-runs a tool, never touches the network, never reads a credential;
 *    the input array and its elements are not mutated (folding clones into a fresh state object).
 *  - DETERMINISTIC: same events -> identical `timelineHash` (canonical key-ordered serialization,
 *    redaction-blind, then sha256).
 *  - FAIL-CLOSED: a sequence gap, a non-monotonic / duplicate sequence, a missing/`NaN` `sequence`
 *    field, or an out-of-range `uptoSequence` throws a typed `ReplayError` — it NEVER returns a
 *    "looks complete" shorter timeline (mirrors store.go torn-tail fail-closed philosophy).
 *
 * Low coupling / high cohesion: this module only folds + hashes + validates. It does NO IO and NO
 * restore (mutating forward-append RestoreEvent is SLICE-P2R-R10-S3). The only cross-module surface
 * it consumes is the audit barrel's `redactSecrets` (Credential Non-Leak invariant, design §52) —
 * via `../audit/index.js`, never a deep import. Canonical serialization is kept local (the audit
 * canonicalizer is `AuditEvent`-typed; this engine folds arbitrary projected payloads).
 */
import { createHash } from "node:crypto";
import { redactSecrets } from "../audit/index.js";

/** A WORM-derived event projection: ordering is decided by `sequence`. Structural, not a kernel import. */
export type ReplayEvent = { readonly sequence: number; readonly event: unknown };

/** The read-only reconstruction of a task's history up to a sequence cut-point. */
export type TaskTimeline = {
  readonly steps: readonly ReplayEvent[];
  readonly foldedState: unknown;
  readonly headSequence: number;
  readonly timelineHash: string;
};

/** Typed, fail-closed error for malformed / non-replayable event sequences. */
export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

/** Deterministic JSON: keys sorted recursively; non-finite / unserializable values fail-closed. */
function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ReplayError("replayTimeline: non-finite number is not serializable");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    throw new ReplayError("replayTimeline: bigint is not serializable");
  }
  if (Array.isArray(value)) {
    // JSON array semantics: undefined / function / symbol elements serialize as `null` (never invoked).
    const items = value.map((item) =>
      item === undefined || typeof item === "function" || typeof item === "symbol"
        ? "null"
        : canonicalJson(item),
    );
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      // Absent property — deterministic, matches JSON object semantics: `undefined`, functions and
      // symbols are dropped (a forensic fold structurally serializes; it NEVER invokes a callable).
      if (child === undefined || typeof child === "function" || typeof child === "symbol") {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${canonicalJson(child)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new ReplayError(`replayTimeline: unserializable value of type ${typeof value}`);
}

/** Validate one element is a structurally well-formed `ReplayEvent` (fail-closed on any deviation). */
function assertWellFormed(candidate: ReplayEvent, index: number): void {
  if (candidate === null || typeof candidate !== "object") {
    throw new ReplayError(`replayTimeline: event at index ${index} is not an object`);
  }
  const seq = (candidate as { sequence?: unknown }).sequence;
  if (typeof seq !== "number" || !Number.isInteger(seq)) {
    throw new ReplayError(
      `replayTimeline: event at index ${index} has a missing / non-integer 'sequence'`,
    );
  }
}

/**
 * Read-only left-fold of an ordered event projection into a deterministic `TaskTimeline`.
 *
 * @param events  events ALREADY sorted ascending by `sequence` (caller's projection contract).
 * @param uptoSequence  optional inclusive cut-point for point-in-time reconstruction; MUST match an
 *                      event's `sequence` when the timeline is non-empty, else `ReplayError`.
 */
export function replayTimeline(
  events: readonly ReplayEvent[],
  uptoSequence?: number,
): TaskTimeline {
  // 1) Structural + monotonic validation pass (fail-closed: gap / dup / out-of-order / malformed).
  let prev: number | undefined;
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as ReplayEvent;
    assertWellFormed(e, i);
    if (prev !== undefined) {
      if (e.sequence <= prev) {
        throw new ReplayError(
          `replayTimeline: non-monotonic sequence ${e.sequence} after ${prev} at index ${i}`,
        );
      }
      if (e.sequence !== prev + 1) {
        throw new ReplayError(
          `replayTimeline: sequence gap — expected ${prev + 1}, saw ${e.sequence} at index ${i}`,
        );
      }
    }
    prev = e.sequence;
  }

  // 2) Resolve the cut-point. Default = head (last) sequence; 0 for an empty timeline.
  const headOfAll = events.length === 0 ? 0 : (events[events.length - 1] as ReplayEvent).sequence;
  let cut = uptoSequence ?? headOfAll;
  if (uptoSequence !== undefined) {
    if (!Number.isInteger(uptoSequence)) {
      throw new ReplayError("replayTimeline: uptoSequence must be an integer");
    }
    if (events.length === 0) {
      // No events to fold; only uptoSequence === 0 (the empty head) is in range.
      if (uptoSequence !== 0) {
        throw new ReplayError("replayTimeline: uptoSequence out of range for an empty timeline");
      }
      cut = 0;
    } else {
      const firstSeq = (events[0] as ReplayEvent).sequence;
      if (uptoSequence < firstSeq || uptoSequence > headOfAll) {
        throw new ReplayError(
          `replayTimeline: uptoSequence ${uptoSequence} out of range [${firstSeq}, ${headOfAll}]`,
        );
      }
    }
  }

  // 3) Read-only left-fold up to the cut into a FRESH state object (never mutate the input).
  const steps: ReplayEvent[] = [];
  const foldedState: { events: unknown[] } = { events: [] };
  for (const e of events) {
    if (e.sequence > cut) {
      break;
    }
    steps.push({ sequence: e.sequence, event: e.event });
    foldedState.events.push(e.event);
  }

  const headSequence = steps.length === 0 ? 0 : (steps[steps.length - 1] as ReplayEvent).sequence;

  // 4) Deterministic content address over the redaction-blind, canonical folded projection.
  const canonical = canonicalJson(redactSecrets({ headSequence, foldedState }));
  const hex = createHash("sha256").update(new TextEncoder().encode(canonical)).digest("hex");

  return {
    steps,
    foldedState,
    headSequence,
    timelineHash: `sha256:${hex}`,
  };
}
