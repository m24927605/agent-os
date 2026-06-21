/**
 * Commit-before-effect guard (TS side) — the load-bearing sequencing invariant of the evidence moat.
 *
 * An external EFFECT (a sandbox lifecycle op, a tool invocation, an egress call) MUST NOT become
 * observable until its AuditEvent is durably appended to the WORM kernel and a Receipt is in hand.
 * If the append fails or times out, the effect is REFUSED — never "best-effort run, log later". This
 * is what makes crash-resume and "no silent un-recorded effect" possible (mirrors the Go
 * kernel/internal/commitgate on the kernel side).
 *
 * Deliberately GENERIC and dependency-free (imports NOTHING from other src modules): it is a pure
 * sequencing combinator. The composition root injects the real append client (audit/kernel) and the
 * real effect (a substrate adapter call); commitgate stays vendor-neutral and zero-coupling.
 */

/**
 * The minimal append capability the guard needs: append an event, resolve a receipt, or reject.
 * Contract for adapter authors: a RESOLVED promise — even with a falsy/empty receipt — counts as a
 * durable commit and lets the effect run. Signal failure by REJECTING (or never resolving), NEVER by
 * resolving a falsy value; resolving on a soft failure would let an un-recorded effect through.
 */
export interface CommitAppender<E, R> {
  append(event: E): Promise<R>;
}

export type CommitOutcome<R, T> =
  | { status: "committed"; receipt: R; result: T }
  | { status: "aborted"; reason: string };

export interface CommitBeforeEffectArgs<E, R, T> {
  readonly appender: CommitAppender<E, R>;
  readonly event: E;
  /** The external effect — invoked ONLY after a durable receipt. */
  readonly effect: () => Promise<T>;
  /** Optional bound on how long to wait for the receipt before refusing the effect (fail-closed). */
  readonly timeoutMs?: number;
}

class CommitTimeoutError extends Error {}

function withTimeout<R>(p: Promise<R>, timeoutMs: number): Promise<R> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new CommitTimeoutError(`append timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Append the event, AWAIT the receipt, and only then run the effect. On any append failure/timeout
 * the effect is NOT invoked and the call resolves to `aborted` (fail-closed). An effect that throws
 * AFTER a successful commit rejects (the intent is already recorded; the effect's own failure is a
 * separate, audited concern) — it is not swallowed.
 */
export async function commitBeforeEffect<E, R, T>(
  args: CommitBeforeEffectArgs<E, R, T>,
): Promise<CommitOutcome<R, T>> {
  let receipt: R;
  try {
    const appendPromise = args.appender.append(args.event);
    receipt =
      args.timeoutMs === undefined
        ? await appendPromise
        : await withTimeout(appendPromise, args.timeoutMs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: "aborted", reason: `commit failed before effect: ${reason}` };
  }
  // Durable receipt in hand — the effect may now become observable.
  const result = await args.effect();
  return { status: "committed", receipt, result };
}
