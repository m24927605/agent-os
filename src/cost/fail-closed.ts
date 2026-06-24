/**
 * Fail-closed CostGate decorator (SLICE-IT1a) — wraps ANY CostGate so a method that REJECTS/THROWS is
 * converted into a structured DENY (deny-by-default), never an escaping rejection.
 *
 * The in-tree gates (InMemoryCostGate / NullCostGate) NEVER reject — they always resolve a structured
 * `{status:"denied"|...}`. So wrapping them is BEHAVIOURALLY TRANSPARENT (byte-identical): the wrapper
 * only ever changes behaviour on the rejection path, which those gates do not take. The decorator
 * exists for INJECTED, external/vendor gates (e.g. a SpendGuardCostGate talking to a sidecar) whose I/O
 * can fail: a thrown reserve must deny@cost (not crash the pipeline), and a thrown commit/release on the
 * settle/abort path must surface a structured deny rather than an unhandled rejection.
 *
 * SECURITY: the deny `reason` is STATIC (a fixed deny-by-default code) — it NEVER interpolates the
 * thrown error's message, so a fault carrying request/credential detail cannot leak through the reason
 * into an audit surface (credential-blind). Imports only the port (no vendor, no egress).
 */
import {
  type CommitResult,
  type CommitSettle,
  type CostGate,
  type ReleaseResult,
  type ReserveRequest,
  type ReserveResult,
  denyCommit,
  denyRelease,
  denyReserve,
} from "./port.js";

const FAULT_REASON = "cost gate faulted — deny-by-default (fail-closed)";

/**
 * Wrap `inner` so any rejected reserve/commit/release becomes a structured deny. A gate that already
 * IS fail-closed (resolves structured results) is unaffected. Use at injection points where the gate
 * is external/untrusted.
 */
export function failClosedCostGate(inner: CostGate): CostGate {
  return new FailClosedCostGate(inner);
}

class FailClosedCostGate implements CostGate {
  constructor(private readonly inner: CostGate) {}

  async reserve(ctx: unknown, req: ReserveRequest): Promise<ReserveResult> {
    try {
      return await this.inner.reserve(ctx, req);
    } catch {
      // Static reason ONLY (no error.message) — a fault must never leak request/credential detail.
      return denyReserve(ctx, FAULT_REASON, req.resource);
    }
  }

  async commit(ctx: unknown, reservationId: string, settle: CommitSettle): Promise<CommitResult> {
    try {
      return await this.inner.commit(ctx, reservationId, settle);
    } catch {
      return denyCommit(ctx, FAULT_REASON);
    }
  }

  async release(ctx: unknown, reservationId: string): Promise<ReleaseResult> {
    try {
      return await this.inner.release(ctx, reservationId);
    } catch {
      return denyRelease(ctx, FAULT_REASON);
    }
  }
}
