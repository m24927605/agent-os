/**
 * SLICE-PERSONAL0 — the onboarding state machine's invariants: FAIL-CLOSED at every step, NO fake-green ("ready"
 * only when doctor is ok), Hermes launched ONLY when ready, recovery cards on failure, credential-blind result.
 */
import { describe, expect, it } from "vitest";
import {
  type DoctorReport,
  type OrchestratorSeams,
  onboard,
  trayHealthFrom,
} from "./personal-orchestrator.js";

function makeSeams(overrides: Partial<OrchestratorSeams> & { report?: DoctorReport } = {}): {
  seams: OrchestratorSeams;
  calls: string[];
} {
  const calls: string[] = [];
  const report: DoctorReport = overrides.report ?? {
    ok: true,
    checks: [{ name: "kernel reachable", status: "PASS" }],
  };
  const seams: OrchestratorSeams = {
    ensureSessionKey:
      overrides.ensureSessionKey ??
      (async () => {
        calls.push("ensureSessionKey");
      }),
    composeUp:
      overrides.composeUp ??
      (async () => {
        calls.push("composeUp");
      }),
    runSetup:
      overrides.runSetup ??
      (async () => {
        calls.push("runSetup");
      }),
    checkHealth:
      overrides.checkHealth ??
      (async () => {
        calls.push("checkHealth");
        return report;
      }),
    launchHermes:
      overrides.launchHermes ??
      (async () => {
        calls.push("launchHermes");
      }),
  };
  return { seams, calls };
}

describe("personal-orchestrator onboarding — fail-closed, no fake-green, credential-blind", () => {
  it("HAPPY: all seams ok + doctor ok => ready, green, Hermes launched (in order)", async () => {
    const { seams, calls } = makeSeams();
    const r = await onboard(seams);
    expect(r.ready).toBe(true);
    expect(r.trayHealth).toBe("green");
    expect(r.state).toBe("ready");
    expect(calls).toEqual([
      "ensureSessionKey",
      "composeUp",
      "runSetup",
      "checkHealth",
      "launchHermes",
    ]);
  });

  it("NO FAKE GREEN: doctor not-ok => NOT ready, red, recovery cards for the FAILs, Hermes NEVER launched", async () => {
    const report: DoctorReport = {
      ok: false,
      checks: [
        { name: "kernel reachable", status: "FAIL" },
        { name: "registered", status: "FAIL" },
        { name: "OpenShell reachable", status: "PASS" },
      ],
    };
    const { seams, calls } = makeSeams({ report });
    const r = await onboard(seams);
    expect(r.ready).toBe(false);
    expect(r.trayHealth).toBe("red");
    expect(r.state).toBe("needs-attention");
    expect(r.cards.map((c) => c.checkName)).toEqual(["kernel reachable", "registered"]); // cards for FAILs only
    expect(r.cards.every((c) => c.action.length > 0)).toBe(true);
    expect(calls).not.toContain("launchHermes"); // NEVER launch when not ready
  });

  it("FAIL-CLOSED: a locked keychain (ensureSessionKey throws) => red 'securely', NOTHING else started", async () => {
    const { seams, calls } = makeSeams({
      ensureSessionKey: async () => {
        throw new Error("keychain locked");
      },
    });
    const r = await onboard(seams);
    expect(r.ready).toBe(false);
    expect(r.trayHealth).toBe("red");
    expect(r.state).toBe("securing");
    expect(r.message).toMatch(/securely/i);
    expect(calls).toEqual([]); // fail-closed BEFORE the stack starts (no plaintext fallback)
  });

  it("FAIL-CLOSED: compose up throws => not ready, setup NOT run", async () => {
    const { seams, calls } = makeSeams({
      composeUp: async () => {
        throw new Error("no runtime");
      },
    });
    const r = await onboard(seams);
    expect(r.ready).toBe(false);
    expect(r.state).toBe("starting");
    expect(calls).not.toContain("runSetup");
  });

  it("trayHealthFrom is pure: undefined=amber, ok=green, not-ok=red (never a fake green)", () => {
    expect(trayHealthFrom(undefined)).toBe("amber");
    expect(trayHealthFrom({ ok: true, checks: [] })).toBe("green");
    expect(trayHealthFrom({ ok: false, checks: [] })).toBe("red");
  });

  it("CREDENTIAL-BLIND: the result carries no secret-shaped value (the session key stays inside the seam)", async () => {
    const { seams } = makeSeams();
    const r = await onboard(seams);
    expect(JSON.stringify(r)).not.toMatch(/sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}/); // result is non-secret by shape
  });
});
