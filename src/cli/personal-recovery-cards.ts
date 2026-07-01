/**
 * SLICE-PERSONAL0 — the Personal orchestrator's doctor → HUMAN recovery-card mapping. A zero-skill user never
 * sees a doctor FAIL line or a stack trace: the tray shows ONE plain-language card per failing check with exactly
 * ONE action button. This is the pure table + a conformance gate (`personal-recovery-cards.test.ts`) asserting
 * EVERY doctor check has a card whose action is a HUMAN imperative (no config field / backtick command / --flag) —
 * so "humane recovery" is a CI invariant, not a hope. Non-technical + credential-blind (fixed labels, no values).
 *
 * The tray health chip is a PURE function of `doctor --json`'s `ok`: green ⇔ ok (exit 0), red = a failing card,
 * amber = still starting — never a fake green.
 */

/** One recovery card: which doctor check it covers, a plain-language title, and the single button label. */
export interface RecoveryCard {
  readonly checkName: string;
  readonly title: string;
  readonly action: string;
}

/** checkName (from `doctor`) → the non-technical card. Every fail-able doctor check MUST appear here (gate-enforced). */
const CARDS: Record<string, { title: string; action: string }> = {
  "Hermes on PATH": {
    title: "Your assistant isn't installed yet",
    action: "Install the assistant",
  },
  "bin built": {
    title: "Agent OS isn't fully installed",
    action: "Reinstall Agent OS",
  },
  registered: {
    title: "Your assistant isn't connected to Agent OS",
    action: "Reconnect",
  },
  "OpenShell reachable": {
    title: "The secure worker isn't running",
    action: "Restart engine",
  },
  "kernel reachable": {
    title: "Agent OS can't reach its secure recorder",
    action: "Restart engine",
  },
  "SpendGuard sidecar": {
    title: "The spending guard isn't reachable",
    action: "Restart engine",
  },
  "AGT advisory": {
    title: "The policy advisor isn't reachable",
    action: "Restart engine",
  },
};

/** The card for a failing doctor check, or undefined if the check has no mapped card. */
export function recoveryCardFor(checkName: string): RecoveryCard | undefined {
  const c = CARDS[checkName];
  return c === undefined ? undefined : { checkName, ...c };
}

/** The doctor check names that have a recovery card (the conformance gate asserts this covers every fail-able check). */
export function knownRecoveryCheckNames(): string[] {
  return Object.keys(CARDS);
}

/**
 * A HUMAN fix: a short imperative a non-technical user can act on — NOT a config field, a `backtick command`, or a
 * --flag (the inverse of the CLI `NAMES_A_FIX`). The conformance gate asserts every card's action matches this.
 */
export const NAMES_A_HUMAN_FIX = (action: string): boolean =>
  action.trim().length > 0 &&
  !action.includes("`") &&
  !action.includes("--") &&
  !/[a-z]+\.[a-z]/.test(action);
