/**
 * In-memory cost gate — the mandatory 2nd implementation of the CostGate port (and a deterministic
 * local/test gate). Enforces a single token budget with reserve(hold)/commit(settle):
 *  - reserve-before-effect: a held reservation is required before commit;
 *  - hard-cap: a reserve whose estimate exceeds the remaining budget is DENIED (by construction);
 *  - fail-closed: malformed ctx or a non-finite/non-positive estimate is denied.
 * No real I/O: state is in-memory maps. Imports only the port + identity primitives.
 */
import { SandboxId, parseAgentContext } from "../iam/ids.js";
import {
  type CommitResult,
  type CostGate,
  type ReleaseResult,
  type ReserveRequest,
  type ReserveResult,
  contextOrError,
  denyCommit,
  denyRelease,
  denyReserve,
  isValidTokenCount,
} from "./port.js";

export class InMemoryCostGate implements CostGate {
  private held = 0;
  private settled = 0;
  private counter = 0;
  private readonly reservations = new Map<string, number>();

  constructor(private readonly budget: number) {}

  reserve(ctx: unknown, req: ReserveRequest): Promise<ReserveResult> {
    const c = contextOrError(ctx);
    if ("contextError" in c) {
      return Promise.resolve(denyReserve(ctx, "invalid agent context (fail-closed)", req.resource));
    }
    if (!isValidTokenCount(req.estimatedTokens)) {
      return Promise.resolve(
        denyReserve(ctx, "estimatedTokens must be a positive integer (fail-closed)", req.resource),
      );
    }
    if (this.settled + this.held + req.estimatedTokens > this.budget) {
      return Promise.resolve(
        denyReserve(ctx, "budget exhausted (hard-cap, deny-by-default)", req.resource),
      );
    }
    this.held += req.estimatedTokens;
    const reservationId = SandboxId.parse(`rsv-${++this.counter}`);
    this.reservations.set(reservationId, req.estimatedTokens);
    return Promise.resolve({
      status: "ok",
      reservationId,
      event: { phase: "reserve", result: "ok", context: c.context, resource: req.resource },
    });
  }

  commit(
    ctx: unknown,
    reservationId: string,
    settle: { actualTokens: number },
  ): Promise<CommitResult> {
    const c = contextOrError(ctx);
    if ("contextError" in c) {
      return Promise.resolve(denyCommit(ctx, "invalid agent context (fail-closed)"));
    }
    const reserved = this.reservations.get(reservationId);
    if (reserved === undefined) {
      // reserve-before-effect: cannot settle a cost that was never reserved.
      return Promise.resolve(denyCommit(ctx, "unknown reservation (reserve-before-effect)"));
    }
    if (!isValidTokenCount(settle.actualTokens)) {
      return Promise.resolve(
        denyCommit(ctx, "actualTokens must be a positive integer (fail-closed)"),
      );
    }
    this.reservations.delete(reservationId);
    this.held -= reserved;
    this.settled += settle.actualTokens;
    // The provider was already hit — record the real spend faithfully. If it overshot the budget we
    // CANNOT un-spend it; we flag the overrun and let the now-exhausted budget deny every later reserve.
    const overrun = this.settled > this.budget;
    return Promise.resolve({
      status: "committed",
      overrun,
      event: {
        phase: "commit",
        result: "ok",
        context: c.context,
        reason: overrun
          ? "committed with budget overrun (recorded; further reserves denied)"
          : undefined,
      },
    });
  }

  release(ctx: unknown, reservationId: string): Promise<ReleaseResult> {
    const c = contextOrError(ctx);
    if ("contextError" in c) {
      return Promise.resolve(denyRelease(ctx, "invalid agent context (fail-closed)"));
    }
    const reserved = this.reservations.get(reservationId);
    if (reserved === undefined) {
      // Unknown / already committed / already released: deny-by-default — never free budget twice,
      // never drive `held` negative (double-release defence).
      return Promise.resolve(denyRelease(ctx, "unknown reservation (deny-by-default)"));
    }
    this.reservations.delete(reservationId);
    this.held -= reserved; // settled is untouched: no real spend occurred.
    return Promise.resolve({
      status: "released",
      event: { phase: "release", result: "ok", context: c.context },
    });
  }
}
