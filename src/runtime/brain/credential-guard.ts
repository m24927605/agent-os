/**
 * Credential-blind enforcement at the brain boundary.
 *
 * The brain is untrusted and MUST stay credential-blind: it may reference a credential by bundleRef
 * but must NEVER emit a literal secret (a real secret only ever materializes at the OpenShell
 * SecretResolver egress). This guard screens every event the brain proposes and DENIES — fail-closed,
 * before any effect — any event whose payload contains a secret-shaped value.
 *
 * The secret detector is INJECTED (not imported) so this module stays decoupled from the audit
 * layer; the composition root wires the repo's real detector (audit/redact `redactSecrets`).
 */
import type { BrainEvent } from "./port.js";

/** Returns true if `value` (recursively) contains a secret-shaped value or secret-keyed field. */
export type SecretDetector = (value: unknown) => boolean;

export type ScreenResult =
  | { status: "ok"; event: BrainEvent }
  | { status: "denied"; reason: string; event: BrainEvent };

const DENY_REASON =
  "brain emitted a literal secret (credential-blind violation) — reference credentials by bundleRef only";
const DETECTOR_ERROR_REASON = "credential detector errored — deny-by-default (fail-closed)";

/**
 * Screen a single brain event. Fail-closed: a secret anywhere in the payload is denied, AND a detector
 * that throws is ALSO denied (deny-by-default on error — never let an event through because the check
 * itself failed). NOTE: detection is only as strong as the injected detector; the repo's `redactSecrets`
 * catches high-signal secret SHAPES + secret-named keys, NOT low-signal secrets (e.g. a password inside
 * a DSN) — it is not an entropy/exhaustive scanner.
 */
export function screenBrainEvent(event: BrainEvent, detectSecret: SecretDetector): ScreenResult {
  let hasSecret: boolean;
  try {
    hasSecret = detectSecret(event);
  } catch {
    return { status: "denied", reason: DETECTOR_ERROR_REASON, event };
  }
  return hasSecret ? { status: "denied", reason: DENY_REASON, event } : { status: "ok", event };
}

/**
 * Govern a brain's event stream: yield each event's screen result. On the FIRST credential-blind
 * violation it yields the `denied` result and STOPS the stream (fail-closed — a brain that tried to
 * exfiltrate a secret is not trusted to keep proposing). A secret-bearing event is therefore never
 * yielded as `ok`, so the downstream effect for it is unreachable.
 */
export async function* governBrainStream(
  events: AsyncIterable<BrainEvent>,
  detectSecret: SecretDetector,
): AsyncIterable<ScreenResult> {
  for await (const event of events) {
    const screened = screenBrainEvent(event, detectSecret);
    yield screened;
    if (screened.status === "denied") return;
  }
}
