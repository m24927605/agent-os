/**
 * Lease lifecycle FSM — ITEM R4 (CredentialLease lifecycle), SLICE-P2R-R4-S2.
 *
 * Turns "is this lease transition legal?" into a command-verifiable finite state machine. The legal
 * transitions are:
 *
 *     issued  --inject-->  injected  --use-->  used
 *        \                    \                  \
 *         \--revoke/expire-----\--revoke/expire---\--revoke/expire--> (revoked | expired) [terminal]
 *
 * Everything NOT listed is denied. `deny-by-default / fail-closed` is the law: an unlisted, terminal,
 * expired, or malformed transition returns a `denied` result — it never throws in a way that lets the
 * operation through (a thrown error from a downstream parse is caught and converted to `denied`).
 *
 * Expiry window invariant (design doc §2.2): the `expired` terminal state is reached ONLY by an
 * explicit `expire()`, so a lease may be `state === "injected"` while `expiresAtMs <= now`. To stop
 * that window leaking authorization, EVERY entry that would "permit use" carries its own expiry check
 * and fails closed — here `use(lease, now)` denies when `expiresAtMs <= now` regardless of state. This
 * aligns with OpenShell `SecretResolver::resolve_placeholder` returning `None` on
 * `expires_at_ms <= now_ms()` (secrets.rs:222-228); R4 is the governance-side first line, OpenShell
 * the last.
 *
 * This module is vendor-neutral and audit-blind: it produces an auditable `LeaseEvent` (shape aligned
 * with `substrate/port.ts` `deny()/ok()`), but the caller — not this module — appends it to the WORM
 * kernel. The event payload is reference-only: `bundleRef` + states, NEVER a secret value.
 */
import { z } from "zod";
import { CredentialLease, type LeaseState } from "./lease.js";

/** A lease transition verb. `mint` has no `fromState` (the lease does not yet exist). */
export const LeaseTransitionKind = z.enum(["mint", "inject", "use", "revoke", "expire"]);
export type LeaseTransitionKind = z.infer<typeof LeaseTransitionKind>;

/**
 * Auditable, reference-only lease event. NO secret field, NO key VALUES — only the bundleRef and the
 * state delta, so `redactSecrets(event)` is a no-op by construction.
 */
export const LeaseEvent = z.object({
  transition: LeaseTransitionKind,
  /** Absent for `mint` (the lease had no prior state). */
  fromState: z.string().optional(),
  /** The resulting state on `ok`; absent on a denied transition that produced no new state. */
  toState: z.string().optional(),
  result: z.enum(["ok", "denied"]),
  /** Present when the input was a well-formed lease/spec; otherwise omitted (malformed input). */
  bundleRef: z.string().optional(),
  reason: z.string().optional(),
});
export type LeaseEvent = z.infer<typeof LeaseEvent>;

export type LeaseTransition =
  | { status: "ok"; lease: CredentialLease; event: LeaseEvent }
  | { status: "denied"; reason: string; event: LeaseEvent };

/** The spec accepted by `mint`: a lease shape WITHOUT `state` (the FSM stamps `issued`). */
export const LeaseSpec = CredentialLease.omit({ state: true });
export type LeaseSpec = z.infer<typeof LeaseSpec>;

type Clock = () => number;

/** Terminal states admit no further transition. */
const TERMINAL: ReadonlySet<LeaseState> = new Set<LeaseState>(["revoked", "expired"]);

/** Best-effort bundleRef extraction for the audit event, even on malformed input (never throws). */
function bundleRefOf(input: unknown): string | undefined {
  if (input !== null && typeof input === "object" && "bundleRef" in input) {
    const ref = (input as { bundleRef: unknown }).bundleRef;
    return typeof ref === "string" ? ref : undefined;
  }
  return undefined;
}

function denied(
  transition: LeaseTransitionKind,
  reason: string,
  fromState: LeaseState | undefined,
  bundleRef: string | undefined,
): LeaseTransition {
  return {
    status: "denied",
    reason,
    event: { transition, result: "denied", reason, fromState, bundleRef },
  };
}

function okTransition(
  transition: LeaseTransitionKind,
  lease: CredentialLease,
  fromState: LeaseState | undefined,
): LeaseTransition {
  return {
    status: "ok",
    lease,
    event: {
      transition,
      result: "ok",
      fromState,
      toState: lease.state,
      bundleRef: lease.bundleRef,
    },
  };
}

/** Parse-or-deny: validate the input is a real CredentialLease; on any error, return `undefined`. */
function asLease(input: unknown): CredentialLease | undefined {
  const parsed = CredentialLease.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

/** mint(spec, now?): validate the spec and stamp it `issued`. Malformed spec -> denied. */
export function mint(input: unknown, _now: Clock = Date.now): LeaseTransition {
  const parsed = LeaseSpec.safeParse(input);
  if (!parsed.success) {
    return denied("mint", "malformed lease spec", undefined, bundleRefOf(input));
  }
  // The FSM owns the initial state; the caller cannot dictate it.
  const lease = CredentialLease.parse({ ...parsed.data, state: "issued" });
  return okTransition("mint", lease, undefined);
}

/** inject(lease): issued -> injected. Terminal/non-issued/malformed -> denied. */
export function inject(input: unknown): LeaseTransition {
  const lease = asLease(input);
  if (!lease) return denied("inject", "malformed lease", undefined, bundleRefOf(input));
  if (TERMINAL.has(lease.state)) {
    return denied(
      "inject",
      `illegal transition: ${lease.state} is terminal`,
      lease.state,
      lease.bundleRef,
    );
  }
  if (lease.state !== "issued") {
    return denied(
      "inject",
      `illegal transition: inject from ${lease.state}`,
      lease.state,
      lease.bundleRef,
    );
  }
  return okTransition("inject", { ...lease, state: "injected" }, "issued");
}

/**
 * use(lease, now?): injected -> used, but ONLY if not expired. Expiry is checked here independently
 * of state (the expiry-window invariant): `expiresAtMs <= now` -> denied even when state is injected.
 */
export function use(input: unknown, now: Clock = Date.now): LeaseTransition {
  const lease = asLease(input);
  if (!lease) return denied("use", "malformed lease", undefined, bundleRefOf(input));
  if (TERMINAL.has(lease.state)) {
    return denied(
      "use",
      `illegal transition: ${lease.state} is terminal`,
      lease.state,
      lease.bundleRef,
    );
  }
  if (lease.state !== "injected") {
    return denied(
      "use",
      `illegal transition: use from ${lease.state}`,
      lease.state,
      lease.bundleRef,
    );
  }
  if (lease.expiresAtMs <= now()) {
    return denied("use", "lease is expired (fail-closed)", lease.state, lease.bundleRef);
  }
  return okTransition("use", { ...lease, state: "used" }, "injected");
}

/** revoke(lease): any non-terminal state -> revoked. Already-terminal/malformed -> denied. */
export function revoke(input: unknown): LeaseTransition {
  const lease = asLease(input);
  if (!lease) return denied("revoke", "malformed lease", undefined, bundleRefOf(input));
  if (TERMINAL.has(lease.state)) {
    return denied(
      "revoke",
      `illegal transition: ${lease.state} is terminal`,
      lease.state,
      lease.bundleRef,
    );
  }
  return okTransition("revoke", { ...lease, state: "revoked" }, lease.state);
}

/** expire(lease, now?): non-terminal lease with `expiresAtMs <= now` -> expired. Otherwise denied. */
export function expire(input: unknown, now: Clock = Date.now): LeaseTransition {
  const lease = asLease(input);
  if (!lease) return denied("expire", "malformed lease", undefined, bundleRefOf(input));
  if (TERMINAL.has(lease.state)) {
    return denied(
      "expire",
      `illegal transition: ${lease.state} is terminal`,
      lease.state,
      lease.bundleRef,
    );
  }
  if (lease.expiresAtMs > now()) {
    return denied("expire", "lease is not yet expired", lease.state, lease.bundleRef);
  }
  return okTransition("expire", { ...lease, state: "expired" }, lease.state);
}
