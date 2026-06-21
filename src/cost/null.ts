/**
 * Fail-closed cost gate used when no real budget backend is wired: every reserve is DENIED
 * (deny-by-default), so nothing spends until a real CostGate is configured. No I/O.
 */
import {
  type CommitResult,
  type CostGate,
  type ReleaseResult,
  type ReserveRequest,
  type ReserveResult,
  denyCommit,
  denyRelease,
  denyReserve,
} from "./port.js";

const DENY_REASON = "no cost gate configured (deny-by-default, fail-closed)";

export class NullCostGate implements CostGate {
  reserve(ctx: unknown, req: ReserveRequest): Promise<ReserveResult> {
    return Promise.resolve(denyReserve(ctx, DENY_REASON, req.resource));
  }
  commit(
    ctx: unknown,
    _reservationId: string,
    _settle: { actualTokens: number },
  ): Promise<CommitResult> {
    return Promise.resolve(denyCommit(ctx, DENY_REASON));
  }
  release(ctx: unknown, _reservationId: string): Promise<ReleaseResult> {
    return Promise.resolve(denyRelease(ctx, DENY_REASON));
  }
}
