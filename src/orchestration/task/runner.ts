/**
 * Task runner (SLICE-P2R-R5-S3 + S4 crash-resume) — the driver that runs a multi-step `Task` by
 * COMPOSING OVER P2-I's
 * `runGovernedToolCall`, NOT by rewriting the pipeline. For each step from the Task's cursor it:
 *
 *   1. builds the step's `toolCall` (injected `buildToolCall`),
 *   2. sends it through the INJECTED P2-I pipeline (`runGovernedToolCall`),
 *   3. turns the `GovernedOutcome` into a `StepRecord` and APPENDS it to the ledger,
 *   4. advances the Task FSM via S1's `transition`.
 *
 * Two security invariants, both fail-closed:
 *  - APPEND-BEFORE-ADVANCE: the StepRecord is appended (and the append confirmed) BEFORE the cursor
 *    advances. If the append throws / is not durable, the Task fails closed — it never advances on an
 *    effect whose record was lost (mirrors P2-I's commit-before-effect; the seam S4's crash-resume
 *    will fold). The append happens AFTER P2-I returns `executed`, i.e. after the audit receipt is in
 *    hand and the effect has run — so we never record an effect that did not happen.
 *  - SHORT-CIRCUIT: a denied governed step records a denied StepRecord, drives the FSM to `failed`,
 *    and STOPS — the remaining steps are never built, never governed, never run.
 *
 * Low coupling: this module owns NO governance decision, NO effect, NO I/O. `runGovernedToolCall`,
 * `ledger`, `buildToolCall`, and the clock (`now`) are all INJECTED by the composition root. It imports
 * only the SAME-MODULE P2-I `GovernedOutcome` TYPE (intra-orchestration, via `../pipeline.js` — using
 * the module's own barrel would form a barrel self-cycle since the barrel re-exports this file), the
 * same-module S1 FSM + Task/StepRecord schema, the S2 ledger port, and the deterministic
 * `computeStepKey` — no vendor, no cross-module deep import, no new third-party dependency.
 */
import type { GovernedOutcome } from "../pipeline.js";
import { transition } from "./fsm.js";
import { type ResumeLedger, computeStepKey } from "./ledger.js";
import type { StepRecord, Task } from "./session.js";

/** Everything the runner needs, INJECTED — keeps governance/effect/I/O out of this layer. */
export interface RunTaskDeps<TC, R> {
  /** P2-I's governed pipeline for a single step (injected; the runner never rewrites it). */
  readonly runGovernedToolCall: (toolCall: TC) => Promise<GovernedOutcome<R>>;
  /** Append-only resume ledger (S2). */
  readonly ledger: ResumeLedger;
  /** Maps a Task step to the concrete toolCall P2-I consumes. */
  readonly buildToolCall: (task: Task, stepIndex: number) => TC;
  /** Deterministic clock for `StepRecord.recordedAt` (injected so the layer stays pure/testable). */
  readonly now: () => string;
}

export interface RunTaskResult {
  readonly task: Task;
  readonly records: readonly StepRecord[];
}

export interface ResumeTaskResult {
  readonly task: Task;
  readonly records: readonly StepRecord[];
  /** stepKeys of steps that the ledger already recorded as `executed` and were SKIPPED (not re-run). */
  readonly skipped: readonly string[];
}

/**
 * Drive a Task to a terminal state. Returns the final Task plus the StepRecords appended THIS run.
 * Never throws on a governed denial or an FSM rejection — those fail the Task closed. A ledger append
 * that throws also fails the Task closed (append-before-advance): we stop without advancing.
 */
export async function runTask<TC, R>(
  deps: RunTaskDeps<TC, R>,
  inputTask: Task,
): Promise<RunTaskResult> {
  const task = startOrFail(inputTask);
  if (task.status === "failed") {
    return { task, records: [] };
  }
  const { task: final, records } = await driveRunningTask(deps, task);
  return { task: final, records };
}

/**
 * Crash-resume entry (SLICE-P2R-R5-S4). Before running ANY step, FOLD the Task's ledger:
 *
 *   - For each step from the cursor, recompute its deterministic `stepKey` (S2) and ask the ledger.
 *   - A step whose `stepKey` the ledger already has an `executed` record for is SKIPPED — the runner
 *     never calls `runGovernedToolCall`, the external effect never re-runs, and the FSM advances on
 *     the EXISTING record. This is the "no DUPLICATED external effect" invariant (design §2.3).
 *   - Once a step is NOT found done in the ledger, resume hands off to the SAME S3 run path for the
 *     remaining steps — identical governance, append-before-advance, and short-circuit semantics.
 *
 * FAIL-CLOSED (deny-by-default), NEVER "uncertain => re-run":
 *   - any ledger read that throws (`has`/`list`),
 *   - a ledger record whose stored `stepKey` does not match the deterministic recomputed key
 *     (corrupt/tampered record),
 *   - a step the ledger has but recorded as `denied` (a denial already failed the Task; resume does
 *     not treat it as done and does not run past it)
 *   => the Task fails closed and NO further step's effect runs.
 */
export async function resumeTask<TC, R>(
  deps: RunTaskDeps<TC, R>,
  inputTask: Task,
): Promise<ResumeTaskResult> {
  const skipped: string[] = [];

  // Authoritative fold source: the append-ordered ledger rows, indexed by stepKey. A read failure is
  // fail-closed (we cannot know what is done => we must NOT re-run).
  let rows: readonly StepRecord[];
  try {
    rows = await deps.ledger.list(inputTask.taskId);
  } catch {
    return { task: { ...inputTask, status: "failed" }, records: [], skipped };
  }
  const byKey = new Map<string, StepRecord>();
  for (const row of rows) {
    byKey.set(row.stepKey, row);
  }

  let task = startOrFail(inputTask);
  if (task.status === "failed") {
    return { task, records: [], skipped };
  }

  // Fold-before-run: advance the cursor over already-`executed` steps WITHOUT touching P2-I.
  while (task.status === "running" && task.cursor < task.steps.length) {
    const stepIndex = task.cursor;
    const stepKey = computeStepKey({
      taskId: task.taskId,
      stepIndex,
      intent: task.steps[stepIndex],
    });

    let present: boolean;
    try {
      present = await deps.ledger.has(stepKey);
    } catch {
      // Ledger membership query failed => fail closed; do NOT re-run.
      return { task: { ...task, status: "failed" }, records: [], skipped };
    }
    if (!present) {
      break; // first not-yet-done step — hand off to the live run path below.
    }

    const recorded = byKey.get(stepKey);
    // Corrupt/tampered: `has` says present but no matching row, or the row's key drifted. Fail closed.
    if (recorded === undefined || recorded.stepKey !== stepKey) {
      return { task: { ...task, status: "failed" }, records: [], skipped };
    }
    // A denied step is NOT done: it already failed the Task. Resume must not skip past it / re-run.
    if (recorded.outcome.status !== "executed") {
      return { task: { ...task, status: "failed" }, records: [], skipped };
    }

    // Skip: advance the FSM on the EXISTING record — no governance, no effect, no new append.
    const advanced = transition(task, { kind: "step-executed", record: recorded });
    if (!advanced.ok) {
      return { task: { ...task, status: "failed" }, records: [], skipped };
    }
    task = advanced.task;
    skipped.push(stepKey);
  }

  // Remaining steps (if any) run through the identical S3 path. completed/failed already terminal.
  const { task: final, records } = await driveRunningTask(deps, task);
  return { task: final, records, skipped };
}

/** Move a `pending` Task to `running`; deny-by-default => any non-start failure yields `failed`. */
function startOrFail(inputTask: Task): Task {
  if (inputTask.status !== "pending") {
    return inputTask;
  }
  const started = transition(inputTask, { kind: "start" });
  return started.ok ? started.task : { ...inputTask, status: "failed" };
}

/**
 * The S3 per-step run loop, shared by `runTask` and `resumeTask`. Drives a `running` Task from its
 * cursor through P2-I (governance -> ledger append-before-advance -> FSM), failing closed on a denial,
 * a lost append, or an FSM rejection. A non-`running` Task is returned untouched.
 */
async function driveRunningTask<TC, R>(
  deps: RunTaskDeps<TC, R>,
  inputTask: Task,
): Promise<RunTaskResult> {
  const records: StepRecord[] = [];
  let task = inputTask;

  while (task.status === "running" && task.cursor < task.steps.length) {
    const stepIndex = task.cursor;
    const intent = task.steps[stepIndex];
    const stepKey = computeStepKey({ taskId: task.taskId, stepIndex, intent });

    const outcome = await deps.runGovernedToolCall(deps.buildToolCall(task, stepIndex));

    if (outcome.status === "denied") {
      // Short-circuit: record the denial, drive the FSM to failed, and STOP (no remaining steps run).
      const record: StepRecord = {
        stepKey,
        stepIndex,
        outcome: { status: "denied", stage: outcome.stage, reason: outcome.reason },
        recordedAt: deps.now(),
      };
      // Append the denial record (best-effort, append-only); the FSM denial is the authoritative stop.
      await appendFailClosed(deps.ledger, task.taskId, record, records);
      const denied = transition(task, { kind: "step-denied", record, reason: outcome.reason });
      task = denied.ok ? denied.task : { ...task, status: "failed" };
      break;
    }

    // executed: APPEND-BEFORE-ADVANCE. Append must succeed before we advance the cursor.
    const record: StepRecord = {
      stepKey,
      stepIndex,
      outcome: { status: "executed" },
      recordedAt: deps.now(),
    };
    const appended = await tryAppend(deps.ledger, task.taskId, record);
    if (!appended) {
      // The effect already ran (P2-I), but its record is not durable — fail closed, do NOT advance.
      task = { ...task, status: "failed" };
      break;
    }
    records.push(record);

    const advanced = transition(task, { kind: "step-executed", record });
    if (!advanced.ok) {
      // The FSM refused the advance (e.g. index mismatch) — fail closed rather than loop or skip.
      task = { ...task, status: "failed" };
      break;
    }
    task = advanced.task;
  }

  return { task, records };
}

/** Append; return false (never throw) if the ledger write fails — the caller fails closed. */
async function tryAppend(
  ledger: ResumeLedger,
  taskId: Task["taskId"],
  record: StepRecord,
): Promise<boolean> {
  try {
    const { appended } = await ledger.append(taskId, record);
    return appended;
  } catch {
    return false;
  }
}

/** Append a denial record without throwing; push to `records` only if it was durably written. */
async function appendFailClosed(
  ledger: ResumeLedger,
  taskId: Task["taskId"],
  record: StepRecord,
  records: StepRecord[],
): Promise<void> {
  if (await tryAppend(ledger, taskId, record)) {
    records.push(record);
  }
}
