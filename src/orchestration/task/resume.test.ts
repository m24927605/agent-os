/**
 * RED-first tests for SLICE-P2R-R5-S4: `resumeTask` — crash-resume IDEMPOTENCY over the S3 runner.
 *
 * The security-invariant core of R5: after a crash, a fresh runner re-pointed at the SAME ledger must
 * fold that ledger and SKIP every step that already has an `executed` record — never re-calling
 * `runGovernedToolCall`, never re-running the external effect. The proof is an EFFECT-COUNT SPY: the
 * number of effect invocations must NOT increase for already-done steps (no DUPLICATED external effect).
 *
 * Adversarial intent (spec §6 mutations these tests MUST catch):
 *  - if `skip` is mutated to still call `runGovernedToolCall` -> effect spy increases -> RED.
 *  - if `stepKey` is mutated to include a timestamp/nonce -> resume mis-IDs a done step as new -> RED.
 *  - if a ledger error is handled fail-OPEN (re-run) -> effect spy increases / Task not failed -> RED.
 *
 * Wiring discipline (spec §5): the test injects the REAL P2-I `runGovernedToolCall` (bound to the
 * in-tree fakes) and the S2 `InMemoryResumeLedger`. A "crash" is simulated at a process boundary by
 * discarding the runner state and constructing a FRESH `resumeTask` call over the same ledger.
 */
import { describe, expect, it } from "vitest";
import type { CommitAppender } from "../../commitgate/index.js";
import { InMemoryCostGate } from "../../cost/index.js";
import type { TaskId } from "../../iam/ids.js";
import { type GovernedCall, type GovernedToolCallDeps, runGovernedToolCall } from "../index.js";
import { InMemoryResumeLedger, computeStepKey } from "./ledger.js";
import type { ResumeLedger } from "./ledger.js";
import { type RunTaskDeps, resumeTask, runTask } from "./runner.js";
import type { StepRecord, Task } from "./session.js";

const taskId = "task-1" as TaskId;

const agentContext = (stepIndex: number) => ({
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: `req-${stepIndex}`,
  stepIndex,
});

interface StepCall extends GovernedCall {
  readonly tool: string;
  readonly context: ReturnType<typeof agentContext>;
}

function task(over: Partial<Task> = {}): Task {
  return {
    taskId,
    status: "pending",
    steps: [
      { tool: "step-a", context: {} },
      { tool: "step-b", context: {} },
      { tool: "step-c", context: {} },
    ],
    cursor: 0,
    ...over,
  } as Task;
}

function okAppender(): CommitAppender<unknown, { sequence: number }> {
  let seq = 0;
  return { append: async () => ({ sequence: ++seq }) };
}

/** Build the injected P2-I pipeline bound to in-tree fakes; `effectCalls` is the no-duplicate spy. */
function makeGoverned(opts: {
  effectCalls: Array<{ taskId: string; stepIndex: number }>;
  denyAtIndex?: number;
}): (
  tc: StepCall,
) => Promise<Awaited<ReturnType<typeof runGovernedToolCall<StepCall, { sequence: number }>>>> {
  const cost = new InMemoryCostGate(1_000_000);
  const appender = okAppender();
  const deps: GovernedToolCallDeps<StepCall, { sequence: number }> = {
    screen: () => ({ ok: true }),
    authorize: (tc) =>
      tc.context.stepIndex === opts.denyAtIndex
        ? { effect: "deny", reason: `policy denied step ${tc.context.stepIndex}` }
        : { effect: "allow", reason: "allow" },
    cost,
    estimateTokens: () => 1,
    appender,
    effect: async (tc) => {
      opts.effectCalls.push({ taskId: tc.context.taskId, stepIndex: tc.context.stepIndex });
      return { ok: true };
    },
  };
  return (tc) => runGovernedToolCall(deps, tc);
}

function buildToolCall(t: Task, stepIndex: number): StepCall {
  const step = t.steps[stepIndex];
  if (step === undefined) {
    throw new Error(`no step at index ${stepIndex}`);
  }
  return { tool: step.tool, context: agentContext(stepIndex) };
}

function baseDeps(
  over: Partial<RunTaskDeps<StepCall, { sequence: number }>> = {},
): RunTaskDeps<StepCall, { sequence: number }> {
  return {
    runGovernedToolCall: makeGoverned({ effectCalls: [] }),
    ledger: new InMemoryResumeLedger(),
    buildToolCall,
    now: () => "2026-06-21T00:00:00.000Z",
    ...over,
  };
}

/** Append a pre-existing `executed` ledger row for step `i` (simulates work done before the crash). */
async function seedExecuted(ledger: ResumeLedger, t: Task, i: number): Promise<StepRecord> {
  const record: StepRecord = {
    stepKey: computeStepKey({ taskId, stepIndex: i, intent: t.steps[i] }),
    stepIndex: i,
    outcome: { status: "executed" },
    recordedAt: "2026-06-21T00:00:00.000Z",
  };
  await ledger.append(taskId, record);
  return record;
}

describe("resumeTask — crash-resume idempotency (no duplicated external effect)", () => {
  it("step 1 done pre-crash -> fresh runner resumes steps 2,3; step-1 effect stays 1, total effect = 3", async () => {
    const ledger = new InMemoryResumeLedger();
    const t = task();

    // Pre-crash: step 0 runs for real (effect spy = 1, one ledger row).
    const preCalls: Array<{ taskId: string; stepIndex: number }> = [];
    const preGoverned = makeGoverned({ effectCalls: preCalls });
    // Run only the first step by limiting the task to one step's worth of work via a 1-step view.
    const oneStep = task({ steps: [t.steps[0]] as Task["steps"] });
    await runTask(baseDeps({ runGovernedToolCall: preGoverned, ledger }), oneStep);
    expect(preCalls.map((c) => c.stepIndex)).toEqual([0]);
    expect(await ledger.list(taskId)).toHaveLength(1);

    // CRASH: discard the pre-crash runner. Fresh runner + SAME ledger, full 3-step task, fresh spy.
    const postCalls: Array<{ taskId: string; stepIndex: number }> = [];
    const {
      task: final,
      records,
      skipped,
    } = await resumeTask(
      baseDeps({ runGovernedToolCall: makeGoverned({ effectCalls: postCalls }), ledger }),
      t,
    );

    expect(final.status).toBe("completed");
    // step 0 is skipped (already executed); only steps 1,2 run this time.
    expect(skipped).toEqual([computeStepKey({ taskId, stepIndex: 0, intent: t.steps[0] })]);
    expect(postCalls.map((c) => c.stepIndex)).toEqual([1, 2]); // step 0's effect did NOT re-run
    expect(records.map((r) => r.stepIndex)).toEqual([1, 2]);

    // Total effect across the whole lifecycle = 3 (NOT 4): the dual of P2-I's no-unrecorded-effect.
    expect(preCalls.length + postCalls.length).toBe(3);
    const rows = await ledger.list(taskId);
    expect(rows.map((r) => r.stepIndex)).toEqual([0, 1, 2]);
  });

  it("fully-completed ledger -> resume is a no-op: 0 new effects, Task completed, all 3 skipped", async () => {
    const ledger = new InMemoryResumeLedger();
    const t = task();
    await seedExecuted(ledger, t, 0);
    await seedExecuted(ledger, t, 1);
    await seedExecuted(ledger, t, 2);

    const calls: Array<{ taskId: string; stepIndex: number }> = [];
    const {
      task: final,
      records,
      skipped,
    } = await resumeTask(
      baseDeps({ runGovernedToolCall: makeGoverned({ effectCalls: calls }), ledger }),
      t,
    );

    expect(final.status).toBe("completed");
    expect(calls).toHaveLength(0); // ZERO new external effect
    expect(records).toHaveLength(0); // nothing newly appended
    expect(skipped).toHaveLength(3);
  });

  it("deterministic stepKey: resume recomputes the SAME key for the same intent and skips on it", async () => {
    const ledger = new InMemoryResumeLedger();
    const t = task();
    await seedExecuted(ledger, t, 0);

    const { skipped } = await resumeTask(baseDeps({ ledger }), t);
    // If stepKey were non-deterministic (timestamp/nonce), resume would mis-ID step 0 as new.
    expect(skipped).toContain(computeStepKey({ taskId, stepIndex: 0, intent: t.steps[0] }));
  });

  it("fail-closed: ledger.has REJECTS -> Task failed, NO step re-runs (effect spy stays 0)", async () => {
    const t = task();
    const calls: Array<{ taskId: string; stepIndex: number }> = [];
    const exploding: ResumeLedger = {
      append: async () => ({ appended: true }),
      list: async () => [],
      has: async () => {
        throw new Error("ledger.has failed (simulated)");
      },
    };

    const { task: final } = await resumeTask(
      baseDeps({ runGovernedToolCall: makeGoverned({ effectCalls: calls }), ledger: exploding }),
      t,
    );

    expect(final.status).toBe("failed"); // fail-closed, NOT "uncertain => re-run"
    expect(calls).toHaveLength(0); // no effect re-run on a ledger error
  });

  it("fail-closed: corrupt ledger record (stepKey mismatches recomputed key) -> Task failed, no re-run", async () => {
    const t = task();
    const calls: Array<{ taskId: string; stepIndex: number }> = [];
    // A ledger that CLAIMS step 0 is present (has=true) but whose stored record key does not match the
    // deterministic recomputed key — a corrupt/tampered record. Resume must fail closed, not re-run.
    const corrupt: ResumeLedger = {
      append: async () => ({ appended: true }),
      list: async () => [
        {
          stepKey: "sha256:tampered",
          stepIndex: 0,
          outcome: { status: "executed" },
          recordedAt: "2026-06-21T00:00:00.000Z",
        },
      ],
      has: async (key) => key === computeStepKey({ taskId, stepIndex: 0, intent: t.steps[0] }),
    };

    const { task: final } = await resumeTask(
      baseDeps({ runGovernedToolCall: makeGoverned({ effectCalls: calls }), ledger: corrupt }),
      t,
    );

    expect(final.status).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("denied step is NOT treated as done: resume of a Task with a denied record fails closed, no re-run", async () => {
    const ledger = new InMemoryResumeLedger();
    const t = task();
    // Pre-crash: step 0 executed, step 1 DENIED (the Task had already failed).
    await seedExecuted(ledger, t, 0);
    await ledger.append(taskId, {
      stepKey: computeStepKey({ taskId, stepIndex: 1, intent: t.steps[1] }),
      stepIndex: 1,
      outcome: { status: "denied", stage: "policy", reason: "denied step 1" },
      recordedAt: "2026-06-21T00:00:00.000Z",
    });

    const calls: Array<{ taskId: string; stepIndex: number }> = [];
    const { task: final, skipped } = await resumeTask(
      baseDeps({ runGovernedToolCall: makeGoverned({ effectCalls: calls }), ledger }),
      t,
    );

    // A denied step does NOT make the Task resumable; resume does not re-run step 2 after a denial.
    expect(final.status).toBe("failed");
    expect(calls).toHaveLength(0);
    // The denied step's key is never reported as a skipped (= done-executed) step.
    expect(skipped).not.toContain(computeStepKey({ taskId, stepIndex: 1, intent: t.steps[1] }));
  });

  it("double-resume is safe: resuming a completed ledger twice never adds an effect (re-entrant)", async () => {
    const ledger = new InMemoryResumeLedger();
    const t = task();
    await seedExecuted(ledger, t, 0);
    await seedExecuted(ledger, t, 1);
    await seedExecuted(ledger, t, 2);

    const calls: Array<{ taskId: string; stepIndex: number }> = [];
    const deps = baseDeps({ runGovernedToolCall: makeGoverned({ effectCalls: calls }), ledger });

    const first = await resumeTask(deps, t);
    const second = await resumeTask(deps, t);

    expect(first.task.status).toBe("completed");
    expect(second.task.status).toBe("completed");
    expect(calls).toHaveLength(0); // re-entrant idempotency: still ZERO new effect
  });
});
