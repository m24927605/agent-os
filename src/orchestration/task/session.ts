/**
 * R5 type basis (contract-before-consumer): the `.strict()` zod schemas + inferred types for an
 * `AgentSession` (who is running a Task), a `Task` (a multi-step governed work unit), and a
 * `StepRecord` (the append-only result of one governed step).
 *
 * Deny-by-default by construction: every schema is `.strict()` (same pattern as `src/audit/event.ts`)
 * so any unknown/extra field fails closed. Identity ids reuse the branded `iam/ids` primitives — no
 * parallel identity is minted here. Import path is `../../iam/ids.js` (the interim pre-barrel entry
 * allowlisted in `.dependency-cruiser.cjs`); there is no `src/iam/index.ts` barrel yet.
 *
 * `StepRecord.outcome` mirrors P2-I's `GovernedOutcome` (`src/orchestration/pipeline.ts`): an executed
 * step carries no reason; a denied step carries the governing `stage` + `reason`. This slice treats
 * `stepKey` as an opaque string — its content-hash COMPUTATION belongs to SLICE-P2R-R5-S2.
 */
import { z } from "zod";
import { ActorId, ProjectId, TaskId, TenantId } from "../../iam/ids.js";

/** The five Task lifecycle states (R5 minimal subset; `paused-awaiting-approval` is out of scope). */
export const TaskStatus = z.enum(["pending", "running", "completed", "failed", "aborted"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

const nonEmpty = z.string().trim().min(1);
const isoTimestamp = z.string().datetime({ offset: true });

/**
 * The minimal shape of a single step intent. Structurally compatible with P2-I's `GovernedCall`
 * (`tool` + opaque `context`) so the runner (S3) can build a `toolCall` from a step without a
 * cross-module concrete import.
 */
export const StepIntent = z
  .object({
    tool: nonEmpty,
    context: z.unknown(),
  })
  .strict();
export type StepIntent = z.infer<typeof StepIntent>;

/** Mirror of P2-I `GovernedOutcome`, narrowed to what a StepRecord persists. */
export const StepOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("executed") }).strict(),
  z
    .object({
      status: z.literal("denied"),
      stage: z.enum(["screen", "policy", "cost", "commit"]),
      reason: nonEmpty,
    })
    .strict(),
]);
export type StepOutcome = z.infer<typeof StepOutcome>;

/** Append-only record of one governed step. `stepKey` is an opaque content-hash (computed in S2). */
export const StepRecord = z
  .object({
    stepKey: nonEmpty,
    stepIndex: z.number().int().nonnegative(),
    outcome: StepOutcome,
    recordedAt: isoTimestamp,
  })
  .strict();
export type StepRecord = z.infer<typeof StepRecord>;

/** Execution identity + correlation for a Task. Reuses branded iam ids; mints no parallel identity. */
export const AgentSession = z
  .object({
    sessionId: nonEmpty,
    actorId: ActorId,
    tenantId: TenantId,
    projectId: ProjectId,
    startedAt: isoTimestamp,
  })
  .strict();
export type AgentSession = z.infer<typeof AgentSession>;

/** A multi-step governed work unit: ordered step intents + a cursor (index of next-to-run step). */
export const Task = z
  .object({
    taskId: TaskId,
    status: TaskStatus,
    steps: z.array(StepIntent),
    cursor: z.number().int().nonnegative(),
  })
  .strict();
export type Task = z.infer<typeof Task>;
