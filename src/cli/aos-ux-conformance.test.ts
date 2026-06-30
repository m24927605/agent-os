/**
 * AOS-UX — Agent OS Fail-Closed UX Conformance Standard (v1), AUTOMATABLE SUBSET = the living regression guard.
 *
 * Produced by a Staff+ UX panel (UX-Researcher / DevAdvocate / PM / SRE). The standard has 7 dimensions; the
 * panel marked which metrics are capturable from the CLI/artifacts NOW (no infra, no human, no secret) vs which
 * need a moderated usability test or a live deploy. THIS spec asserts the automatable-now invariants as ONE
 * named guard so a UX regression fails `pnpm run verify` — turning the standard into a gate, not an opinion.
 *
 * Dimensions & where guarded:
 *   D1 Effectiveness/Activation — scaffold-valid ×3 profiles + CFHO onboarding sequence (here).
 *   D2 Efficiency — per-command latency / no-hang: a `time -p` harness (deferred to a perf job, not a unit gate).
 *   D3 Failure-Clarity/Recovery — config-error legibility + error-actionability fault matrix (here);
 *       doctor field-aware hints also in doctor.test.ts; drift recovery in config.test.ts.
 *   D4 Fail-Closed Honesty — no-fake-green (here); drift-gate in config.test.ts; verifier relay in main.test.ts.
 *   D5 Learnability/Discoverability — help coverage (here); schema self-doc in config-json-schema.test.ts;
 *       explain-map completeness in setup.test.ts.
 *   D6 Credential-Blind Trust — secret-shaped value never echoed (here); doctor --secrets in doctor.test.ts.
 *   D7 Persona-Fit — minimal-surface-per-persona (here).
 *
 * DEFERRED (NOT asserted here — no data without a moderated test / live stack; never inferred from this guard):
 *   per-persona SUS/SEQ/trust ratings; two-plane-secrets retention; the Personal zero-skill PACKAGED app
 *   (does not exist yet); doctor-GREEN + the live governed action + MTTR (need Hermes+OpenShell+kernel up).
 */
import { describe, expect, it, vi } from "vitest";
import { type ConfigDeps, configCommand } from "./config.js";
import { type DoctorProbes, doctorCommand } from "./doctor.js";
import { runCli } from "./main.js";
import {
  type SetupDeps,
  buildScaffoldConfig,
  buildScaffoldJsonc,
  loadAgentOsConfig,
  setupCommand,
} from "./setup.js";

/** An in-memory FS + print buffer shared by the setup & config deps, so the onboarding sequence runs I/O-free. */
function harness() {
  const store = new Map<string, string>();
  const printed: string[] = [];
  const setupDeps: SetupDeps = {
    readConfigFile: (p) => store.get(p),
    writeConfigFile: (p, c) => {
      store.set(p, c);
    },
    prompt: async () => "",
    runHermesMcpAdd: () => ({ ok: true }),
    doctor: async () => 0,
    print: (l) => {
      printed.push(l);
    },
    isInteractiveTty: () => false, // headless → the print path (never a real `hermes mcp add`)
  };
  const configDeps: ConfigDeps = {
    readFile: (p) => store.get(p),
    writeFile: (p, c) => {
      store.set(p, c);
    },
    print: (l) => {
      printed.push(l);
    },
  };
  return { store, printed, setupDeps, configDeps };
}

const okProbes = (): DoctorProbes => ({
  commandExists: () => true,
  fileExists: () => true,
  tcpReachable: async () => true,
  hermesMcpList: () => "Registered MCP servers:\n  agentos-exec  (stdio)\n",
});

/** A fix-pointer: a dotted config field, a `backtick command`, or a --flag. Every FAIL/error line must have one. */
const NAMES_A_FIX = /`[^`]+`|--[a-z]|[a-z]+\.[a-z]/;

describe("AOS-UX conformance (automatable subset) — fails `verify` on a UX regression", () => {
  it("D4 no-fake-green: doctor exits 0 IFF all required PASS; a required dependency down => non-zero", async () => {
    expect(await doctorCommand([], {}, okProbes())).toBe(0);
    const kernelDown: DoctorProbes = {
      ...okProbes(),
      tcpReachable: async (_h, port) => port !== 50051,
    };
    expect(await doctorCommand([], {}, kernelDown)).not.toBe(0); // honest: never a silent 0 with a dep down
  });

  it("D3 config-error LEGIBILITY: a rejected config is prose that NAMES the field + the next command — not a raw zod dump", () => {
    let msg = "";
    try {
      loadAgentOsConfig(
        '{ "openshell": { "endpoint": 1, "mtlsDir": "/m", "image": "i" }, "kernel": { "ingestEndpoint": "x" } }',
      );
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toContain("is invalid:");
    expect(msg).toMatch(/openshell\.endpoint/); // names the offending field in prose
    expect(msg).toContain("agentos config schema"); // points at the next action
    expect(msg).not.toContain('"code":'); // NOT the raw zod issue-array dump
  });

  it("D3 error-actionability: every FAIL/error line across the fault matrix names a fix", async () => {
    const lines: string[] = [];
    const exists = harness();
    exists.store.set("./agent-os.config.json", "{}");
    await setupCommand(["--init"], {}, exists.setupDeps); // init-over-existing
    const badAction = harness();
    await configCommand(["bogus"], {}, badAction.configDeps); // unknown action
    const noConfig = harness();
    await configCommand(["render"], {}, noConfig.configDeps); // missing config
    lines.push(...exists.printed, ...badAction.printed, ...noConfig.printed);
    const errs = lines.filter((l) => /error|FAIL/i.test(l));
    expect(errs.length).toBeGreaterThan(0);
    for (const l of errs) expect(l).toMatch(NAMES_A_FIX);
    expect(exists.printed.join("\n")).toContain("--force"); // the escape hatch is named
  });

  it("D1 scaffold-valid: `--init` JSONC scaffold re-parses for every profile (zero-edit validity)", () => {
    for (const p of ["personal", "enterprise", "developer"] as const) {
      expect(() => loadAgentOsConfig(buildScaffoldJsonc(p))).not.toThrow();
    }
  });

  it("D1 CFHO: the onboarding sequence (init → config render → config check) is 3 commands to IN-SYNC", async () => {
    const h = harness();
    expect(await setupCommand(["--init"], {}, h.setupDeps)).toBe(0); // 1
    expect(await configCommand(["render"], {}, h.configDeps)).toBe(0); // 2
    expect(await configCommand(["check"], {}, h.configDeps)).toBe(0); // 3 → IN-SYNC, no manual step
  });

  it("D6 credential-blind: a secret-shaped value never reaches output — `config render` fails closed, value-free", async () => {
    const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join(""); // an AWS-key shape, assembled at runtime
    const h = harness();
    h.store.set(
      "./agent-os.config.json",
      JSON.stringify({
        openshell: { endpoint: "127.0.0.1:17670", mtlsDir: "/m", image: secret },
        kernel: { ingestEndpoint: "127.0.0.1:50051" },
      }),
    );
    expect(await configCommand(["render"], {}, h.configDeps)).not.toBe(0); // screened, fail-closed
    expect(h.printed.join("\n")).not.toContain(secret); // and value-free
  });

  it("D7 persona-fit: each profile scaffolds exactly its minimal section set", () => {
    expect(buildScaffoldConfig("personal").spendguard).toBeUndefined();
    expect(buildScaffoldConfig("personal").agt).toBeUndefined();
    expect(buildScaffoldConfig("enterprise").spendguard).toBeDefined();
    expect(buildScaffoldConfig("developer").agt).toBeDefined();
  });

  it("D5 discoverability: `--help` exits 0 and lists the onboarding commands (no error-only discovery)", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });
    expect(await runCli(["--help"])).toBe(0);
    spy.mockRestore();
    const text = out.join("");
    for (const cmd of [
      "setup --init",
      "doctor",
      "config render",
      "config check",
      "manifest",
      "verify",
    ]) {
      expect(text).toContain(cmd);
    }
  });
});
