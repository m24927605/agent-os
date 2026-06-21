/**
 * Deterministic content-hash `stepKey` for a governed step (SLICE-P2R-R5-S2).
 *
 * `stepKey = sha256(taskId ‖ stepIndex ‖ canonical(intent))`. The hash MUST be reproducible across
 * process restarts so that, on crash-resume, the same step computes the same key and is recognised
 * as already-done — the root of the "no DUPLICATED external effect" invariant (see
 * docs/design/task-agentsession-fsm.md §2.3).
 *
 * Discipline note (low coupling): the audit module already has a deterministic canonical-JSON, but
 * `src/audit/canonical.ts`'s `canonicalJson` is module-private and there is no `src/audit/index.ts`
 * barrel — a deep import would break `.dependency-cruiser.cjs` `not-to-internal`. So R5 follows the
 * "same law, different code" rule: a minimal, pure canonical-JSON is re-implemented here (recursive
 * key sort, fail-closed on non-finite numbers / stray undefined / bigint — same discipline as
 * `src/audit/canonical.ts:18-62`). The only external dependency is `node:crypto` (a doNotFollow core
 * module). Zero cross-module deep imports. Convergence onto a single canonicalizer is a separate
 * dependency/contract slice, not this behavior slice.
 */
import { createHash } from "node:crypto";
import type { TaskId } from "../../iam/ids.js";

/** Deterministic JSON: keys sorted recursively; no silent coercion of non-serializable values. */
function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("computeStepKey: non-finite number is not serializable");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    throw new Error("computeStepKey: bigint is not serializable");
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (item === undefined) {
        throw new Error("computeStepKey: undefined array element is not serializable");
      }
      return canonicalJson(item);
    });
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      // An undefined property is "absent" (deterministic, matches JSON object semantics) — omit it.
      if (child === undefined) {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${canonicalJson(child)}`);
    }
    return `{${parts.join(",")}}`;
  }
  // undefined (top-level), function, symbol — fail closed, no ambiguous key.
  throw new Error(`computeStepKey: unserializable value of type ${typeof value}`);
}

/**
 * Content address of a step: `sha256:<hex>` over the canonical bytes of its DETERMINISTIC identity
 * (taskId, stepIndex, intent). Non-deterministic execution-time data MUST stay out of `intent` so
 * the same step re-hashes identically after a restart.
 */
export function computeStepKey(input: {
  taskId: TaskId;
  stepIndex: number;
  intent: unknown;
}): string {
  const canonical = canonicalJson({
    taskId: input.taskId as string,
    stepIndex: input.stepIndex,
    intent: input.intent,
  });
  const hex = createHash("sha256").update(new TextEncoder().encode(canonical)).digest("hex");
  return `sha256:${hex}`;
}
