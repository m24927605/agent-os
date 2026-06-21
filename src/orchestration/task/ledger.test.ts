/**
 * RED-first tests for SLICE-P2R-R5-S2: the append-only `ResumeLedger` port + its in-memory fake,
 * the deterministic content-hash `computeStepKey`, and the reusable `resumeLedgerContract` harness.
 *
 * Security invariants under test (the crash-resume "no DUPLICATED effect" moat):
 *  - append-only: a recorded step can never be overwritten or deleted.
 *  - idempotent-append (dedup): re-appending the same stepKey is a no-op-with-signal, NEVER a
 *    second row and NEVER an overwrite — so a replayed step does not re-trigger its external effect.
 *  - list preserves append order.
 *  - computeStepKey is deterministic (same input -> same hex; reordered intent keys -> same hex)
 *    and fail-closed (non-finite numbers / undefined throw, no silent coercion to a divergent key).
 */
import { describe, expect, it } from "vitest";
import type { TaskId } from "../../iam/ids.js";
import { InMemoryResumeLedger, computeStepKey, resumeLedgerContract } from "./ledger.js";
import type { ResumeLedger } from "./ledger.js";
import type { StepRecord } from "./session.js";

const taskId = "task-1" as TaskId;

function recordFor(
  stepIndex: number,
  stepKey: string,
  status: "executed" | "denied" = "executed",
): StepRecord {
  return status === "executed"
    ? {
        stepKey,
        stepIndex,
        outcome: { status: "executed" },
        recordedAt: "2026-06-21T00:00:00.000Z",
      }
    : {
        stepKey,
        stepIndex,
        outcome: { status: "denied", stage: "policy", reason: "blocked" },
        recordedAt: "2026-06-21T00:00:00.000Z",
      };
}

describe("InMemoryResumeLedger — append-only / idempotent", () => {
  it("append-only: re-appending the same stepKey returns {appended:false} and does not overwrite", async () => {
    const ledger: ResumeLedger = new InMemoryResumeLedger();
    const first = recordFor(0, "key-a", "executed");

    expect(await ledger.append(taskId, first)).toEqual({ appended: true });

    // Same stepKey, DIFFERENT content (adversarial): must be rejected, original preserved.
    const tampered = recordFor(0, "key-a", "denied");
    expect(await ledger.append(taskId, tampered)).toEqual({ appended: false });

    const rows = await ledger.list(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome.status).toBe("executed"); // original NOT overwritten
  });

  it("has(): reports membership by stepKey", async () => {
    const ledger = new InMemoryResumeLedger();
    expect(await ledger.has("key-a")).toBe(false);
    await ledger.append(taskId, recordFor(0, "key-a"));
    expect(await ledger.has("key-a")).toBe(true);
  });

  it("list preserves append order and is scoped per task", async () => {
    const ledger = new InMemoryResumeLedger();
    await ledger.append(taskId, recordFor(0, "k0"));
    await ledger.append(taskId, recordFor(1, "k1"));
    await ledger.append(taskId, recordFor(2, "k2"));

    const rows = await ledger.list(taskId);
    expect(rows.map((r) => r.stepKey)).toEqual(["k0", "k1", "k2"]);

    const other = "task-2" as TaskId;
    expect(await ledger.list(other)).toEqual([]);
  });

  it("list returns a snapshot that cannot mutate ledger internals (append-only structural guard)", async () => {
    const ledger = new InMemoryResumeLedger();
    await ledger.append(taskId, recordFor(0, "k0"));
    const rows = (await ledger.list(taskId)) as StepRecord[];
    // Even if a caller mutates the returned array, the ledger stays append-only.
    rows.length = 0;
    expect(await ledger.list(taskId)).toHaveLength(1);
  });
});

describe("computeStepKey — deterministic content hash, fail-closed", () => {
  it("is deterministic: same (taskId, stepIndex, intent) -> same hex on repeated calls", () => {
    const input = { taskId, stepIndex: 0, intent: { tool: "fs:read", context: { path: "/a" } } };
    const a = computeStepKey(input);
    const b = computeStepKey(input);
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("different intent -> different hex", () => {
    const a = computeStepKey({ taskId, stepIndex: 0, intent: { tool: "fs:read" } });
    const b = computeStepKey({ taskId, stepIndex: 0, intent: { tool: "fs:write" } });
    expect(a).not.toBe(b);
  });

  it("different stepIndex -> different hex (position is part of identity)", () => {
    const a = computeStepKey({ taskId, stepIndex: 0, intent: { tool: "fs:read" } });
    const b = computeStepKey({ taskId, stepIndex: 1, intent: { tool: "fs:read" } });
    expect(a).not.toBe(b);
  });

  it("canonical determinism (adversarial): reordered intent keys -> SAME stepKey", () => {
    const a = computeStepKey({
      taskId,
      stepIndex: 0,
      intent: { tool: "x", context: { a: 1, b: 2 } },
    });
    const b = computeStepKey({
      taskId,
      stepIndex: 0,
      intent: { context: { b: 2, a: 1 }, tool: "x" },
    });
    expect(a).toBe(b);
  });

  it("fail-closed: non-finite number in intent throws (no silent coercion)", () => {
    expect(() => computeStepKey({ taskId, stepIndex: 0, intent: { n: Number.NaN } })).toThrow();
    expect(() =>
      computeStepKey({ taskId, stepIndex: 0, intent: { n: Number.POSITIVE_INFINITY } }),
    ).toThrow();
  });

  it("fail-closed: undefined nested in an array throws", () => {
    expect(() => computeStepKey({ taskId, stepIndex: 0, intent: { arr: [undefined] } })).toThrow();
  });
});

describe("resumeLedgerContract harness", () => {
  it("InMemoryResumeLedger satisfies the ResumeLedger contract", () => {
    resumeLedgerContract(() => new InMemoryResumeLedger());
  });
});
