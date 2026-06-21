/**
 * RED-first contract tests for the R5 type basis: AgentSession / Task / StepRecord zod `.strict()`
 * schemas. Security invariant under test: `.strict()` is deny-by-default — any extra/unknown field
 * or any missing/illegal field MUST fail closed (parse throws), never silently accepted.
 */
import { describe, expect, it } from "vitest";
import { AgentSession, StepRecord, Task } from "./session.js";

const validSession = {
  sessionId: "sess-1",
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  startedAt: "2026-06-21T00:00:00.000Z",
};

const validStepRecord = {
  stepKey: "sha256:deadbeef",
  stepIndex: 0,
  outcome: { status: "executed" as const },
  recordedAt: "2026-06-21T00:00:00.000Z",
};

const validTask = {
  taskId: "task-1",
  status: "pending" as const,
  steps: [{ tool: "fs:read", context: { path: "/workspace/readme.md" } }],
  cursor: 0,
};

describe("AgentSession schema — strict, fail-closed", () => {
  it("parses a complete valid session", () => {
    const parsed = AgentSession.parse(validSession);
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.actorId).toBe("agent:claude");
  });

  it("rejects an extra/unknown field (deny-by-default)", () => {
    expect(() => AgentSession.parse({ ...validSession, surprise: "x" })).toThrow();
  });

  it("rejects a missing required id", () => {
    const { tenantId, ...rest } = validSession;
    expect(() => AgentSession.parse(rest)).toThrow();
  });

  it("rejects a non-datetime startedAt", () => {
    expect(() => AgentSession.parse({ ...validSession, startedAt: "not-a-date" })).toThrow();
  });
});

describe("StepRecord schema — strict, fail-closed", () => {
  it("parses an executed record", () => {
    const parsed = StepRecord.parse(validStepRecord);
    expect(parsed.stepKey).toBe("sha256:deadbeef");
    expect(parsed.outcome.status).toBe("executed");
  });

  it("parses a denied record carrying stage + reason (maps P2-I GovernedOutcome)", () => {
    const parsed = StepRecord.parse({
      ...validStepRecord,
      outcome: { status: "denied", stage: "policy", reason: "no matching allow rule" },
    });
    expect(parsed.outcome.status).toBe("denied");
  });

  it("rejects a missing stepKey", () => {
    const { stepKey, ...rest } = validStepRecord;
    expect(() => StepRecord.parse(rest)).toThrow();
  });

  it("rejects an extra field (deny-by-default)", () => {
    expect(() => StepRecord.parse({ ...validStepRecord, leak: "y" })).toThrow();
  });

  it("rejects an illegal outcome.status", () => {
    expect(() => StepRecord.parse({ ...validStepRecord, outcome: { status: "maybe" } })).toThrow();
  });
});

describe("Task schema — strict, fail-closed", () => {
  it("parses a valid pending task with ordered steps + cursor", () => {
    const parsed = Task.parse(validTask);
    expect(parsed.status).toBe("pending");
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.cursor).toBe(0);
  });

  it("rejects an illegal status", () => {
    expect(() => Task.parse({ ...validTask, status: "halted" })).toThrow();
  });

  it("rejects an extra field (deny-by-default)", () => {
    expect(() => Task.parse({ ...validTask, extra: 1 })).toThrow();
  });

  it("rejects a negative cursor", () => {
    expect(() => Task.parse({ ...validTask, cursor: -1 })).toThrow();
  });
});
