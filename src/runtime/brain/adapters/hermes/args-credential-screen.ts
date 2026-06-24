/**
 * SLICE-EXEC3b — the REAL inbound credential screen for the exec closed loop (finding ② fix).
 *
 * The pipeline's `deps.screen` is the FIRST gate (`screen -> authorize -> cost -> commit -> effect`). In
 * EXEC3a's tests it was a permissive stub (`() => ({ ok: true })`); EXEC3b wires the PRODUCTION screen:
 * an UNTRUSTED brain that smuggles a literal secret in a DECLARED exec arg (e.g. `{ text: "sk-…" }`) is
 * DENIED at the screen stage, fail-closed, BEFORE authorize/cost/commit/effect — so a raw secret never
 * reaches policy, the audit log, or the substrate.
 *
 * This complements `makeExecEffect`'s credential-blind ENV guard (which screens the composer-built env
 * just before exec): the env guard catches a secret the COMPOSER would inject; this screen catches a
 * secret the BRAIN proposes in its args. Together they keep both inbound directions credential-blind.
 *
 * Fail-closed at every gate:
 *   - a detector that returns true for any arg VALUE  => { ok:false } (the brain emitted a literal secret);
 *   - a detector that THROWS                          => { ok:false } (deny-by-default — never let an arg
 *                                                        through because the check itself failed).
 * The default detector is the repo's production `redactSecrets`-changed test (same construction as every
 * bootstrap), so the screen is credential-blind by default with no extra wiring.
 *
 * HONEST limit (restated from the brain credential guard): detection is only as strong as the injected
 * detector — `redactSecrets` catches high-signal secret SHAPES + secret-named keys, NOT low-signal
 * secrets (e.g. a password inside a DSN). It is not an entropy/exhaustive scanner. The REAL credential
 * boundary is a sandbox provisioned with ZERO real credentials + NO egress, not this best-effort screen.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone alongside `exec-closed-loop.ts` (it builds
 * THAT composition's `deps.screen`); imports ONLY the neutral `orchestration` (ScreenOutcome) + `substrate`
 * (ExecSecretDetector + the production default) public barrels. Re-exported via the hermes barrel.
 */
import type { ScreenOutcome } from "../../../../orchestration/index.js";
import { type ExecSecretDetector, defaultExecSecretDetector } from "../../../substrate/index.js";

/** The minimal shape the screen inspects — a brain proposal carrying DECLARED args (NOT argv). */
interface ScreenableCall {
  readonly context: unknown;
  readonly args?: Record<string, unknown>;
}

const SECRET_ARG_REASON = "credential-blind: secret-shaped exec arg";

/**
 * Build the pipeline `deps.screen` that DENIES a brain proposal carrying a secret-shaped DECLARED arg.
 *
 * The detector runs over each arg VALUE (not the keys): a flagged value DENIES with a stable reason; a
 * detector that throws DENIES fail-closed (no reason needed — the structural `{ ok:false }` is the deny).
 * An absent/empty `args`, or args whose every value is a placeholder/bundleRef, screens OK.
 *
 * @param detectSecret optional detector; defaults to the production `redactSecrets`-changed test.
 */
export function makeArgsCredentialScreen(
  detectSecret: ExecSecretDetector = defaultExecSecretDetector,
): (toolCall: ScreenableCall) => ScreenOutcome {
  return (toolCall: ScreenableCall): ScreenOutcome => {
    const args = toolCall.args;
    if (args === undefined) return { ok: true };
    for (const value of Object.values(args)) {
      let flagged: boolean;
      try {
        flagged = detectSecret(value);
      } catch {
        // Fail-closed: a detector that throws denies (never let an arg through on a failed check). The
        // structural `{ ok:false }` IS the deny — no reason string is required by ScreenOutcome here.
        return { ok: false, reason: SECRET_ARG_REASON };
      }
      if (flagged) return { ok: false, reason: SECRET_ARG_REASON };
    }
    return { ok: true };
  };
}
