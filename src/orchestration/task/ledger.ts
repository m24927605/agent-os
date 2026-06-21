/**
 * The vendor-neutral, append-only `ResumeLedger` port + its in-memory fake (SLICE-P2R-R5-S2).
 *
 * The ledger is the Task-scoped, append-only source of truth for crash-resume: each governed step's
 * `StepRecord` is appended exactly once, keyed by a deterministic content-hash `stepKey`. Append-only
 * is a STRUCTURAL guarantee — there is no public `delete`/`update`, and re-appending an existing
 * `stepKey` is a no-op-with-signal (`{appended:false}`), never an overwrite and never a second row.
 * That dedup is what stops a replayed step from re-triggering its external effect (the dual of P2-I's
 * "no UN-RECORDED effect": "no DUPLICATED effect"). See docs/design/task-agentsession-fsm.md §2.3.
 *
 * The real, WORM-kernel-backed implementation depends on R2 (real TS->Go ingest) and is OUT of scope
 * here; this slice ships the port + the in-memory fake (the second implementation that proves the
 * contract is implementation-agnostic). `resumeLedgerContract` is the reusable harness future
 * implementations re-run.
 *
 * Low coupling: imports only the same-module S1 `StepRecord` schema and the branded `TaskId` (interim
 * pre-barrel allowlisted entry). No vendor, no cross-module deep import, no new third-party dependency.
 */
import { strict as assert } from "node:assert";
import type { TaskId } from "../../iam/ids.js";
import type { StepRecord } from "./session.js";

export { computeStepKey } from "./stepkey.js";

/**
 * Append-only resume ledger. Records are grouped per `taskId`; `stepKey` is the global dedup key.
 * `append` is idempotent by `stepKey`: the first write wins, later writes with the same key are a
 * no-op signalled by `{appended:false}` (never an overwrite, never throws on a duplicate).
 */
export interface ResumeLedger {
  append(taskId: TaskId, record: StepRecord): Promise<{ appended: boolean }>;
  /** Records for a task in append order. */
  list(taskId: TaskId): Promise<readonly StepRecord[]>;
  /** Whether a step with this `stepKey` has already been recorded (dedup query). */
  has(stepKey: string): Promise<boolean>;
}

/** In-memory `ResumeLedger` fake. Append-only by construction; no persistence side effects. */
export class InMemoryResumeLedger implements ResumeLedger {
  // Ordered append log per task (preserves list order) ...
  readonly #byTask = new Map<string, StepRecord[]>();
  // ... plus a global stepKey set for O(1) dedup / membership.
  readonly #seen = new Set<string>();

  append(taskId: TaskId, record: StepRecord): Promise<{ appended: boolean }> {
    if (this.#seen.has(record.stepKey)) {
      return Promise.resolve({ appended: false });
    }
    this.#seen.add(record.stepKey);
    const log = this.#byTask.get(taskId as string);
    if (log === undefined) {
      this.#byTask.set(taskId as string, [record]);
    } else {
      log.push(record);
    }
    return Promise.resolve({ appended: true });
  }

  list(taskId: TaskId): Promise<readonly StepRecord[]> {
    // Return a defensive copy so a caller mutating the result cannot mutate the ledger (append-only).
    return Promise.resolve([...(this.#byTask.get(taskId as string) ?? [])]);
  }

  has(stepKey: string): Promise<boolean> {
    return Promise.resolve(this.#seen.has(stepKey));
  }
}

/**
 * Contract harness: asserts append-only, idempotent-append-by-stepKey, and order-preserving `list`
 * for ANY `ResumeLedger` implementation. Re-run by this slice (over the fake) and by the future
 * WORM-backed implementation. Throws (via node assert) on the first violation.
 */
export function resumeLedgerContract(makeLedger: () => ResumeLedger): void {
  const taskId = "contract-task" as TaskId;
  const executed = (stepKey: string, stepIndex: number): StepRecord => ({
    stepKey,
    stepIndex,
    outcome: { status: "executed" },
    recordedAt: "2026-06-21T00:00:00.000Z",
  });

  void (async () => {
    // append-only + idempotent: same stepKey twice -> one row, original preserved.
    {
      const ledger = makeLedger();
      assert.deepEqual(await ledger.append(taskId, executed("c0", 0)), { appended: true });
      assert.equal(await ledger.has("c0"), true);
      const dup: StepRecord = {
        stepKey: "c0",
        stepIndex: 0,
        outcome: { status: "denied", stage: "policy", reason: "x" },
        recordedAt: "2026-06-21T00:00:00.000Z",
      };
      assert.deepEqual(await ledger.append(taskId, dup), { appended: false });
      const rows = await ledger.list(taskId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.outcome.status, "executed");
    }

    // list preserves append order.
    {
      const ledger = makeLedger();
      await ledger.append(taskId, executed("c0", 0));
      await ledger.append(taskId, executed("c1", 1));
      await ledger.append(taskId, executed("c2", 2));
      const rows = await ledger.list(taskId);
      assert.deepEqual(
        rows.map((r) => r.stepKey),
        ["c0", "c1", "c2"],
      );
    }

    // unknown task -> empty; unknown stepKey -> not present (deny-by-default membership).
    {
      const ledger = makeLedger();
      assert.deepEqual(await ledger.list("nope" as TaskId), []);
      assert.equal(await ledger.has("nope"), false);
    }
  })();
}
