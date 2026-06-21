/**
 * SpendGuardCostGate — the real-vendor cost adapter for the CostGate port (R11-S3).
 *
 * SpendGuard's ledger is a session-reservation model: reserve_session -> commit_session_delta ->
 * release/expire (verified from /tmp/agentic-spendguard/services/ledger/src/session_reservations.rs:
 * ReserveSessionLedgerRequest :32-49 { tenant_id, estimated_amount_atomic, ttl_seconds,
 * idempotency_key }, reserve_session :97-112; CommitSessionDeltaLedgerRequest :51-77
 * { amount_atomic_delta, outcome }, commit_session_delta :114-127). This adapter maps that shape onto
 * the vendor-neutral CostGate port:
 *   - reserve(ctx,{estimatedTokens,resource}) -> reserve_session  (tokens -> estimated_amount_atomic,
 *     resource -> route); an over-budget ledger response is DENIED (hard-cap — a runaway agent cannot
 *     bankrupt a tenant, port.ts:7-9).
 *   - commit(ctx,reservationId,{actualTokens}) -> commit_session_delta (actualTokens ->
 *     amount_atomic_delta); an in-flight overrun is recorded with overrun=true (the provider was
 *     already hit — the real spend cannot be erased, port.ts:30-36) and the now-blown budget denies
 *     every SUBSEQUENT reserve.
 *
 * FAIL-CLOSED OVERRIDE (the honest mis-alignment, design vendor-adapters.md §2.3): SpendGuard's
 * estimation predictor fails OPEN when down. We OVERRIDE that with AGENTS.md's deny-by-default law —
 * a missing estimate (decision.rs :55-63 already fails closed on this) OR any LedgerTransport error
 * yields denyReserve, NEVER an allow.
 *
 * CREDENTIAL-BLIND (verified): SpendGuard sits at egress seeing only redacted headers; the ledger req
 * this adapter builds carries ONLY a token count + a route id, NEVER a credential (asserted by the
 * test). The CostGate port surface has no credential field by construction.
 *
 * Capability gate: the real Postgres-stored-proc-over-gRPC ledger (session_reservations.rs:3) is an
 * injected `LedgerTransport` seam, so the adapter runs fully in-process with no I/O and the core
 * imports no vendor SDK. release(reservationId) -> SpendGuard release_session (:129) is R12 follow-up,
 * deliberately out of scope. Cohesion: imports ONLY the cost port + iam/ids.
 */
import {
  type CommitResult,
  type CommitSettle,
  type CostGate,
  type ReleaseResult,
  type ReserveRequest,
  type ReserveResult,
  contextOrError,
  denyCommit,
  denyRelease,
  denyReserve,
  isValidTokenCount,
} from "../../port.js";

/** A reserve_session ledger request — token count + route only. NO credential field (verified). */
export interface LedgerReserveReq {
  readonly tenant_id: string;
  readonly estimated_amount_atomic: number;
  readonly route: string;
}

/** A commit_session_delta ledger request — the real settled delta. NO credential field. */
export interface LedgerCommitReq {
  readonly tenant_id: string;
  readonly reservation_id: string;
  readonly amount_atomic_delta: number;
}

/**
 * Injected transport seam to SpendGuard's ledger (live Postgres/gRPC lands in a post-R1 slice).
 * reserve resolves either a reservation id or an over-budget verdict (hard-cap); commit resolves
 * whether the settled delta overshot the budget. A throw / rejection is treated as fail-CLOSED.
 */
export interface LedgerTransport {
  reserve(req: LedgerReserveReq): Promise<{ reservationId: string } | { overBudget: true }>;
  commit(req: LedgerCommitReq): Promise<{ overrun: boolean }>;
}

export class SpendGuardCostGate implements CostGate {
  /** reservationId -> tenantId of the reserving caller (reserve-before-effect bookkeeping). */
  private readonly reservations = new Map<string, string>();
  /** Once an in-flight overrun is recorded, the budget is blown: every later reserve is denied. */
  private budgetBlown = false;

  constructor(private readonly ledger: LedgerTransport) {}

  async reserve(ctx: unknown, req: ReserveRequest): Promise<ReserveResult> {
    const c = contextOrError(ctx);
    if ("contextError" in c) {
      return denyReserve(ctx, "invalid agent context (fail-closed)", req.resource);
    }
    if (!isValidTokenCount(req.estimatedTokens)) {
      return denyReserve(
        ctx,
        "estimatedTokens must be a positive integer (fail-closed)",
        req.resource,
      );
    }
    if (this.budgetBlown) {
      return denyReserve(ctx, "budget exhausted (hard-cap, deny-by-default)", req.resource);
    }
    let res: { reservationId: string } | { overBudget: true };
    try {
      res = await this.ledger.reserve({
        tenant_id: c.context.tenantId,
        estimated_amount_atomic: req.estimatedTokens,
        route: req.resource,
      });
    } catch {
      // OVERRIDE SpendGuard's predictor-down fail-OPEN: a transport error is fail-CLOSED.
      return denyReserve(
        ctx,
        "ledger transport error (fail-closed, deny-by-default)",
        req.resource,
      );
    }
    if ("overBudget" in res) {
      return denyReserve(ctx, "budget exhausted (hard-cap, deny-by-default)", req.resource);
    }
    this.reservations.set(res.reservationId, c.context.tenantId);
    return {
      status: "ok",
      reservationId: res.reservationId,
      event: { phase: "reserve", result: "ok", context: c.context, resource: req.resource },
    };
  }

  async commit(ctx: unknown, reservationId: string, settle: CommitSettle): Promise<CommitResult> {
    const c = contextOrError(ctx);
    if ("contextError" in c) {
      return denyCommit(ctx, "invalid agent context (fail-closed)");
    }
    const reservingTenant = this.reservations.get(reservationId);
    if (reservingTenant === undefined) {
      // reserve-before-effect: cannot settle a cost that was never reserved here.
      return denyCommit(ctx, "unknown reservation (reserve-before-effect)");
    }
    if (reservingTenant !== c.context.tenantId) {
      return denyCommit(ctx, "cross-tenant reservation (fail-closed)");
    }
    if (!isValidTokenCount(settle.actualTokens)) {
      return denyCommit(ctx, "actualTokens must be a positive integer (fail-closed)");
    }
    let res: { overrun: boolean };
    try {
      res = await this.ledger.commit({
        tenant_id: c.context.tenantId,
        reservation_id: reservationId,
        amount_atomic_delta: settle.actualTokens,
      });
    } catch {
      return denyCommit(ctx, "ledger transport error (fail-closed, deny-by-default)");
    }
    // The provider was already hit — record the real spend faithfully (never erase / under-record).
    this.reservations.delete(reservationId);
    if (res.overrun) this.budgetBlown = true;
    return {
      status: "committed",
      overrun: res.overrun,
      event: {
        phase: "commit",
        result: "ok",
        context: c.context,
        reason: res.overrun
          ? "committed with budget overrun (recorded; further reserves denied)"
          : undefined,
      },
    };
  }

  // The real SpendGuard release_session RPC (ledger.proto :129) is deliberately out of scope (R11).
  // Until it is wired, release is fail-CLOSED deny-all — never frees a reservation here.
  release(ctx: unknown, _reservationId: string): Promise<ReleaseResult> {
    return Promise.resolve(
      denyRelease(
        ctx,
        "release not wired (deny-by-default, fail-closed; SpendGuard Release -> R11)",
      ),
    );
  }
}
