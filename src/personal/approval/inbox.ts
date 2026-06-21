/**
 * ApprovalInbox — the explicit-approval gate that makes design invariant 2
 * (plan-preview-before-effect) command-verifiable.
 *
 * Design §2.1 / §2.3 / §5: a plain-language PlanPreview only becomes a real effect when the owner
 * EXPLICITLY `approve`s it; `approve` is the SOLE call site of the injected governed-pipeline runner
 * (P2-I `runGovernedToolCall`). Any other state — pending, rejected, expired, or an unknown id —
 * runs NOTHING (deny-by-default / fail-closed).
 *
 * Security invariants this module enforces (each pinned by inbox.test.ts):
 *   - deny-by-default: a still-pending entry never invokes the runner; reject denies and never runs.
 *   - one-time authorization (anti-replay): approve authorizes THIS entry exactly ONCE; the entry then
 *     becomes terminal, so a second approve is denied and the effect cannot double-fire.
 *   - pending cap (hard cap): at most MAX_PENDING pending entries at a time (borrowed from Hermes'
 *     `MAX_PENDING_PER_PLATFORM=3`, gateway/pairing.py:49); the over-cap submit is denied.
 *
 * Low coupling (design §2.2): no vendor, no adapter, no top-level `src/index.ts` import. The pipeline
 * is supplied as a single injected `run` function (same DI pattern as P2-I / commitgate), so this
 * module reaches into no other module's internals — it consumes only barrel TYPES: `GovernedCall` /
 * `GovernedOutcome` from the `orchestration` barrel and `PlanPreview` from the `personal/plan` barrel,
 * both inward and acyclic.
 *
 * Persistence is OUT OF SCOPE (spec §3): pending lives in-memory only; a durable store is left to R8.
 */
import type { GovernedCall, GovernedOutcome } from "../../orchestration/index.js";
import type { PlanPreview } from "../plan/index.js";

/**
 * Hard cap on concurrently-pending plans, mirroring Hermes' per-platform pairing cap
 * (`MAX_PENDING_PER_PLATFORM = 3`). A submit that would exceed this is denied.
 */
export const MAX_PENDING = 3;

/** The result of submitting a plan for approval. */
export type SubmitOutcome =
  | { status: "pending"; id: string }
  | { status: "denied"; reason: string };

/**
 * The result of deciding (approve/reject) an entry.
 *
 * - `executed`: the owner approved AND the P2-I pipeline ran to completion; `outcome` carries the
 *   `GovernedOutcome` (`status:"executed"`).
 * - `denied`: nothing took effect. Two distinct denial sources, both fail-closed:
 *     (a) the inbox refused to even run the pipeline — unknown id, an already-terminal entry, or a
 *         `reject` — surfaced via `reason` (no `outcome`).
 *     (b) the owner approved but the P2-I pipeline itself short-circuited at a gate
 *         (screen/policy/cost/commit); the pipeline's `GovernedOutcome` (`status:"denied"` with its
 *         `stage`) is passed through unchanged in `outcome`.
 */
export type DecideOutcome<R> =
  | { status: "executed"; outcome: GovernedOutcome<R> }
  | { status: "denied"; reason?: string; outcome?: GovernedOutcome<R> };

/** Internal pending record. Once decided, the entry is removed (terminal) — never replayable. */
interface PendingEntry<TC extends GovernedCall> {
  readonly call: TC;
  readonly preview: PlanPreview;
}

/**
 * An in-memory inbox of plans awaiting explicit owner approval. `approve` is the ONLY path that
 * invokes the injected governed-pipeline runner; everything else is deny-by-default.
 */
export class ApprovalInbox<TC extends GovernedCall, R> {
  /** Pending entries keyed by id. A decided entry is deleted, which is what makes it terminal. */
  readonly #pending = new Map<string, PendingEntry<TC>>();
  #seq = 0;
  readonly #run: (tc: TC) => Promise<GovernedOutcome<R>>;

  /**
   * @param run the injected governed-pipeline runner (P2-I `runGovernedToolCall` partially applied
   *   with its deps by the composition root). ApprovalInbox never builds or reaches a pipeline itself.
   */
  constructor(run: (tc: TC) => Promise<GovernedOutcome<R>>) {
    this.#run = run;
  }

  /** Queue a plan for approval. Denied (fail-closed) when the pending cap is already reached. */
  submit(preview: PlanPreview, call: TC): SubmitOutcome {
    if (this.#pending.size >= MAX_PENDING) {
      return {
        status: "denied",
        reason: `pending cap reached (${MAX_PENDING}); decide an existing plan before submitting another`,
      };
    }
    const id = `approval-${++this.#seq}`;
    this.#pending.set(id, { call, preview });
    return { status: "pending", id };
  }

  /**
   * Explicitly approve a pending entry: lower it to the runner EXACTLY once, mark it terminal, and
   * return the pipeline outcome. Unknown / already-decided ids are denied (deny-by-default).
   */
  async approve(id: string): Promise<DecideOutcome<R>> {
    const entry = this.#pending.get(id);
    if (entry === undefined) {
      return { status: "denied", reason: `no pending plan with id "${id}"` };
    }
    // Consume the entry BEFORE running so it is terminal even across the await — no replay, no
    // double-effect even under concurrent approve(id) calls (the second sees nothing pending).
    this.#pending.delete(id);
    const outcome = await this.#run(entry.call);
    // Pass the pipeline's verdict through: an `executed` pipeline -> executed decision; a pipeline
    // gate short-circuit (`denied` with a stage) -> denied decision carrying that outcome unchanged.
    if (outcome.status === "denied") {
      return { status: "denied", outcome };
    }
    return { status: "executed", outcome };
  }

  /** Reject a pending entry: it is denied and removed (terminal). The runner is never invoked. */
  reject(id: string): DecideOutcome<R> {
    const existed = this.#pending.delete(id);
    return {
      status: "denied",
      reason: existed ? `plan "${id}" rejected by owner` : `no pending plan with id "${id}"`,
    };
  }
}
