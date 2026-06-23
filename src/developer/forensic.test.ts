/**
 * Forensic fold + WORM->ReplayEvent projection unit suite (SLICE-DV3).
 *
 * These are PURE-function proofs (no kit, no WORM construction) over hand-built `AuditEvent` /
 * `LogEntry` fixtures. They lock the three DV3 contracts that turn DV1's thin `replayFold` into a
 * MEANINGFUL forensic endpoint:
 *
 *   (A) `foldForensicState(events)`  — a deterministic, fail-closed left-fold of WORM-derived
 *       `ReplayEvent`s (each carrying an `AuditEvent`) into the LOCKED `ForensicState` schema
 *       `{ eventCount, executed, denied, byResource }`. NON-VACUITY: a fold that mis-counts `denied`
 *       or drops a `byResource` update flips the schema assertions RED.
 *   (B) `foldForensicState` is DETERMINISTIC — same events twice => deep-equal state.
 *   (C) `projectWormToReplayEvents(entries)` — typed, fail-closed (`malformed LogEntry` => throw),
 *       and sorts ascending by `sequence` (the `replayTimeline` input contract). NON-VACUITY: an
 *       unsorted / silently-skipping projection flips RED.
 *
 * RED-first: `./forensic.js` does not export `ForensicState` / `foldForensicState` /
 * `projectWormToReplayEvents` yet, so this suite fails to import/typecheck before implementation.
 *
 * Low coupling: consumes the orchestration `ReplayEvent` type + the audit `AuditEvent`/`LogEntry`
 * types ONLY through their barrels (test files are dep-cruiser-excluded, but we still go barrel-only).
 */
import { describe, expect, it } from "vitest";
import type { AuditEvent, LogEntry } from "../audit/index.js";
import type { ReplayEvent } from "../orchestration/index.js";
import { type ForensicState, foldForensicState, projectWormToReplayEvents } from "./forensic.js";

/** A minimal well-formed AuditEvent fixture (only the fields the fold + alignment inspect matter). */
function auditEvent(partial: {
  action: string;
  resource: string;
  result?: AuditEvent["result"];
  effect?: AuditEvent["policyDecision"]["effect"];
  reason?: string;
}): AuditEvent {
  return {
    eventId: `evt-${partial.action}-${partial.resource}`,
    requestId: "req-1",
    timestamp: "2026-06-19T00:00:00.000Z",
    tenantId: "tenant-1",
    projectId: "proj-1",
    taskId: "task-1",
    actorId: "agent:dev",
    action: partial.action,
    resource: partial.resource,
    policyDecision: { effect: partial.effect ?? "allow", reason: partial.reason ?? "ok" },
    result: partial.result ?? "success",
  } as AuditEvent;
}

/** Wrap AuditEvents into ReplayEvents with sequential, contiguous sequences (the replay contract). */
function asReplayEvents(events: readonly AuditEvent[], startSeq = 0): ReplayEvent[] {
  return events.map((event, i) => ({ sequence: startSeq + i, event }));
}

/** A well-formed LogEntry fixture (forensic projection only reads `.sequence` + `.event`). */
function logEntry(sequence: number, event: AuditEvent): LogEntry {
  return {
    sequence,
    event,
    prevHash: `sha256:${"0".repeat(64)}`,
    entryHash: `sha256:${"1".repeat(64)}`,
  } as LogEntry;
}

describe("foldForensicState — typed forensic foldedState schema (deterministic, fail-closed)", () => {
  it("(A) folds a known AuditEvent sequence into the EXACT {eventCount, executed, denied, byResource}", () => {
    // Five events (executed = result"success"; denied = effect"deny" OR result"denied" — the two
    // predicates are kept MUTUALLY EXCLUSIVE here, mirroring the system: a denied event records
    // result"denied", an allowed effect records result"success"):
    //   0: deploy dev:a   result"success" effect"allow"  -> executed
    //   1: read   dev:b   result"success" effect"allow"  -> executed
    //   2: rm     dev:a   result"denied"  effect"allow"  -> denied (counted via result"denied")
    //   3: scale  dev:b   result"denied"  effect"deny"   -> denied (counted via effect"deny")
    //   4: status dev:a   result"success" effect"allow"  -> executed (LAST write to dev:a)
    const events = asReplayEvents([
      auditEvent({ action: "deploy", resource: "dev:a", result: "success", effect: "allow" }),
      auditEvent({ action: "read", resource: "dev:b", result: "success", effect: "allow" }),
      auditEvent({ action: "rm", resource: "dev:a", result: "denied", effect: "allow" }),
      auditEvent({ action: "scale", resource: "dev:b", result: "denied", effect: "deny" }),
      auditEvent({ action: "status", resource: "dev:a", result: "success", effect: "allow" }),
    ]);

    const state: ForensicState = foldForensicState(events);

    // Each field asserted independently (a mis-count flips exactly one assertion).
    expect(state.eventCount).toBe(5);
    expect(state.executed).toBe(3); // seq 0,1,4 (result"success")
    expect(state.denied).toBe(2); // seq 2 (result"denied") + seq 3 (effect"deny")

    // byResource carries the LAST-SEEN action/result per resource in sequence order.
    expect(state.byResource["dev:a"]).toEqual({ lastAction: "status", lastResult: "success" });
    expect(state.byResource["dev:b"]).toEqual({ lastAction: "scale", lastResult: "denied" });
    // exactly two resources accumulated.
    expect(Object.keys(state.byResource).sort()).toEqual(["dev:a", "dev:b"]);
  });

  it("(A.non-vacuity) a deny-only fixture pins `denied` (a fold that mis-counts denied -> RED here)", () => {
    const events = asReplayEvents([
      auditEvent({ action: "rm", resource: "dev:a", result: "denied", effect: "allow" }),
      auditEvent({ action: "scale", resource: "dev:b", result: "denied", effect: "deny" }),
    ]);
    const state = foldForensicState(events);
    expect(state.eventCount).toBe(2);
    expect(state.executed).toBe(0);
    expect(state.denied).toBe(2);
  });

  it('(A.union) effect"deny" alone counts as denied even when result is not "denied"', () => {
    // Locks the spec's OR: `denied` counts effect"deny" OR result"denied". Here a single event has
    // effect"deny" but result"error" (NOT "denied") — it must STILL be counted as denied (and NOT
    // executed). A fold that only inspected `result` would mis-count this RED.
    const events = asReplayEvents([
      auditEvent({ action: "scale", resource: "dev:x", result: "error", effect: "deny" }),
    ]);
    const state = foldForensicState(events);
    expect(state.executed).toBe(0);
    expect(state.denied).toBe(1);
  });

  it("(A.non-vacuity) a later event OVERWRITES byResource (a fold that drops the update -> RED here)", () => {
    const events = asReplayEvents([
      auditEvent({ action: "deploy", resource: "dev:a", result: "success" }),
      auditEvent({ action: "rm", resource: "dev:a", result: "denied" }),
    ]);
    const state = foldForensicState(events);
    // The LAST write to dev:a wins: action "rm", result "denied".
    expect(state.byResource["dev:a"]).toEqual({ lastAction: "rm", lastResult: "denied" });
  });

  it("(B) DETERMINISTIC: folding the same events twice yields deep-equal ForensicState", () => {
    const events = asReplayEvents([
      auditEvent({ action: "deploy", resource: "dev:a", result: "success" }),
      auditEvent({ action: "scale", resource: "dev:b", result: "success", effect: "deny" }),
    ]);
    const first = foldForensicState(events);
    const second = foldForensicState(events);
    expect(second).toEqual(first);
  });

  it("an empty sequence folds to the zero state", () => {
    const state = foldForensicState([]);
    expect(state).toEqual({ eventCount: 0, executed: 0, denied: 0, byResource: {} });
  });

  it("FAIL-CLOSED: an event that is NOT a well-formed AuditEvent throws (never silently skipped)", () => {
    // Missing `policyDecision` / `action` / `resource` — the fold MUST reject, not coerce/skip.
    const malformed: ReplayEvent[] = [{ sequence: 0, event: { action: "deploy" } }];
    expect(() => foldForensicState(malformed)).toThrow();

    const notAnObject: ReplayEvent[] = [{ sequence: 0, event: 42 }];
    expect(() => foldForensicState(notAnObject)).toThrow();

    const nullEvent: ReplayEvent[] = [{ sequence: 0, event: null }];
    expect(() => foldForensicState(nullEvent)).toThrow();
  });
});

describe("projectWormToReplayEvents — typed, fail-closed, sorted WORM projection", () => {
  it("maps each LogEntry -> {sequence, event} and sorts ascending by sequence", () => {
    // Supply OUT-OF-ORDER entries: the projection must return them sorted ascending.
    const a = auditEvent({ action: "deploy", resource: "dev:a", result: "success" });
    const b = auditEvent({ action: "read", resource: "dev:b", result: "success" });
    const c = auditEvent({ action: "scale", resource: "dev:c", result: "success" });
    const projected = projectWormToReplayEvents([logEntry(2, c), logEntry(0, a), logEntry(1, b)]);

    expect(projected.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(projected[0]?.event).toBe(a);
    expect(projected[1]?.event).toBe(b);
    expect(projected[2]?.event).toBe(c);
  });

  it("FAIL-CLOSED: a malformed LogEntry (missing/non-integer sequence or missing event) throws", () => {
    const ev = auditEvent({ action: "deploy", resource: "dev:a", result: "success" });

    // Non-integer sequence.
    expect(() =>
      projectWormToReplayEvents([{ sequence: 1.5, event: ev } as unknown as LogEntry]),
    ).toThrow();
    // Missing sequence.
    expect(() => projectWormToReplayEvents([{ event: ev } as unknown as LogEntry])).toThrow();
    // Missing event.
    expect(() => projectWormToReplayEvents([{ sequence: 0 } as unknown as LogEntry])).toThrow();
    // Entry not an object.
    expect(() => projectWormToReplayEvents([42 as unknown as LogEntry])).toThrow();
  });

  it("the projection feeds replayTimeline's contract (contiguous sorted sequences fold cleanly)", () => {
    // A purely structural sanity check: the projected, sorted output is contiguous-from-0 here, so it
    // matches the sequence-gap-free input contract `foldForensicState`/`replayTimeline` rely on.
    const a = auditEvent({ action: "deploy", resource: "dev:a", result: "success" });
    const b = auditEvent({ action: "read", resource: "dev:b", result: "success" });
    const projected = projectWormToReplayEvents([logEntry(0, a), logEntry(1, b)]);
    const folded = foldForensicState(projected);
    expect(folded.eventCount).toBe(2);
    expect(folded.executed).toBe(2);
  });
});
