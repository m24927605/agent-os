/**
 * CostGate port — the vendor-neutral contract for the spend gate (one pluggable slot; default
 * adapter SpendGuard, landing under src/cost/adapters/<vendor>/ later).
 *
 * Stripe-style auth/capture on tokens: `reserve` holds an estimated cost BEFORE the provider is hit
 * (reserve-before-effect); `commit` settles the real usage. Two safety invariants hold by
 * construction: an over-budget reserve is DENIED (hard-cap — a runaway agent cannot bankrupt a
 * tenant), and a commit without a prior reservation is denied. The port is CREDENTIAL-BLIND: it only
 * ever receives token counts + a resource id, NEVER a credential (asserted by the contract test).
 *
 * Cohesion: the port + its in-tree adapters import only identity primitives (no egress, no vendor).
 */
import { type AgentContext, parseAgentContext } from "../iam/ids.js";

/** Auditable cost-gate event (NOT yet appended to the evidence kernel). Carries no secret/credential. */
export interface CostEvent {
  readonly phase: "reserve" | "commit";
  readonly result: "ok" | "denied";
  readonly context?: AgentContext;
  readonly contextError?: string;
  readonly resource?: string;
  readonly reason?: string;
}

export type ReserveResult =
  | { status: "ok"; reservationId: string; event: CostEvent }
  | { status: "denied"; reason: string; event: CostEvent };

export type CommitResult =
  // `overrun` = the real `actualTokens` pushed total settled spend OVER budget. A committed call
  // CANNOT be denied after the fact (the provider was already hit — the spend is real and must be
  // recorded faithfully, never under-recorded); instead it is recorded with `overrun: true`, and the
  // budget is now exhausted so every SUBSEQUENT reserve is denied (the hard-cap is proactive on
  // reserve; an in-flight overshoot is recorded, not erased — cf. irreversible external effects).
  | { status: "committed"; overrun: boolean; event: CostEvent }
  | { status: "denied"; reason: string; event: CostEvent };

export interface ReserveRequest {
  readonly estimatedTokens: number;
  readonly resource: string;
}

export interface CommitSettle {
  readonly actualTokens: number;
}

export interface CostGate {
  reserve(ctx: unknown, req: ReserveRequest): Promise<ReserveResult>;
  commit(ctx: unknown, reservationId: string, settle: CommitSettle): Promise<CommitResult>;
}

/** A finite, positive integer token count — anything else is fail-closed denied. */
export function isValidTokenCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

/** Validate ctx fail-closed; returns the AgentContext or an error string (never throws). */
export function contextOrError(ctx: unknown): { context: AgentContext } | { contextError: string } {
  try {
    return { context: parseAgentContext(ctx) };
  } catch {
    return { contextError: "invalid agent context" };
  }
}

/** Build a denied reserve/commit result, fail-closed even on a malformed AgentContext. */
export function denyReserve(ctx: unknown, reason: string, resource?: string): ReserveResult {
  const c = contextOrError(ctx);
  return {
    status: "denied",
    reason,
    event: { phase: "reserve", result: "denied", resource, reason, ...c },
  };
}

export function denyCommit(ctx: unknown, reason: string): CommitResult {
  const c = contextOrError(ctx);
  return { status: "denied", reason, event: { phase: "commit", result: "denied", reason, ...c } };
}
