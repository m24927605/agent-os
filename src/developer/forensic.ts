/**
 * Forensic projection + typed fold for the Developer surface (SLICE-DV3).
 *
 * This is the Developer-layer §4-② decision realized: keep `replayTimeline` (src/orchestration/replay.ts)
 * a GENERIC, AuditEvent-agnostic fold engine, and add the AuditEvent-shaped forensic semantics HERE, in
 * the consumer. Two pure, fail-closed helpers:
 *
 *   projectWormToReplayEvents(entries) -> ReplayEvent[]   (LogEntry{sequence,event} -> the replay input
 *                                                          contract: typed, sorted ascending, fail-closed)
 *   foldForensicState(events)          -> ForensicState   (a deterministic left-fold over the WORM's
 *                                                          AuditEvents into a LOCKED auditor-facing schema)
 *
 * Why a Developer-layer fold (not a change to replay.ts): `replayTimeline`'s `foldedState` is typed
 * `unknown` precisely because the engine folds arbitrary projected payloads (it must stay decoupled from
 * any one event shape). The MEANINGFUL forensic accumulation — "how many executed / denied, and the
 * last action+result per resource" — is an AuditEvent contract, so it belongs to the AuditEvent
 * consumer. replay.ts and the DV1 replay.ts tests stay UNCHANGED (low coupling, design §4).
 *
 * Hard guarantees (mirror replay.ts's honesty gate):
 *  - PURE / READ-ONLY: never mutates the input array or its elements; returns fresh objects.
 *  - DETERMINISTIC: the same events fold to a deep-equal `ForensicState`; `byResource` values are the
 *    LAST-SEEN action/result per resource in sequence order (the caller supplies events in order).
 *  - FAIL-CLOSED: a `ReplayEvent` whose `event` is NOT a well-formed `AuditEvent`, or a malformed
 *    `LogEntry`, throws a typed `ReplayError` — it NEVER silently skips/coerces (mirrors the engine's
 *    "never return a looks-complete shorter timeline" philosophy).
 *  - CREDENTIAL-BLIND: the fold carries action/resource/result strings only; it copies no arg payload,
 *    so a secret that slipped into a tool arg never reaches `ForensicState`.
 *
 * Low coupling: consumes the orchestration `ReplayEvent` type + `ReplayError`, and the audit
 * `AuditEvent`/`LogEntry` types, ONLY through their barrels (never a deep import) — dependency-cruiser
 * `not-to-internal` holds. Vendor-free.
 */
import type { AuditEvent, LogEntry } from "../audit/index.js";
import { ReplayError, type ReplayEvent } from "../orchestration/index.js";

/**
 * The LOCKED forensic foldedState schema — the Developer/auditor-facing contract that REPLACES the
 * generic engine's `unknown`. A deterministic accumulation over the WORM's `AuditEvent`s:
 *
 *  - `eventCount` — total folded events (== `steps.length` at the cut-point).
 *  - `executed`   — count where `AuditEvent.result === "success"`.
 *  - `denied`     — count where `AuditEvent.policyDecision.effect === "deny"` OR `result === "denied"`
 *                   (BOTH fields exist on `AuditEvent`; we union them so a deny recorded on EITHER the
 *                   policy effect OR the result is counted — neither under-counts the other).
 *  - `byResource` — per-resource, the LAST-SEEN action + result in sequence order (a forensic
 *                   "current state" view: what most recently happened to each resource).
 */
export interface ForensicState {
  readonly eventCount: number;
  readonly executed: number;
  readonly denied: number;
  readonly byResource: Readonly<
    Record<string, { readonly lastAction: string; readonly lastResult: string }>
  >;
}

/** Narrow an unknown payload to a well-formed `AuditEvent` for the forensic fields, or fail closed. */
function asAuditEvent(candidate: unknown, index: number): AuditEvent {
  if (candidate === null || typeof candidate !== "object") {
    throw new ReplayError(`foldForensicState: event at index ${index} is not an object`);
  }
  const e = candidate as {
    action?: unknown;
    resource?: unknown;
    result?: unknown;
    policyDecision?: unknown;
  };
  if (typeof e.action !== "string" || e.action.length === 0) {
    throw new ReplayError(
      `foldForensicState: event at index ${index} has a missing/invalid 'action'`,
    );
  }
  if (typeof e.resource !== "string" || e.resource.length === 0) {
    throw new ReplayError(
      `foldForensicState: event at index ${index} has a missing/invalid 'resource'`,
    );
  }
  if (typeof e.result !== "string") {
    throw new ReplayError(
      `foldForensicState: event at index ${index} has a missing/invalid 'result'`,
    );
  }
  if (
    e.policyDecision === null ||
    typeof e.policyDecision !== "object" ||
    typeof (e.policyDecision as { effect?: unknown }).effect !== "string"
  ) {
    throw new ReplayError(
      `foldForensicState: event at index ${index} has a missing/invalid 'policyDecision.effect'`,
    );
  }
  return candidate as AuditEvent;
}

/**
 * Read-only left-fold of an ordered `ReplayEvent[]` (each carrying an `AuditEvent`) into the locked
 * `ForensicState`. PURE: never mutates the input. FAIL-CLOSED: a non-AuditEvent payload throws.
 *
 * @param events events ALREADY ordered by `sequence` (the caller's projection contract — typically the
 *               `steps` of a `replayTimeline` cut, which the engine has validated as gap-free + ordered).
 */
export function foldForensicState(events: readonly ReplayEvent[]): ForensicState {
  let executed = 0;
  let denied = 0;
  const byResource: Record<string, { lastAction: string; lastResult: string }> = {};

  for (let i = 0; i < events.length; i++) {
    const re = events[i] as ReplayEvent;
    const event = asAuditEvent(re.event, i);
    if (event.result === "success") {
      executed += 1;
    }
    if (event.policyDecision.effect === "deny" || event.result === "denied") {
      denied += 1;
    }
    // LAST-SEEN wins (sequence order): a later event overwrites the per-resource snapshot.
    byResource[event.resource] = { lastAction: event.action, lastResult: event.result };
  }

  return { eventCount: events.length, executed, denied, byResource };
}

/**
 * Project a WORM `LogEntry[]` into the `ReplayEvent` shape `replayTimeline` consumes (`{sequence, event}`),
 * SORTED ascending by `sequence` (the engine's ordering contract). FAIL-CLOSED: a malformed entry
 * (missing/non-integer `sequence`, or missing `event`) throws — never silently dropped or coerced.
 *
 * PURE: copies into a fresh array before sorting (the caller's possibly-frozen input is never reordered
 * in place); the returned `event` is the same `AuditEvent` reference (read-only, never mutated).
 */
export function projectWormToReplayEvents(entries: readonly LogEntry[]): readonly ReplayEvent[] {
  const projected: ReplayEvent[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as unknown;
    if (entry === null || typeof entry !== "object") {
      throw new ReplayError(`projectWormToReplayEvents: entry at index ${i} is not an object`);
    }
    const seq = (entry as { sequence?: unknown }).sequence;
    if (typeof seq !== "number" || !Number.isInteger(seq)) {
      throw new ReplayError(
        `projectWormToReplayEvents: entry at index ${i} has a missing/non-integer 'sequence'`,
      );
    }
    const event = (entry as { event?: unknown }).event;
    if (event === undefined) {
      throw new ReplayError(`projectWormToReplayEvents: entry at index ${i} has a missing 'event'`);
    }
    projected.push({ sequence: seq, event });
  }
  // Sort ascending by sequence (a fresh array — never reorder the caller's input in place).
  return projected.sort((a, b) => a.sequence - b.sequence);
}
