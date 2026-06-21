/**
 * RED-first tests for the Task FSM: pure-function transitions with explicit, deny-by-default guards.
 * Security invariant under test: an illegal/unknown transition is DENIED (`{ ok: false, reason }`),
 * never thrown and NEVER silently advanced. Mutation-resistant: if a guard were turned into a silent
 * advance, these tests must catch it.
 */
import { describe, expect, it } from "vitest";
import { transition } from "./fsm.js";
import type { StepRecord, Task } from "./session.js";

function task(over: Partial<Task> = {}): Task {
  return {
    taskId: "task-1",
    status: "pending",
    steps: [
      { tool: "a", context: {} },
      { tool: "b", context: {} },
    ],
    cursor: 0,
    ...over,
  } as Task;
}

function record(stepIndex: number): StepRecord {
  return {
    stepKey: `sha256:k${stepIndex}`,
    stepIndex,
    outcome: { status: "executed" },
    recordedAt: "2026-06-21T00:00:00.000Z",
  } as StepRecord;
}

describe("transition — legal moves", () => {
  it("pending --start--> running", () => {
    const r = transition(task(), { kind: "start" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.status).toBe("running");
  });

  it("running --step-executed--> stays running, cursor+1 (not last step)", () => {
    const r = transition(task({ status: "running", cursor: 0 }), {
      kind: "step-executed",
      record: record(0),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.task.status).toBe("running");
      expect(r.task.cursor).toBe(1);
    }
  });

  it("running --step-executed on last step--> completed", () => {
    const r = transition(task({ status: "running", cursor: 1 }), {
      kind: "step-executed",
      record: record(1),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.task.status).toBe("completed");
      expect(r.task.cursor).toBe(2);
    }
  });

  it("running --step-denied--> failed (deny-by-default; not silently skipped)", () => {
    const denied = {
      stepKey: "sha256:d0",
      stepIndex: 0,
      outcome: { status: "denied", stage: "policy", reason: "blocked" },
      recordedAt: "2026-06-21T00:00:00.000Z",
    } as StepRecord;
    const r = transition(task({ status: "running", cursor: 0 }), {
      kind: "step-denied",
      record: denied,
      reason: "blocked",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.status).toBe("failed");
  });

  it("running --abort--> aborted", () => {
    const r = transition(task({ status: "running", cursor: 0 }), {
      kind: "abort",
      reason: "user cancelled",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.status).toBe("aborted");
  });
});

describe("transition — deny-by-default guards (adversarial)", () => {
  it("rejects start on an already-completed task (no silent advance)", () => {
    const r = transition(task({ status: "completed", cursor: 2 }), { kind: "start" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  it("rejects step-executed on a pending (not-yet-started) task", () => {
    const r = transition(task({ status: "pending", cursor: 0 }), {
      kind: "step-executed",
      record: record(0),
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown event kind (deny-by-default)", () => {
    const r = transition(task({ status: "running" }), {
      kind: "explode",
    } as unknown as Parameters<typeof transition>[1]);
    expect(r.ok).toBe(false);
  });

  it("rejects a step-executed whose record.stepIndex does not match the cursor", () => {
    const r = transition(task({ status: "running", cursor: 0 }), {
      kind: "step-executed",
      record: record(1),
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a step-executed when cursor is out of bounds", () => {
    const r = transition(task({ status: "running", cursor: 2 }), {
      kind: "step-executed",
      record: record(2),
    });
    expect(r.ok).toBe(false);
  });

  it("does not throw on any illegal transition", () => {
    expect(() =>
      transition(task({ status: "failed" }), { kind: "abort", reason: "late" }),
    ).not.toThrow();
  });
});
