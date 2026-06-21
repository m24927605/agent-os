/**
 * Task FSM — pure-function state transitions with explicit, deny-by-default guards.
 *
 * No I/O, no clock, no randomness: a `transition` takes the current `Task` + a `TaskEvent` and returns
 * EITHER a new `Task` (legal move) OR `{ ok: false, reason }` (illegal/unknown move). It NEVER throws
 * and NEVER silently advances — an unrecognized event, a wrong-state event, or a cursor/index mismatch
 * all fail closed. This is the security invariant of the slice: "one governed step denied => the whole
 * Task fails" (no silent skip), mirroring P2-I's fail-closed pipeline.
 *
 * The caller supplies time (StepRecord.recordedAt is built upstream), keeping this layer deterministic
 * and trivially testable.
 */
import type { StepRecord, Task } from "./session.js";

export type TaskEvent =
  | { kind: "start" }
  | { kind: "step-executed"; record: StepRecord }
  | { kind: "step-denied"; record: StepRecord; reason: string }
  | { kind: "abort"; reason: string };

export type TransitionResult = { ok: true; task: Task } | { ok: false; reason: string };

function deny(reason: string): TransitionResult {
  return { ok: false, reason };
}

/**
 * Apply one event to a Task. Deny-by-default: any guard that is not explicitly satisfied returns
 * `{ ok: false }`. Returns a fresh Task object on success (no in-place mutation).
 */
export function transition(task: Task, event: TaskEvent): TransitionResult {
  switch (event.kind) {
    case "start": {
      if (task.status !== "pending") {
        return deny(`cannot start a task in status "${task.status}" (only "pending" may start)`);
      }
      return { ok: true, task: { ...task, status: "running" } };
    }

    case "step-executed": {
      if (task.status !== "running") {
        return deny(`cannot record an executed step on a task in status "${task.status}"`);
      }
      if (task.cursor < 0 || task.cursor >= task.steps.length) {
        return deny(`cursor ${task.cursor} is out of bounds for ${task.steps.length} step(s)`);
      }
      if (event.record.stepIndex !== task.cursor) {
        return deny(
          `step record index ${event.record.stepIndex} does not match cursor ${task.cursor}`,
        );
      }
      const nextCursor = task.cursor + 1;
      const status = nextCursor >= task.steps.length ? "completed" : "running";
      return { ok: true, task: { ...task, cursor: nextCursor, status } };
    }

    case "step-denied": {
      if (task.status !== "running") {
        return deny(`cannot record a denied step on a task in status "${task.status}"`);
      }
      // Deny-by-default: a single governed denial fails the whole Task — never silently skipped.
      return { ok: true, task: { ...task, status: "failed" } };
    }

    case "abort": {
      if (task.status !== "pending" && task.status !== "running") {
        return deny(`cannot abort a task in terminal status "${task.status}"`);
      }
      return { ok: true, task: { ...task, status: "aborted" } };
    }

    default: {
      // Unknown event kind => deny-by-default (fail closed, do not throw).
      const unknownKind = (event as { kind?: unknown }).kind;
      return deny(`unknown task event kind: ${String(unknownKind)}`);
    }
  }
}
