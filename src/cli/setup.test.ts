/**
 * SLICE-SETUP2 — `agentos setup` config-driven onboarding wizard: tests (RED-first).
 *
 * SETUP1b's `agentos doctor` VERIFIES the prerequisites; SETUP2's `agentos setup` GENERATES + APPLIES
 * them: it reads a DECLARATIVE `agent-os.config.json` (NON-secret endpoints/paths/ids only — never a
 * key), validates it FAIL-CLOSED via a zod `.strict()` schema (malformed JSON / unknown key / wrong
 * type / missing required / a PARTIAL spendguard object all THROW — never a half-config), builds the
 * `hermes mcp add agentos-exec …` registration via the HDI1 helpers, APPLIES it non-destructively
 * (interactive: `hermes mcp add`; `--print`/headless: print the `mcp_servers` block for manual merge —
 * NEVER auto-merging the user's real config.yaml), then runs `doctor` and surfaces its result.
 *
 * The wizard touches the filesystem (config read), a TTY (readline prompts), and Hermes (`hermes mcp
 * add`), so the I/O is INJECTABLE via the optional `deps` seam. Tests inject fakes — NO real Hermes /
 * FS / TTY — driving every branch deterministically.
 *
 * Properties pinned here:
 *   (1) loadAgentOsConfig: a valid config parses; malformed JSON throws; an unknown key throws
 *       (`.strict()`); a missing required section (openshell / kernel) throws; a PARTIAL spendguard
 *       (some-but-not-all fields) throws — the IT1b "all-or-nothing" fail-closed guard. NON-VACUITY:
 *       a mutation making spendguard fields independently optional flips the partial-spendguard test
 *       RED (it would then PASS-parse a partial object);
 *   (2) setupCommand --print: prints the rendered `mcp_servers` block (carrying the openshell/kernel +
 *       SPENDGUARD_* env) + the target path; runHermesMcpAdd is NOT called; exit 0 (injected doctor 0);
 *   (3) setupCommand interactive: runHermesMcpAdd is called with the buildHermesMcpAddArgv argv;
 *       exit 0 (injected runHermesMcpAdd ok + injected doctor 0);
 *   (4) fail-closed: an invalid config -> non-zero AND NOTHING applied (runHermesMcpAdd not called).
 *       NON-VACUITY: a mutation that applies despite an invalid config flips this RED;
 *   (5) --non-interactive + a missing required field -> non-zero with NO prompt (no readline);
 *   (6) the injected doctor returning non-zero -> setup exits non-zero (surfaces the preflight failure);
 *   (7) CREDENTIAL-BLIND: a secret-shaped value where one shouldn't be makes buildHermesMcpAddArgv (via
 *       setup) THROW; the wizard never echoes a runtime-built `sk-` canary to stdout/stderr.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KERNEL, DEFAULT_OPENSHELL } from "./doctor.js";
import {
  type AgentOsConfig,
  type SetupDeps,
  buildExplainTable,
  buildRegistrationEnv,
  buildScaffoldConfig,
  explainTargetEnvKeys,
  loadAgentOsConfig,
  scaffoldGuidance,
  setupCommand,
} from "./setup.js";

/**
 * Canary secrets, built at runtime so no literal lives in the file (secret-scan stays clean).
 *
 * • SECRET_CANARY: a `sk-live-…` shape. The interposed `live-` BREAKS the `sk-[A-Za-z0-9]{16,}` run,
 *   so the production detector does NOT flag it — used for the "never echoes a value" assertions where
 *   we only need a recognisable canary string, not a detected secret.
 * • SECRET_DETECTED_CANARY: a `sk-<32 alnum>` shape that DOES match `sk-[A-Za-z0-9]{16,}`, so the HDI1
 *   credential-blind builder THROWS on it — used to prove setup fail-closes on a secret-shaped value
 *   and still never echoes it.
 */
const SECRET_CANARY = ["sk", "live", `${"A1b2C3d4E5f6G7h8".repeat(2)}`].join("-");
const SECRET_DETECTED_CANARY = `sk-${"A1b2C3d4E5f6G7h8".repeat(2)}`;

/** A minimal valid config object (NON-secret endpoints/paths/ids only). */
function validConfigObject(): AgentOsConfig {
  return {
    openshell: {
      endpoint: "127.0.0.1:17670",
      mtlsDir: "~/.config/openshell/gateways/openshell/mtls",
      image: "ghcr.io/example/openclaw@sha256:abc123",
    },
    kernel: { ingestEndpoint: "127.0.0.1:50051" },
    spendguard: {
      udsPath: "/tmp/spendguard.sock",
      budgetId: "budget-1",
      unitId: "unit-1",
      windowInstanceId: "window-1",
    },
  };
}

function validConfigJson(): string {
  return JSON.stringify(validConfigObject());
}

/** A valid config WITHOUT the optional spendguard section. */
function validConfigNoSpendguard(): string {
  const c = validConfigObject();
  // biome-ignore lint/performance/noDelete: shaping a test fixture, not a hot path.
  delete (c as { spendguard?: unknown }).spendguard;
  return JSON.stringify(c);
}

/**
 * A runtime-built AGT UDS path canary. doctor/setup must report only the env KEY NAME / a path-class —
 * never this VALUE. Built at runtime so no literal lives in the file (parallels the secret canaries).
 */
const AGT_UDS_CANARY = ["/run", "agentos", `${"x9z8".repeat(4)}`, "agt.sock"].join("/");

// --- stdout/stderr capture (same idiom as doctor.test.ts) ---------------------------------------
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

/**
 * Build an injectable deps seam over a fixed config string + spies. `print` accumulates into a local
 * buffer (the wizard's own channel, separate from the process.stdout spy) so assertions can target the
 * wizard's user-facing output directly.
 */
function makeDeps(overrides: Partial<SetupDeps> & { configRaw?: string | undefined } = {}): {
  deps: SetupDeps;
  printed: string[];
  hermesCalls: string[][];
  promptCalls: string[];
  writes: { path: string; content: string }[];
} {
  const printed: string[] = [];
  const hermesCalls: string[][] = [];
  const promptCalls: string[] = [];
  const writes: { path: string; content: string }[] = [];
  const configRaw = "configRaw" in overrides ? overrides.configRaw : validConfigJson();
  const deps: SetupDeps = {
    readConfigFile: overrides.readConfigFile ?? ((_path: string) => configRaw),
    writeConfigFile:
      overrides.writeConfigFile ??
      ((path: string, content: string) => {
        writes.push({ path, content });
      }),
    prompt:
      overrides.prompt ??
      (async (question: string) => {
        promptCalls.push(question);
        return ""; // default: empty answer (tests that need a real answer override this)
      }),
    runHermesMcpAdd:
      overrides.runHermesMcpAdd ??
      ((argv: string[]) => {
        hermesCalls.push(argv);
        return { ok: true };
      }),
    doctor: overrides.doctor ?? (async (_env) => 0),
    print:
      overrides.print ??
      ((line: string) => {
        printed.push(line);
      }),
    // Default to an interactive TTY so the apply-via-`hermes mcp add` branch is exercised without a
    // real terminal; tests that want the headless print path pass `--print` (which short-circuits this).
    isInteractiveTty: overrides.isInteractiveTty ?? (() => true),
  };
  return { deps, printed, hermesCalls, promptCalls, writes };
}

// ================================================================================================
// (1) loadAgentOsConfig — fail-closed zod `.strict()` validation
// ================================================================================================
describe("loadAgentOsConfig — fail-closed validation", () => {
  it("parses a valid config (openshell + kernel + full spendguard)", () => {
    const cfg = loadAgentOsConfig(validConfigJson());
    expect(cfg.openshell.endpoint).toBe("127.0.0.1:17670");
    expect(cfg.kernel.ingestEndpoint).toBe("127.0.0.1:50051");
    expect(cfg.spendguard?.budgetId).toBe("budget-1");
  });

  it("parses a valid config WITHOUT the optional spendguard section", () => {
    const cfg = loadAgentOsConfig(validConfigNoSpendguard());
    expect(cfg.openshell.endpoint).toBe("127.0.0.1:17670");
    expect(cfg.spendguard).toBeUndefined();
  });

  it("THROWS on malformed JSON", () => {
    expect(() => loadAgentOsConfig("{ not json ")).toThrow();
  });

  it("THROWS on an unknown top-level key (zod .strict)", () => {
    const raw = JSON.stringify({ ...validConfigObject(), unexpected: "x" });
    expect(() => loadAgentOsConfig(raw)).toThrow();
  });

  it("THROWS on an unknown nested key (zod .strict)", () => {
    const c = validConfigObject();
    const raw = JSON.stringify({ ...c, openshell: { ...c.openshell, extra: "y" } });
    expect(() => loadAgentOsConfig(raw)).toThrow();
  });

  it("THROWS on a present-but-unknown `agt` key (honest: rejected via .strict, not silently ignored)", () => {
    // `endpoint` is NOT a field of the AGT advisory section (udsPath/scope/timeoutMs only) — `.strict()`
    // rejects the unknown nested key, even though `agt` is now a supported section.
    const raw = JSON.stringify({ ...validConfigObject(), agt: { endpoint: "127.0.0.1:9000" } });
    expect(() => loadAgentOsConfig(raw)).toThrow();
  });

  it("THROWS when a required section is missing (openshell)", () => {
    const c = validConfigObject();
    // biome-ignore lint/performance/noDelete: test fixture shaping.
    delete (c as { openshell?: unknown }).openshell;
    expect(() => loadAgentOsConfig(JSON.stringify(c))).toThrow();
  });

  it("THROWS when a required section is missing (kernel)", () => {
    const c = validConfigObject();
    // biome-ignore lint/performance/noDelete: test fixture shaping.
    delete (c as { kernel?: unknown }).kernel;
    expect(() => loadAgentOsConfig(JSON.stringify(c))).toThrow();
  });

  it("THROWS on a wrong-typed required field (kernel.ingestEndpoint as a number)", () => {
    const c = validConfigObject();
    const raw = JSON.stringify({ ...c, kernel: { ingestEndpoint: 50051 } });
    expect(() => loadAgentOsConfig(raw)).toThrow();
  });

  // --- the IT1b all-or-nothing spendguard guard (NON-VACUITY anchor) ---------------------------
  it("THROWS on a PARTIAL spendguard (udsPath WITHOUT windowInstanceId) — fail-closed all-or-nothing", () => {
    // NON-VACUITY: a mutation making spendguard fields independently optional would PASS-parse this
    // partial object, flipping this test RED. This is the "thought SpendGuard was on but mis-set it"
    // fail-closed guard (mirrors IT1b): a partial topology must never become a half-configured gate.
    const c = validConfigObject();
    const raw = JSON.stringify({
      ...c,
      spendguard: { udsPath: "/tmp/spendguard.sock", budgetId: "budget-1", unitId: "unit-1" },
    });
    expect(() => loadAgentOsConfig(raw)).toThrow();
  });

  it("THROWS on a PARTIAL spendguard (only budgetId set)", () => {
    const c = validConfigObject();
    const raw = JSON.stringify({ ...c, spendguard: { budgetId: "budget-1" } });
    expect(() => loadAgentOsConfig(raw)).toThrow();
  });

  // --- SLICE-R9c: the `agt` advisory section (udsPath REQUIRED, scope/timeoutMs OPTIONAL) ---------
  it("parses a config with a minimal `agt` section (just udsPath)", () => {
    const c = validConfigObject();
    const raw = JSON.stringify({ ...c, agt: { udsPath: "/p/agt.sock" } });
    const cfg = loadAgentOsConfig(raw);
    expect(cfg.agt?.udsPath).toBe("/p/agt.sock");
    expect(cfg.agt?.scope).toBeUndefined();
    expect(cfg.agt?.timeoutMs).toBeUndefined();
  });

  it("parses a config with a full `agt` section (udsPath + scope + timeoutMs)", () => {
    const c = validConfigObject();
    const raw = JSON.stringify({
      ...c,
      agt: { udsPath: "/p/agt.sock", scope: "all", timeoutMs: 1000 },
    });
    const cfg = loadAgentOsConfig(raw);
    expect(cfg.agt?.udsPath).toBe("/p/agt.sock");
    expect(cfg.agt?.scope).toBe("all");
    expect(cfg.agt?.timeoutMs).toBe(1000);
  });

  it("parses a config WITHOUT the optional `agt` section (agt is optional)", () => {
    const cfg = loadAgentOsConfig(validConfigNoSpendguard());
    expect(cfg.agt).toBeUndefined();
  });

  it("THROWS on a PARTIAL agt (present but NO udsPath) — fail-closed all-or-nothing", () => {
    // NON-VACUITY: a mutation making `udsPath` optional (agt fields independently optional) would
    // PASS-parse this empty agt object, flipping this test RED. udsPath is REQUIRED when agt is present.
    const c = validConfigObject();
    const raw = JSON.stringify({ ...c, agt: {} });
    expect(() => loadAgentOsConfig(raw)).toThrow();
  });

  it("THROWS on an invalid agt.scope (not effectful|all)", () => {
    const c = validConfigObject();
    const raw = JSON.stringify({ ...c, agt: { udsPath: "/p/agt.sock", scope: "bogus" } });
    expect(() => loadAgentOsConfig(raw)).toThrow();
  });

  it("THROWS on a non-integer agt.timeoutMs (wrong type)", () => {
    const c = validConfigObject();
    const raw = JSON.stringify({ ...c, agt: { udsPath: "/p/agt.sock", timeoutMs: "x" } });
    expect(() => loadAgentOsConfig(raw)).toThrow();
  });
});

// ================================================================================================
// (2) setupCommand --print — headless, non-destructive: print the block, apply NOTHING
// ================================================================================================
describe("setupCommand — --print (headless, non-destructive)", () => {
  it("prints the rendered mcp_servers block (openshell/kernel + SPENDGUARD_* env) + path; runHermesMcpAdd NOT called; exit 0", async () => {
    const { deps, printed, hermesCalls } = makeDeps();
    const code = await setupCommand(["--print"], {}, deps);
    expect(code).toBe(0);

    const blob = printed.join("\n");
    // The rendered config.yaml `mcp_servers` block, carrying the non-secret env.
    expect(blob).toContain("mcp_servers:");
    expect(blob).toContain("agentos-exec");
    expect(blob).toContain("AGENTOS_OPENSHELL_ENDPOINT");
    expect(blob).toContain("127.0.0.1:17670");
    expect(blob).toContain("AGENTOS_KERNEL_INGEST_ENDPOINT");
    expect(blob).toContain("127.0.0.1:50051");
    // spendguard set -> the SPENDGUARD_* env appears in the block.
    expect(blob).toContain("SPENDGUARD_UDS_PATH");
    expect(blob).toContain("SPENDGUARD_BUDGET_ID");
    expect(blob).toContain("SPENDGUARD_UNIT_ID");
    expect(blob).toContain("SPENDGUARD_WINDOW_INSTANCE_ID");
    // a target path for the manual merge.
    expect(blob).toContain("config.yaml");

    // NON-DESTRUCTIVE: print mode NEVER invokes hermes mcp add.
    expect(hermesCalls).toHaveLength(0);
  });

  it("omits the SPENDGUARD_* env when the config has no spendguard section (--print)", async () => {
    const { deps, printed } = makeDeps({ configRaw: validConfigNoSpendguard() });
    const code = await setupCommand(["--print"], {}, deps);
    expect(code).toBe(0);
    const blob = printed.join("\n");
    expect(blob).toContain("AGENTOS_OPENSHELL_ENDPOINT");
    expect(blob).not.toContain("SPENDGUARD_UDS_PATH");
  });

  it("derives the target config.yaml path from HERMES_HOME when set (--print)", async () => {
    const { deps, printed } = makeDeps();
    const code = await setupCommand(["--print"], { HERMES_HOME: "/custom/hermes" }, deps);
    expect(code).toBe(0);
    expect(printed.join("\n")).toContain("/custom/hermes/config.yaml");
  });
});

// ================================================================================================
// (3) setupCommand interactive — applies via `hermes mcp add` (non-destructive, Hermes-owned merge)
// ================================================================================================
describe("setupCommand — interactive apply via hermes mcp add", () => {
  it("calls runHermesMcpAdd with the buildHermesMcpAddArgv argv; exit 0 (hermes ok + doctor 0)", async () => {
    const { deps, hermesCalls, printed } = makeDeps();
    // No --print, no --non-interactive: interactive apply path.
    const code = await setupCommand([], {}, deps);
    expect(code).toBe(0);

    expect(hermesCalls).toHaveLength(1);
    const argv = hermesCalls[0];
    if (argv === undefined) throw new Error("expected runHermesMcpAdd to have been called");
    // The HDI1 argv shape: ["mcp","add","agentos-exec","--command","node","--env",…,"--args",binPath].
    expect(argv.slice(0, 5)).toEqual(["mcp", "add", "agentos-exec", "--command", "node"]);
    expect(argv).toContain("--env");
    // Env pairs carry the non-secret endpoints + the SPENDGUARD_* topology.
    expect(argv.some((a) => a.startsWith("AGENTOS_OPENSHELL_ENDPOINT="))).toBe(true);
    expect(argv.some((a) => a.startsWith("AGENTOS_KERNEL_INGEST_ENDPOINT="))).toBe(true);
    expect(argv.some((a) => a.startsWith("SPENDGUARD_UDS_PATH="))).toBe(true);
    // `--args` is the LAST flag, immediately followed by exactly the bin path (HDI1 REMAINDER invariant).
    const argsIdx = argv.indexOf("--args");
    expect(argsIdx).toBeGreaterThan(-1);
    expect(argsIdx).toBe(argv.length - 2);

    // doctor ran (exit 0 surfaced); the wizard printed a final report line, not the raw config.
    expect(printed.join("\n").length).toBeGreaterThan(0);
  });

  it("returns non-zero when runHermesMcpAdd fails (fail-closed apply)", async () => {
    const { deps } = makeDeps({
      runHermesMcpAdd: () => ({ ok: false, stderr: "hermes add failed" }),
    });
    const code = await setupCommand([], {}, deps);
    expect(code).not.toBe(0);
  });
});

// ================================================================================================
// (4) fail-closed: invalid config -> non-zero AND nothing applied
// ================================================================================================
describe("setupCommand — fail-closed on invalid config", () => {
  it("returns non-zero and applies NOTHING on an invalid config (partial spendguard)", async () => {
    const c = validConfigObject();
    const badRaw = JSON.stringify({
      ...c,
      spendguard: { udsPath: "/tmp/spendguard.sock" }, // partial -> invalid
    });
    const { deps, hermesCalls, printed } = makeDeps({ configRaw: badRaw });
    const code = await setupCommand(["--print"], {}, deps);
    expect(code).not.toBe(0);
    // NON-VACUITY: a mutation that applies/prints the registration despite an invalid config flips
    // BOTH of these RED (the no-apply-on-invalid guard).
    expect(hermesCalls).toHaveLength(0);
    expect(printed.join("\n")).not.toContain("mcp_servers:");
  });

  it("returns non-zero on malformed JSON, applying nothing", async () => {
    const { deps, hermesCalls } = makeDeps({ configRaw: "{ broken" });
    const code = await setupCommand([], {}, deps);
    expect(code).not.toBe(0);
    expect(hermesCalls).toHaveLength(0);
  });

  it("returns non-zero when the config file is absent (readConfigFile -> undefined) in --non-interactive", async () => {
    const { deps, hermesCalls } = makeDeps({ configRaw: undefined });
    const code = await setupCommand(["--non-interactive"], {}, deps);
    expect(code).not.toBe(0);
    expect(hermesCalls).toHaveLength(0);
  });
});

// ================================================================================================
// (5) --non-interactive: missing required -> non-zero, NO prompt
// ================================================================================================
describe("setupCommand — --non-interactive", () => {
  it("returns non-zero on a missing required field WITHOUT prompting (no readline)", async () => {
    const c = validConfigObject();
    // biome-ignore lint/performance/noDelete: test fixture shaping.
    delete (c as { kernel?: unknown }).kernel;
    const { deps, promptCalls, hermesCalls } = makeDeps({ configRaw: JSON.stringify(c) });
    const code = await setupCommand(["--non-interactive"], {}, deps);
    expect(code).not.toBe(0);
    // fail-closed: no interactive prompt in non-interactive mode.
    expect(promptCalls).toHaveLength(0);
    expect(hermesCalls).toHaveLength(0);
  });
});

// ================================================================================================
// (6) doctor non-zero -> setup non-zero (surfaces the preflight failure)
// ================================================================================================
describe("setupCommand — surfaces the doctor preflight result", () => {
  it("returns non-zero when the injected doctor returns non-zero (preflight FAIL)", async () => {
    const { deps } = makeDeps({ doctor: async (_env) => 1 });
    const code = await setupCommand(["--print"], {}, deps);
    expect(code).not.toBe(0);
  });

  it("passes the BUILT registration env to doctor (so doctor checks the configured endpoints)", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const { deps } = makeDeps({
      doctor: async (env) => {
        seenEnv = env;
        return 0;
      },
    });
    const code = await setupCommand(["--print"], {}, deps);
    expect(code).toBe(0);
    expect(seenEnv?.AGENTOS_OPENSHELL_ENDPOINT).toBe("127.0.0.1:17670");
    expect(seenEnv?.AGENTOS_KERNEL_INGEST_ENDPOINT).toBe("127.0.0.1:50051");
    expect(seenEnv?.SPENDGUARD_UDS_PATH).toBe("/tmp/spendguard.sock");
  });
});

// ================================================================================================
// (7) CREDENTIAL-BLIND — a secret-shaped value THROWS / is never echoed
// ================================================================================================
describe("setupCommand — credential-blind", () => {
  it("FAILS (non-zero) and NEVER echoes a secret-shaped value carried in an endpoint", async () => {
    // An operator wrongly put a secret-shaped value where a non-secret endpoint belongs. The HDI1
    // builder THROWS on a secret-shaped env value; the wizard must surface that as a fail-closed exit
    // and NEVER echo the secret to stdout/stderr/print. SECRET_DETECTED_CANARY matches the production
    // `sk-[A-Za-z0-9]{16,}` detector, so the build step throws.
    const c = validConfigObject();
    const badRaw = JSON.stringify({
      ...c,
      openshell: { ...c.openshell, endpoint: SECRET_DETECTED_CANARY },
    });
    const { deps, printed, hermesCalls } = makeDeps({ configRaw: badRaw });
    const code = await setupCommand(["--print"], {}, deps);
    expect(code).not.toBe(0);
    // NON-VACUITY: the secret-shaped value must never appear in ANY output channel.
    expect(allOutput()).not.toContain(SECRET_DETECTED_CANARY);
    expect(printed.join("\n")).not.toContain(SECRET_DETECTED_CANARY);
    // Nothing applied either.
    expect(hermesCalls).toHaveLength(0);
  });

  it("never echoes a secret-shaped value even when the config is otherwise valid (env spy)", async () => {
    // Even on the happy path, no secret-shaped token should ever reach the user-facing channels.
    const { deps, printed } = makeDeps();
    await setupCommand(["--print"], {}, deps);
    expect(allOutput()).not.toContain(SECRET_CANARY);
    expect(printed.join("\n")).not.toContain(SECRET_CANARY);
  });
});

// ================================================================================================
// (8) SLICE-R9c — setup writes AGT_* env when the config declares `agt`, omits it otherwise
// ================================================================================================
describe("setupCommand — AGT_* env build (R9b-2b integrationsFromEnv picks it up)", () => {
  /** A config object carrying a full `agt` advisory section (udsPath + scope + timeoutMs). */
  function configWithAgt(scope = "effectful", timeoutMs = 750): string {
    return JSON.stringify({
      ...validConfigObject(),
      agt: { udsPath: AGT_UDS_CANARY, scope, timeoutMs },
    });
  }

  it("emits AGT_UDS_PATH (+ AGT_SCOPE + AGT_TIMEOUT_MS) into the rendered block when agt is set", async () => {
    const { deps, printed } = makeDeps({ configRaw: configWithAgt("all", 1500) });
    const code = await setupCommand(["--print"], {}, deps);
    expect(code).toBe(0);
    const blob = printed.join("\n");
    // NON-VACUITY: dropping the AGT_UDS_PATH write flips this RED (the env-build no longer carries it).
    expect(blob).toContain("AGT_UDS_PATH");
    expect(blob).toContain("AGT_SCOPE");
    expect(blob).toContain("AGT_TIMEOUT_MS");
    // The scope/timeout VALUES are non-secret and flow through verbatim.
    expect(blob).toContain("all");
    expect(blob).toContain("1500");
  });

  it("emits ONLY AGT_UDS_PATH (no AGT_SCOPE / AGT_TIMEOUT_MS) when scope/timeoutMs are omitted", async () => {
    const raw = JSON.stringify({ ...validConfigObject(), agt: { udsPath: AGT_UDS_CANARY } });
    const { deps, printed } = makeDeps({ configRaw: raw });
    const code = await setupCommand(["--print"], {}, deps);
    expect(code).toBe(0);
    const blob = printed.join("\n");
    expect(blob).toContain("AGT_UDS_PATH");
    expect(blob).not.toContain("AGT_SCOPE");
    expect(blob).not.toContain("AGT_TIMEOUT_MS");
  });

  it("omits ALL AGT_* env when the config has NO agt section (byte-identical to today)", async () => {
    const { deps, printed } = makeDeps({ configRaw: validConfigNoSpendguard() });
    const code = await setupCommand(["--print"], {}, deps);
    expect(code).toBe(0);
    const blob = printed.join("\n");
    expect(blob).not.toContain("AGT_UDS_PATH");
    expect(blob).not.toContain("AGT_SCOPE");
    expect(blob).not.toContain("AGT_TIMEOUT_MS");
  });

  it("passes the BUILT AGT_* env to doctor (so doctor's conditional AGT check sees the configured socket)", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const { deps } = makeDeps({
      configRaw: configWithAgt("effectful", 750),
      doctor: async (env) => {
        seenEnv = env;
        return 0;
      },
    });
    const code = await setupCommand(["--print"], {}, deps);
    expect(code).toBe(0);
    expect(seenEnv?.AGT_UDS_PATH).toBe(AGT_UDS_CANARY);
    expect(seenEnv?.AGT_SCOPE).toBe("effectful");
    expect(seenEnv?.AGT_TIMEOUT_MS).toBe("750");
  });

  it("emits the AGT argv env-pair on the interactive `hermes mcp add` path too", async () => {
    const { deps, hermesCalls } = makeDeps({ configRaw: configWithAgt() });
    const code = await setupCommand([], {}, deps);
    expect(code).toBe(0);
    expect(hermesCalls).toHaveLength(1);
    const argv = hermesCalls[0];
    if (argv === undefined) throw new Error("expected runHermesMcpAdd to have been called");
    expect(argv.some((a) => a.startsWith("AGT_UDS_PATH="))).toBe(true);
  });
});

// ================================================================================================
// (SLICE-SETUP3) setup --init — scaffold a starter config (fixes the blank page); scaffold == doctor
// ================================================================================================
describe("setup --init — scaffold a starter agent-os.config.json", () => {
  it("buildScaffoldConfig(personal): openshell+kernel use the SAME doctor defaults; no spendguard/agt; valid", () => {
    const cfg = buildScaffoldConfig("personal");
    expect(cfg.openshell.endpoint).toBe(DEFAULT_OPENSHELL); // scaffold == doctor (one canonical value)
    expect(cfg.kernel.ingestEndpoint).toBe(DEFAULT_KERNEL);
    expect(cfg.spendguard).toBeUndefined();
    expect(cfg.agt).toBeUndefined();
    expect(() => loadAgentOsConfig(`${JSON.stringify(cfg, null, 2)}\n`)).not.toThrow();
  });

  it("buildScaffoldConfig(enterprise) adds spendguard; (developer) adds agt; both parse", () => {
    const ent = buildScaffoldConfig("enterprise");
    expect(ent.spendguard).toBeDefined();
    expect(ent.agt).toBeUndefined();
    expect(() => loadAgentOsConfig(JSON.stringify(ent))).not.toThrow();
    const dev = buildScaffoldConfig("developer");
    expect(dev.agt).toBeDefined();
    expect(dev.spendguard).toBeUndefined();
    expect(() => loadAgentOsConfig(JSON.stringify(dev))).not.toThrow();
  });

  it("the scaffold is NON-SECRET (no secret-shaped value); guidance NAMES the secret env-vars (stdout only)", () => {
    for (const p of ["personal", "enterprise", "developer"] as const) {
      expect(JSON.stringify(buildScaffoldConfig(p))).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
      expect(scaffoldGuidance(p).join("\n")).toContain("AGENTOS_NET_FETCH_AUTH_KEY");
    }
  });

  it("`setup --init` writes the config + JSON Schema, exits 0, the config parses + carries $schema, applies NOTHING", async () => {
    const { deps, writes, hermesCalls } = makeDeps({ configRaw: undefined }); // no existing file
    const code = await setupCommand(["--init"], {}, deps);
    expect(code).toBe(0);
    expect(writes.length).toBe(2); // the config + agent-os.config.schema.json (editor autocomplete/hover)
    expect(hermesCalls.length).toBe(0); // --init only scaffolds; it never applies
    const cfg = writes[0];
    if (cfg === undefined) throw new Error("expected a config write");
    expect(() => loadAgentOsConfig(cfg.content)).not.toThrow();
    expect(loadAgentOsConfig(cfg.content).$schema).toBe("./agent-os.config.schema.json"); // editor ref stamped
    expect(writes.some((w) => w.path.endsWith("agent-os.config.schema.json"))).toBe(true); // schema file written
  });

  it("`setup --init --profile enterprise` scaffolds the enterprise config (with spendguard)", async () => {
    const { deps, writes } = makeDeps({ configRaw: undefined });
    const code = await setupCommand(["--init", "--profile", "enterprise"], {}, deps);
    expect(code).toBe(0);
    const w = writes[0];
    if (w === undefined) throw new Error("expected a scaffold write");
    expect(loadAgentOsConfig(w.content).spendguard).toBeDefined();
  });

  it("REFUSE-IF-EXISTS: `--init` over an existing file fails closed (no write); `--force` overwrites", async () => {
    const existing = makeDeps({ configRaw: validConfigJson() }); // a file is already present
    expect(await setupCommand(["--init"], {}, existing.deps)).not.toBe(0);
    expect(existing.writes.length).toBe(0); // never clobbered
    const forced = makeDeps({ configRaw: validConfigJson() });
    expect(await setupCommand(["--init", "--force"], {}, forced.deps)).toBe(0);
    expect(forced.writes.length).toBe(2); // overwrites the config + (re)writes the schema file
  });

  it("an invalid `--profile` value fails closed (usage error, NO write)", async () => {
    const { deps, writes } = makeDeps({ configRaw: undefined });
    expect(await setupCommand(["--init", "--profile", "bogus"], {}, deps)).not.toBe(0);
    expect(writes.length).toBe(0);
  });
});

// ================================================================================================
// (SLICE-SETUP3) setup --explain — the config-field -> native-output map (drift-guarded, value-free)
// ================================================================================================
describe("setup --explain — config-field -> native-output map", () => {
  it("explainTargetEnvKeys COVERS every env key buildRegistrationEnv emits (cannot drift behind the renderer)", () => {
    // a FULL config (openshell+networkPolicy+kernel+spendguard+agt) exercises EVERY renderer branch.
    const ent = buildScaffoldConfig("enterprise");
    const full: AgentOsConfig = {
      ...ent,
      openshell: {
        ...ent.openshell,
        networkPolicy: { egressAllow: ["api.github.com"], gitEgressAllow: ["github.com"] },
      },
      agt: buildScaffoldConfig("developer").agt,
    };
    const documented = new Set(explainTargetEnvKeys());
    for (const key of Object.keys(buildRegistrationEnv(full))) {
      expect(documented.has(key)).toBe(true); // every produced env key is in the explain table
    }
    expect(buildExplainTable().length).toBeGreaterThan(0);
  });

  it("`setup --explain` prints the field->target map, exits 0, applies NOTHING, leaks no env VALUE", async () => {
    const { deps, printed, hermesCalls, writes } = makeDeps({ configRaw: undefined });
    // an env secret is present but --explain prints only the STATIC map — no env value is ever read.
    const code = await setupCommand(
      ["--explain"],
      { AGENTOS_OPENSHELL_ENDPOINT: "10.9.9.9:1" },
      deps,
    );
    expect(code).toBe(0);
    expect(hermesCalls.length).toBe(0); // --explain never applies
    expect(writes.length).toBe(0);
    const out = printed.join("\n");
    expect(out).toContain("openshell.endpoint  ->  AGENTOS_OPENSHELL_ENDPOINT");
    expect(out).toContain("agt.udsPath  ->  AGT_UDS_PATH");
    expect(out).not.toContain("10.9.9.9"); // VALUE-FREE: the table maps field->KEY name, never a value
  });

  it("`--explain --resolved` shows YOUR config's compiled NON-SECRET values inline (exit 0)", async () => {
    const { deps, printed } = makeDeps({ configRaw: validConfigJson() }); // valid config present
    const code = await setupCommand(["--explain", "--resolved"], {}, deps);
    expect(code).toBe(0);
    const out = printed.join("\n");
    expect(out).toContain("AGENTOS_OPENSHELL_ENDPOINT  = 127.0.0.1:17670"); // your actual value, inline
    expect(out).toContain("AGENTOS_EGRESS_ALLOW  = (unset)"); // an unconfigured target shows (unset)
  });

  it("`--explain --resolved` with NO config fails closed (non-zero) — it needs a config to resolve", async () => {
    const { deps } = makeDeps({ configRaw: undefined });
    expect(await setupCommand(["--explain", "--resolved"], {}, deps)).not.toBe(0);
  });
});

// ================================================================================================
// (SLICE-SETUP3 Step 5A) openshell.networkPolicy egress allowlist -> AGENTOS_EGRESS_ALLOW env
// ================================================================================================
describe("setup Step 5 — openshell.networkPolicy compiles the egress allowlist into the env", () => {
  const withNetworkPolicy = (np: unknown): string => {
    const c = validConfigObject();
    return JSON.stringify({ ...c, openshell: { ...c.openshell, networkPolicy: np } });
  };

  it("parses egressAllow/gitEgressAllow host lists; a non-plain-DNS host or unknown key fails closed", () => {
    expect(() =>
      loadAgentOsConfig(
        withNetworkPolicy({ egressAllow: ["api.github.com", "raw.githubusercontent.com"] }),
      ),
    ).not.toThrow();
    expect(() =>
      loadAgentOsConfig(withNetworkPolicy({ egressAllow: ["https://api.github.com"] })),
    ).toThrow(); // scheme
    expect(() =>
      loadAgentOsConfig(withNetworkPolicy({ egressAllow: ["api.github.com:443"] })),
    ).toThrow(); // port
    expect(() => loadAgentOsConfig(withNetworkPolicy({ egressAllow: ["1.2.3.4"] }))).toThrow(); // IP literal
    expect(() => loadAgentOsConfig(withNetworkPolicy({ bogusKey: [] }))).toThrow(); // .strict()
  });

  it("compiles egressAllow -> AGENTOS_EGRESS_ALLOW (comma-joined) + gitEgressAllow -> AGENTOS_GIT_EGRESS_ALLOW", () => {
    const cfg = loadAgentOsConfig(
      withNetworkPolicy({
        egressAllow: ["api.github.com", "pypi.org"],
        gitEgressAllow: ["github.com"],
      }),
    );
    const env = buildRegistrationEnv(cfg);
    expect(env.AGENTOS_EGRESS_ALLOW).toBe("api.github.com,pypi.org"); // the env the Option B provisioner reads
    expect(env.AGENTOS_GIT_EGRESS_ALLOW).toBe("github.com");
  });

  it("DE-DUPES a host listed twice (the env matches the rendered policy + the auto-provisioner's effective set)", () => {
    const cfg = loadAgentOsConfig(
      withNetworkPolicy({ egressAllow: ["api.github.com", "pypi.org", "api.github.com"] }),
    );
    expect(buildRegistrationEnv(cfg).AGENTOS_EGRESS_ALLOW).toBe("api.github.com,pypi.org"); // not the triple
  });

  it("absent networkPolicy => NO egress env (deny-by-default, byte-identical to today)", () => {
    const env = buildRegistrationEnv(loadAgentOsConfig(validConfigJson()));
    expect(env.AGENTOS_EGRESS_ALLOW).toBeUndefined();
    expect(env.AGENTOS_GIT_EGRESS_ALLOW).toBeUndefined();
  });
});

// ================================================================================================
// (SLICE-SETUP3 Step 5B) secrets KEY-NAME registry — config stays NON-SECRET (rejects a pasted value)
// ================================================================================================
describe("setup Step 5 — secrets KEY-NAME registry", () => {
  const withSecrets = (secrets: unknown): string =>
    JSON.stringify({ ...validConfigObject(), secrets });

  it("parses a {logicalName: ENV_KEY_NAME} map of UPPER_SNAKE key names", () => {
    const cfg = loadAgentOsConfig(
      withSecrets({ gmail: "AGENTOS_GMAIL_OAUTH_KEY", netFetch: "AGENTOS_NET_FETCH_AUTH_KEY" }),
    );
    expect(cfg.secrets?.gmail).toBe("AGENTOS_GMAIL_OAUTH_KEY"); // a KEY NAME, not a value
  });

  it("REJECTS a pasted SECRET VALUE (not an env-key NAME) — fail-closed AND value-free (a credential can't land in the file)", () => {
    let msg = "";
    try {
      loadAgentOsConfig(withSecrets({ gmail: SECRET_DETECTED_CANARY })); // a `sk-<alnum>` token, not UPPER_SNAKE
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toMatch(/ENV KEY NAME|invalid/i); // it threw on the non-key-name value
    expect(msg).not.toContain(SECRET_DETECTED_CANARY); // VALUE-FREE: the bad value is never echoed in the error
    expect(() => loadAgentOsConfig(withSecrets({ gmail: "ya29.a0Af-lowercase-token" }))).toThrow();
  });

  it("D4 defense-in-depth: an ALL-CAPS secret shape (AWS AKIA key) passes the C-identifier regex but is REJECTED by the redactor", () => {
    const akia = ["AKIA", "IOSFODNN7EXAMPLE"].join(""); // matches ^[A-Z][A-Z0-9_]*$ yet is a secret shape
    expect(() => loadAgentOsConfig(withSecrets({ aws: akia }))).toThrow();
  });
});
