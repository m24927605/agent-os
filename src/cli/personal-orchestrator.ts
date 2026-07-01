/**
 * SLICE-PERSONAL0 — the zero-skill Personal onboarding STATE MACHINE (headless; the Tauri "Agent OS Engine" shell
 * is a thin wrapper over this). It COMPOSES the already-shipped agentos CLI (setup/doctor) via injected seams —
 * NO new engine, NO governance change; it only starts/stops the stack + points the brain. See
 * docs/slices/personal-packaged-app/DESIGN.md.
 *
 * INVARIANTS (test-enforced): FAIL-CLOSED at every step; "ready" is returned ONLY when `doctor` reports ok — a
 * fake green is impossible (the tray health is a PURE function of the doctor report). CREDENTIAL-BLIND: the local
 * session key is generated + kept inside `ensureSessionKey`; its value NEVER enters this result/message/log.
 * On any FAIL the user gets plain-language recovery CARDS (a single human action each), never a stack trace.
 */
import { type RecoveryCard, recoveryCardFor } from "./personal-recovery-cards.js";

export type TrayHealth = "green" | "amber" | "red";
export type OrchestratorState =
  | "securing"
  | "starting"
  | "wiring"
  | "verifying"
  | "ready"
  | "needs-attention";

/** The structured `agentos doctor --json` report the orchestrator consumes (names/statuses only — no secret value). */
export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: { readonly name: string; readonly status: "PASS" | "FAIL" | "SKIP" }[];
}

/**
 * Injected I/O seams — real = docker compose / crypto+keychain / the agentos CLI / Hermes; tests inject fakes.
 * Every method fails closed (throws) on error; the state machine catches and returns a human message.
 */
export interface OrchestratorSeams {
  /** CSPRNG-generate SHELL_SESSION_KEY into the OS keychain. The value NEVER leaves this seam. Throws => can't start securely. */
  ensureSessionKey(): Promise<void>;
  /** Bring the 127.0.0.1-pinned kernel+substrate stack up (compose up -d + await healthchecks). Throws on failure. */
  composeUp(): Promise<void>;
  /** Run `agentos setup` internally (compile the non-secret config + register the governed MCP). Throws on failure. */
  runSetup(): Promise<void>;
  /** Run `agentos doctor --json` and return the structured report. */
  checkHealth(): Promise<DoctorReport>;
  /** Launch + point Hermes Desktop — ONLY ever called once health is ok (the readiness gate passed). */
  launchHermes(): Promise<void>;
}

/** The one plain-language status the tray renders. NEVER carries a secret value. */
export interface OnboardResult {
  readonly ready: boolean;
  readonly trayHealth: TrayHealth;
  readonly state: OrchestratorState;
  readonly message: string;
  readonly cards: RecoveryCard[];
}

/** Tray health is a PURE function of the doctor report: unknown => amber; ok => green; else red. No fake green. */
export function trayHealthFrom(report: DoctorReport | undefined): TrayHealth {
  if (report === undefined) return "amber";
  return report.ok ? "green" : "red";
}

/** Recovery cards for the FAILing checks in a report (in report order; checks without a card are skipped). */
function cardsFor(report: DoctorReport): RecoveryCard[] {
  const cards: RecoveryCard[] = [];
  for (const c of report.checks) {
    if (c.status !== "FAIL") continue;
    const card = recoveryCardFor(c.name);
    if (card !== undefined) cards.push(card);
  }
  return cards;
}

/**
 * The zero-skill onboarding sequence: secure the session key -> start the stack -> `agentos setup` -> verify with
 * `doctor` -> launch Hermes. Fail-closed at each step; "ready" ONLY when doctor is ok. Returns one plain-language
 * status (+ recovery cards on failure). Credential-blind: the session key never enters the result.
 */
export async function onboard(seams: OrchestratorSeams): Promise<OnboardResult> {
  const fail = (state: OrchestratorState, message: string): OnboardResult => ({
    ready: false,
    trayHealth: "red",
    state,
    message,
    cards: [],
  });

  // 1. Secure the local session key FIRST — a locked/headless keychain fails closed (never a plaintext fallback).
  try {
    await seams.ensureSessionKey();
  } catch {
    return fail(
      "securing",
      "Agent OS can't start securely — your device's keychain is locked or unavailable.",
    );
  }
  // 2. Bring the stack up.
  try {
    await seams.composeUp();
  } catch {
    return fail("starting", "Agent OS couldn't start its engine.");
  }
  // 3. Compile + register (agentos setup, internally).
  try {
    await seams.runSetup();
  } catch {
    return fail("wiring", "Agent OS couldn't finish connecting your assistant.");
  }
  // 4. Verify — the readiness gate. NEVER "ready" unless doctor is ok.
  let report: DoctorReport;
  try {
    report = await seams.checkHealth();
  } catch {
    return fail("verifying", "Agent OS couldn't check whether everything is running.");
  }
  if (!report.ok) {
    return {
      ready: false,
      trayHealth: "red",
      state: "needs-attention",
      message: "A few things need your attention before your assistant can start.",
      cards: cardsFor(report),
    };
  }
  // 5. Ready — launch + point Hermes (the sole surface).
  await seams.launchHermes();
  return {
    ready: true,
    trayHealth: "green",
    state: "ready",
    message: "Your assistant is ready.",
    cards: [],
  };
}
