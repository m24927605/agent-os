/**
 * SLICE-PERSONAL0 — the humane-recovery CI invariant: every fail-able `doctor` check maps to ONE plain-language
 * recovery card with a HUMAN action (no terminal / config field), enumerated from the real `doctor --json` so the
 * cards can never drift behind the actual checks. Also pins `doctor --json`: structured, `ok` mirrors the exit
 * code (no fake green), credential-blind.
 */
import { describe, expect, it, vi } from "vitest";
import { type DoctorProbes, doctorCommand } from "./doctor.js";
import {
  NAMES_A_HUMAN_FIX,
  knownRecoveryCheckNames,
  recoveryCardFor,
} from "./personal-recovery-cards.js";

function captureStdout(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  });
  return { out, restore: () => spy.mockRestore() };
}

const failProbes: DoctorProbes = {
  commandExists: () => false,
  fileExists: () => false,
  tcpReachable: async () => false,
  hermesMcpList: () => undefined,
};
const okProbes: DoctorProbes = {
  commandExists: () => true,
  fileExists: () => true,
  tcpReachable: async () => true,
  hermesMcpList: () => "Registered MCP servers:\n  agentos-exec  (stdio)\n",
};

interface JsonReport {
  ok: boolean;
  checks: { name: string; status: string; hint: string; required: boolean }[];
}

describe("Personal recovery cards — humane recovery is a CI invariant", () => {
  it("doctor --json emits a structured check list; `ok` mirrors the exit code (no fake green), names/hints only", async () => {
    const { out, restore } = captureStdout();
    const code = await doctorCommand(["--json"], {}, okProbes);
    restore();
    const parsed = JSON.parse(out.join("")) as JsonReport;
    expect(parsed.ok).toBe(true);
    expect(code).toBe(0);
    expect(parsed.checks.length).toBeGreaterThan(0);
    expect(parsed.checks[0]).toHaveProperty("name"); // structured, not scraped text
  });

  it("EVERY fail-able doctor check has a HUMAN recovery card (coverage gate, enumerated from doctor --json)", async () => {
    const { out, restore } = captureStdout();
    // SPENDGUARD/AGT set so their CONDITIONAL checks run + FAIL (not SKIP) → every preflight check surfaces.
    await doctorCommand(["--json"], { SPENDGUARD_UDS_PATH: "/x", AGT_UDS_PATH: "/y" }, failProbes);
    restore();
    const parsed = JSON.parse(out.join("")) as JsonReport;
    expect(parsed.ok).toBe(false); // all-failing probes ⇒ not ready (fail-closed)
    const preflight = parsed.checks.filter((c) => !c.name.startsWith("secret:"));
    expect(preflight.length).toBeGreaterThanOrEqual(7);
    for (const c of preflight) {
      const card = recoveryCardFor(c.name);
      expect(card, `no recovery card for doctor check '${c.name}'`).toBeDefined();
      if (card !== undefined) expect(NAMES_A_HUMAN_FIX(card.action)).toBe(true); // a human imperative, not a CLI fix
    }
  });

  it("every card's action is a HUMAN fix (no config field / backtick / --flag)", () => {
    for (const name of knownRecoveryCheckNames()) {
      const card = recoveryCardFor(name);
      expect(card).toBeDefined();
      if (card !== undefined) expect(NAMES_A_HUMAN_FIX(card.action)).toBe(true);
    }
    // NAMES_A_HUMAN_FIX is non-vacuous: a CLI-style action (backtick / --flag / dotted field) is rejected.
    expect(NAMES_A_HUMAN_FIX("run `agentos setup`")).toBe(false);
    expect(NAMES_A_HUMAN_FIX("set kernel.ingestEndpoint")).toBe(false);
    expect(NAMES_A_HUMAN_FIX("Restart engine")).toBe(true);
  });
});
