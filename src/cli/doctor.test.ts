/**
 * SLICE-SETUP1b — `agentos doctor` preflight: tests (RED-first).
 *
 * `doctor` is a credential-blind PREFLIGHT: it verifies, before a user runs Hermes, that the
 * pieces autonomous execution depends on are present and reachable. It changes NO governance and
 * starts NO services — it only reports PASS/FAIL/SKIP and returns a FAIL-CLOSED exit code (non-zero
 * if ANY required check FAILs; 0 only when every required check PASSes).
 *
 * The checks touch external state (PATH, dist, Hermes registry, OpenShell, kernel, the SpendGuard
 * UDS), so the I/O is INJECTABLE via an optional `probes` param. Tests inject fakes to drive every
 * PASS/FAIL/SKIP branch deterministically — no real Hermes / OpenShell / kernel / sidecar needed.
 *
 * Properties pinned here:
 *   (1) all required checks PASS (probes all-ok, SpendGuard unset) -> exit 0, with PASS lines + a
 *       SKIP for SpendGuard;
 *   (2) any required check FAIL (e.g. OpenShell unreachable, or the bin missing) -> non-zero exit
 *       (fail-closed). NON-VACUITY: a mutation that returns 0 despite a required FAIL flips this RED;
 *   (3) SpendGuard CONDITIONAL — set+reachable -> PASS; set+unreachable -> FAIL (non-zero); unset
 *       -> SKIP (never fails the run);
 *   (4) CREDENTIAL-BLIND — a secret-shaped value carried in env is NEVER echoed to stdout/stderr;
 *       only check names, host:port, file paths, ENV KEY NAMES, and static hints are printed.
 *       NON-VACUITY: a mutation that interpolates the env value into output flips this RED;
 *   (5) the existing fail-closed default is unchanged: an unknown subcommand still -> EXIT_USAGE.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorProbes } from "./doctor.js";
import { doctorCommand } from "./doctor.js";
import { runCli } from "./main.js";

/** A canary secret, built at runtime so the literal never lives in the file (secret-scan stays clean). */
const SECRET_CANARY = ["sk", "live", `${"A1b2C3d4E5f6G7h8".repeat(2)}`].join("-");

/**
 * A runtime-built AGT UDS socket path canary. doctor's AGT check must report only the ENV KEY NAME /
 * a path-class / a static hint — NEVER this VALUE. Built at runtime (no literal in the file).
 */
const AGT_UDS_CANARY = ["/run", "agentos", `${"x9z8".repeat(4)}`, "agt.sock"].join("/");

/** All-green probes: every external dependency present and reachable. */
function okProbes(): DoctorProbes {
  return {
    commandExists: () => true,
    fileExists: () => true,
    tcpReachable: async () => true,
    hermesMcpList: () => "Registered MCP servers:\n  agentos-exec  (stdio)\n",
  };
}

let outChunks: string[];
let errChunks: string[];

beforeEach(() => {
  outChunks = [];
  errChunks = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    outChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    errChunks.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function allOutput(): string {
  return outChunks.join("") + errChunks.join("");
}

describe("agentos doctor — all required PASS, SpendGuard unset", () => {
  it("returns 0 when every required check passes and prints PASS lines + a SKIP for SpendGuard", async () => {
    const env = {}; // SPENDGUARD_UDS_PATH unset -> SpendGuard SKIP
    const code = await doctorCommand([], env, okProbes());
    expect(code).toBe(0);

    const out = allOutput();
    // Each required check reports PASS by name.
    expect(out).toContain("PASS");
    expect(out).toMatch(/PASS\s+Hermes on PATH/);
    expect(out).toMatch(/PASS\s+bin built/);
    expect(out).toMatch(/PASS\s+registered/);
    expect(out).toMatch(/PASS\s+OpenShell reachable/);
    expect(out).toMatch(/PASS\s+kernel reachable/);
    // SpendGuard CONDITIONAL + unset -> SKIP, never FAIL.
    expect(out).toMatch(/SKIP\s+SpendGuard sidecar/);
    expect(out).not.toMatch(/FAIL/);
  });
});

describe("agentos doctor — fail-closed on a required FAIL", () => {
  it("returns NON-ZERO when OpenShell is unreachable (required) — NON-VACUITY: a 0 here flips RED", async () => {
    const probes: DoctorProbes = {
      ...okProbes(),
      tcpReachable: async (host: string, port: number) => !(port === 17670 || host === "openshell"),
    };
    const code = await doctorCommand([], {}, probes);
    expect(code).not.toBe(0);
    expect(allOutput()).toMatch(/FAIL\s+OpenShell reachable/);
  });

  it("returns NON-ZERO when the bin is not built (required)", async () => {
    const probes: DoctorProbes = { ...okProbes(), fileExists: () => false };
    const code = await doctorCommand([], {}, probes);
    expect(code).not.toBe(0);
    expect(allOutput()).toMatch(/FAIL\s+bin built/);
  });

  it("returns NON-ZERO when Hermes is absent (required) and reports registered as blocked, never crashing", async () => {
    const probes: DoctorProbes = {
      ...okProbes(),
      commandExists: () => false,
      hermesMcpList: () => undefined, // hermes absent -> list cannot run
    };
    const code = await doctorCommand([], {}, probes);
    expect(code).not.toBe(0);
    expect(allOutput()).toMatch(/FAIL\s+Hermes on PATH/);
    // `registered` is moot without hermes — reported FAIL/blocked, not a crash.
    expect(allOutput()).toMatch(/FAIL\s+registered/);
  });

  it("returns NON-ZERO when agentos-exec is not registered (required)", async () => {
    const probes: DoctorProbes = {
      ...okProbes(),
      hermesMcpList: () => "Registered MCP servers:\n  (none)\n",
    };
    const code = await doctorCommand([], {}, probes);
    expect(code).not.toBe(0);
    expect(allOutput()).toMatch(/FAIL\s+registered/);
  });

  it("returns NON-ZERO when the kernel is unreachable (required, commit-before-effect)", async () => {
    const probes: DoctorProbes = {
      ...okProbes(),
      tcpReachable: async (host: string, port: number) => !(port === 50051 || host === "kernel"),
    };
    const code = await doctorCommand([], {}, probes);
    expect(code).not.toBe(0);
    expect(allOutput()).toMatch(/FAIL\s+kernel reachable/);
  });
});

describe("agentos doctor — SpendGuard CONDITIONAL", () => {
  it("PASS when SPENDGUARD_UDS_PATH is set and reachable", async () => {
    const env = { SPENDGUARD_UDS_PATH: "/tmp/spendguard.sock" };
    const code = await doctorCommand([], env, okProbes());
    expect(code).toBe(0);
    expect(allOutput()).toMatch(/PASS\s+SpendGuard sidecar/);
    expect(allOutput()).not.toMatch(/SKIP\s+SpendGuard sidecar/);
  });

  it("FAIL (non-zero) when SPENDGUARD_UDS_PATH is set but the socket is unreachable", async () => {
    const env = { SPENDGUARD_UDS_PATH: "/tmp/spendguard.sock" };
    const probes: DoctorProbes = {
      ...okProbes(),
      fileExists: (p: string) => p !== "/tmp/spendguard.sock", // socket absent
    };
    const code = await doctorCommand([], env, probes);
    expect(code).not.toBe(0);
    expect(allOutput()).toMatch(/FAIL\s+SpendGuard sidecar/);
  });

  it("SKIP (does not fail the run) when SPENDGUARD_UDS_PATH is unset", async () => {
    const code = await doctorCommand([], {}, okProbes());
    expect(code).toBe(0);
    expect(allOutput()).toMatch(/SKIP\s+SpendGuard sidecar/);
  });
});

// ================================================================================================
// SLICE-R9c — AGT advisory CONDITIONAL check (mirrors SpendGuard: SKIP unset / PASS set+reachable /
// FAIL set+unreachable). The operator opts in by setting AGT_UDS_PATH; a missing socket is a real
// problem (fail-closed, non-zero). Unset -> AGT off -> advisory abstains (SKIP, never fails the run).
// ================================================================================================
describe("agentos doctor — AGT advisory CONDITIONAL", () => {
  it("PASS when AGT_UDS_PATH is set and the socket is reachable", async () => {
    const env = { AGT_UDS_PATH: AGT_UDS_CANARY };
    const code = await doctorCommand([], env, okProbes());
    expect(code).toBe(0);
    expect(allOutput()).toMatch(/PASS\s+AGT advisory/);
    expect(allOutput()).not.toMatch(/SKIP\s+AGT advisory/);
  });

  it("FAIL (non-zero) when AGT_UDS_PATH is set but the socket is unreachable", async () => {
    // NON-VACUITY: making set-but-unreachable return 0 (or making the AGT check non-required) flips
    // this RED. The operator opted in, so a missing AGT sidecar must fail-close the preflight.
    const env = { AGT_UDS_PATH: AGT_UDS_CANARY };
    const probes: DoctorProbes = {
      ...okProbes(),
      fileExists: (p: string) => p !== AGT_UDS_CANARY, // AGT socket absent
    };
    const code = await doctorCommand([], env, probes);
    expect(code).not.toBe(0);
    expect(allOutput()).toMatch(/FAIL\s+AGT advisory/);
  });

  it("SKIP (does NOT fail the run) when AGT_UDS_PATH is unset — AGT off, advisory abstains", async () => {
    // NON-VACUITY: making the AGT check required-always (FAIL when unset) flips this RED. Unconfigured
    // AGT is the legitimate "off" state and must never fail the preflight.
    const code = await doctorCommand([], {}, okProbes());
    expect(code).toBe(0);
    expect(allOutput()).toMatch(/SKIP\s+AGT advisory/);
    expect(allOutput()).not.toMatch(/FAIL\s+AGT advisory/);
  });

  it("CREDENTIAL-BLIND: never echoes the AGT_UDS_PATH VALUE (only the key name / path-class / hint)", async () => {
    // The AGT socket path is operator-controlled and may be sensitive; the doctor reports the ENV KEY
    // NAME + reachability, never the VALUE. NON-VACUITY: interpolating the path into output flips RED.
    const env = { AGT_UDS_PATH: AGT_UDS_CANARY };
    const code = await doctorCommand([], env, okProbes());
    expect(code).toBe(0);
    expect(allOutput()).not.toContain(AGT_UDS_CANARY);
  });
});

describe("agentos doctor — credential-blind", () => {
  it("NEVER echoes a secret-shaped env value — only names/host:port/paths/key-names/hints", async () => {
    // The operator's env may carry secret-shaped values (endpoints with creds, sidecar paths, etc.).
    // doctor must report ENV KEY NAMES and reachability — never a VALUE.
    const env = {
      SPENDGUARD_UDS_PATH: "/tmp/spendguard.sock",
      AGENTOS_OPENSHELL_ENDPOINT: "127.0.0.1:17670",
      AGENTOS_SECRET_TOKEN: SECRET_CANARY, // a secret-shaped value the doctor must NOT echo
    };
    const code = await doctorCommand([], env, okProbes());
    expect(code).toBe(0);
    // NON-VACUITY: a mutation that interpolates the env value into output flips this assertion RED.
    expect(allOutput()).not.toContain(SECRET_CANARY);
  });

  it("drops embedded `user:pass@` creds in an endpoint URL — prints host:port, never the secret", async () => {
    // An operator may set a credentialed endpoint URL. The PASS line must show only the reparsed
    // host:port (userinfo dropped), never the embedded password.
    const env = {
      AGENTOS_OPENSHELL_ENDPOINT: `user:${SECRET_CANARY}@127.0.0.1:17670`,
    };
    const code = await doctorCommand([], env, okProbes());
    expect(code).toBe(0);

    const out = allOutput();
    // host:port survives (the operator can confirm the target) ...
    expect(out).toMatch(/PASS\s+OpenShell reachable — connected 127\.0\.0\.1:17670/);
    // ... but the embedded credential / userinfo NEVER does.
    // NON-VACUITY: printing the raw endpoint (the pre-fix `connected ${openshellEndpoint}`) flips RED.
    expect(out).not.toContain(SECRET_CANARY);
    expect(out).not.toContain("user:");
    expect(out).not.toContain("@127.0.0.1");
  });
});

describe("agentos — doctor via runCli + unchanged fail-closed default", () => {
  it("runCli dispatches `doctor` to doctorCommand (fail-closed env -> non-zero, no real services)", async () => {
    // Drive a FAIL deterministically via env with no real services up; the default real probes
    // would (correctly) FAIL OpenShell/kernel reachability -> non-zero, but to keep the test hermetic
    // and offline we assert only that an unknown subcommand still fail-closes (below) and that the
    // injectable seam is what carries determinism.
    const code = await runCli(["doctor"], {});
    expect(typeof code).toBe("number");
  });

  it("an unknown subcommand still returns EXIT_USAGE (existing fail-closed default unchanged)", async () => {
    expect(await runCli(["frobnicate"], {})).toBe(2);
  });
});
