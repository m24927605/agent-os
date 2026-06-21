/**
 * RED-first tests for SLICE-P2R-R5-S3: `runTask` — the driver that composes a multi-step Task OVER
 * P2-I's `runGovernedToolCall` (NOT a rewrite of the pipeline). Each step is sent through the INJECTED
 * P2-I pipeline, its `GovernedOutcome` is turned into a `StepRecord` appended to the `ResumeLedger`,
 * and the Task FSM is advanced — with two hard security invariants under test:
 *
 *  - APPEND-BEFORE-ADVANCE: a StepRecord must be durably appended BEFORE the cursor advances; if the
 *    append fails, the Task fails closed (no "effect happened but unrecorded" + advanced) — mirrors
 *    P2-I's commit-before-effect ordering and is the seam S4's crash-resume relies on.
 *  - FAIL-CLOSED SHORT-CIRCUIT: one denied governed step fails the whole Task and the REMAINING steps
 *    never run (their effect spy stays at zero).
 *
 * Wiring discipline (spec §5): the test injects the REAL P2-I `runGovernedToolCall` (bound to the
 * existing in-tree fakes — InMemoryCostGate, an ok appender, a counting effect) and the S2
 * `InMemoryResumeLedger`. The runner itself owns NO governance decision, NO effect, NO I/O.
 */
import { describe, expect, it } from "vitest";
import type { CommitAppender } from "../../commitgate/index.js";
import { InMemoryCostGate } from "../../cost/index.js";
import type { TaskId } from "../../iam/ids.js";
import { type GovernedCall, type GovernedToolCallDeps, runGovernedToolCall } from "../index.js";
import { InMemoryResumeLedger } from "./ledger.js";
import type { ResumeLedger } from "./ledger.js";
import { computeStepKey } from "./ledger.js";
import { type RunTaskDeps, runTask } from "./runner.js";
import type { StepRecord, Task } from "./session.js";

const taskId = "task-1" as TaskId;

/** A valid OCSF AgentContext the in-tree cost gate / pipeline accepts, carrying the step marker. */
const agentContext = (stepIndex: number) => ({
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: `req-${stepIndex}`,
  stepIndex,
});

/** A governed call the P2-I pipeline accepts (structural `GovernedCall` with a real AgentContext). */
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

/**
 * Build the INJECTED `deps.runGovernedToolCall` by binding the REAL P2-I pipeline to in-tree fakes.
 * `denyAtIndex` makes the PDP deny exactly that step (drives the short-circuit test). `effectCalls`
 * records the (taskId, stepIndex) of every effect that actually ran — the spy that proves no
 * duplicated / post-short-circuit effect.
 */
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

/** step -> toolCall: carries the deterministic identity P2-I needs (and the spy can assert on). */
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

describe("runTask — happy path (compose over P2-I)", () => {
  it("3 executed steps -> Task completed, 3 executed ledger rows, effect ran exactly once per step", async () => {
    const effectCalls: Array<{ taskId: string; stepIndex: number }> = [];
    const ledger = new InMemoryResumeLedger();
    const deps = baseDeps({
      runGovernedToolCall: makeGoverned({ effectCalls }),
      ledger,
    });

    const { task: final, records } = await runTask(deps, task());

    expect(final.status).toBe("completed");
    expect(final.cursor).toBe(3);
    expect(records).toHaveLength(3);
    expect(records.every((r) => r.outcome.status === "executed")).toBe(true);

    const rows = await ledger.list(taskId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.stepIndex)).toEqual([0, 1, 2]);

    // effect ran exactly once per step (through P2-I, never by the runner directly).
    expect(effectCalls).toHaveLength(3);
    expect(effectCalls.map((c) => c.stepIndex)).toEqual([0, 1, 2]);
  });

  it("each ledger row's stepKey is the deterministic content hash of its (taskId, stepIndex, intent)", async () => {
    const ledger = new InMemoryResumeLedger();
    const t = task();
    await runTask(baseDeps({ ledger }), t);
    const rows = await ledger.list(taskId);
    expect(rows[0]?.stepKey).toBe(computeStepKey({ taskId, stepIndex: 0, intent: t.steps[0] }));
  });
});

describe("runTask — fail-closed short-circuit (denied)", () => {
  it("step 2 denied -> Task failed, last ledger row outcome=denied, step 3 effect NEVER runs", async () => {
    const effectCalls: Array<{ taskId: string; stepIndex: number }> = [];
    const ledger = new InMemoryResumeLedger();
    const deps = baseDeps({
      runGovernedToolCall: makeGoverned({ effectCalls, denyAtIndex: 1 }),
      ledger,
    });

    const { task: final } = await runTask(deps, task());

    expect(final.status).toBe("failed");

    const rows = await ledger.list(taskId);
    // step 0 executed, step 1 denied — and NOTHING after.
    expect(rows.map((r) => r.outcome.status)).toEqual(["executed", "denied"]);

    // step 2 (index 1) never ran an effect; step 3 (index 2) never even started.
    expect(effectCalls.map((c) => c.stepIndex)).toEqual([0]);
  });

  it("denied StepRecord carries P2-I's stage + reason (timeline reconstruction)", async () => {
    const ledger = new InMemoryResumeLedger();
    const deps = baseDeps({
      runGovernedToolCall: makeGoverned({ effectCalls: [], denyAtIndex: 0 }),
      ledger,
    });
    await runTask(deps, task());
    const rows = await ledger.list(taskId);
    const denied = rows[0];
    expect(denied?.outcome.status).toBe("denied");
    if (denied?.outcome.status === "denied") {
      expect(denied.outcome.stage).toBe("policy");
      expect(denied.outcome.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("runTask — append-before-advance invariant (fail-closed)", () => {
  it("append fails on step 2 -> Task failed, cursor does NOT advance past it, step 3 never runs", async () => {
    const effectCalls: Array<{ taskId: string; stepIndex: number }> = [];
    // A ledger whose append REJECTS on the second call (simulates step-2 ledger write failure).
    let calls = 0;
    const flakyLedger: ResumeLedger = {
      append: async (id, record) => {
        calls += 1;
        if (calls === 2) {
          throw new Error("ledger append failed (simulated)");
        }
        return backing.append(id, record);
      },
      list: (id) => backing.list(id),
      has: (key) => backing.has(key),
    };
    const backing = new InMemoryResumeLedger();

    const deps = baseDeps({
      runGovernedToolCall: makeGoverned({ effectCalls }),
      ledger: flakyLedger,
    });

    const { task: final } = await runTask(deps, task());

    // fail-closed: the Task fails, it does NOT advance to completed.
    expect(final.status).toBe("failed");
    expect(final.cursor).toBe(1); // step 0 recorded+advanced; step 1 append failed => no advance.

    // step 0 ran; step 1's effect ran through P2-I (P2-I owns effect timing), but the runner did NOT
    // advance past it and did NOT start step 2 (index 2).
    expect(effectCalls.map((c) => c.stepIndex)).toEqual([0, 1]);
    expect(effectCalls.some((c) => c.stepIndex === 2)).toBe(false);
  });
});

describe("runTask — does not rewrite P2-I (composition only)", () => {
  it("invokes the injected runGovernedToolCall exactly once per executed step; runner exposes no effect", async () => {
    let governedCalls = 0;
    const inner = makeGoverned({ effectCalls: [] });
    const deps = baseDeps({
      runGovernedToolCall: (tc) => {
        governedCalls += 1;
        return inner(tc);
      },
    });
    const { task: final } = await runTask(deps, task());
    expect(final.status).toBe("completed");
    expect(governedCalls).toBe(3); // one P2-I call per step, no more
    // The runner has no `effect` on its public Deps surface — effect flows ONLY through P2-I.
    expect(Object.keys(deps)).not.toContain("effect");
  });
});
