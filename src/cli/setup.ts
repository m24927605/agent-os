import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
/**
 * Agent OS — `agentos setup` config-driven onboarding wizard (SLICE-SETUP2).
 *
 * SETUP1b's `agentos doctor` VERIFIES the prerequisites; this command GENERATES + APPLIES them. It is
 * a THIN, zero-third-party-dependency wizard (Node built-ins + the existing `zod` dep only) that:
 *
 *   1. LOADS a DECLARATIVE `agent-os.config.json` (default `./agent-os.config.json`, or `--config`).
 *      The config is NON-secret only — host:port endpoints, filesystem paths, and ids. It NEVER holds
 *      a credential. Read = `JSON.parse` + a zod `.strict()` schema (`loadAgentOsConfig`): malformed
 *      JSON / an unknown key / a wrong type / a missing required section / a PARTIAL `spendguard`
 *      object all THROW — fail-closed, never a half-config.
 *   2. PROMPTS (interactive only) for a missing required field via Node's built-in `readline`. Under
 *      `--non-interactive`, a missing/invalid config fails-closed (non-zero) with no prompt.
 *   3. VALIDATES fail-closed (the zod parse + the credential-blind HDI1 builders, which THROW on a
 *      secret-shaped env value).
 *   4. BUILDS the `agentos-exec` registration env (the bin's NON-secret runtime endpoints + the
 *      SPENDGUARD_* topology when configured) and the `hermes mcp add` argv / `config.yaml` block via
 *      the HDI1 helpers `buildHermesMcpAddArgv` / `renderHermesMcpServersConfigYaml`.
 *   5. APPLIES non-destructively:
 *        • interactive (TTY): run `hermes mcp add agentos-exec …` — Hermes OWNS the non-destructive
 *          `config.yaml` merge (the user answers Hermes's discovery-first "Enable tools?" prompt).
 *        • `--print` / headless / no-TTY: PRINT the rendered `mcp_servers` block + the target path
 *          (`$HERMES_HOME/config.yaml`, defaulting to `~/.hermes/config.yaml`) for a manual merge.
 *      It NEVER auto-merges the user's real `config.yaml` (zero-dep safe-merge of an arbitrary
 *      existing config — including provider/auth + existing mcp_servers — is brittle; we delegate to
 *      Hermes or print).
 *   6. VERIFIES by running SETUP1b `doctor` against the BUILT registration env, surfacing its result.
 *
 * Fail-closed exit: non-zero on an invalid/missing config, a missing required field under
 * `--non-interactive`, a `hermes mcp add` failure, or a doctor FAIL; 0 ONLY on success.
 *
 * CREDENTIAL-BLIND: the config + env are NON-secret only. The wizard NEVER prints or stores a key; the
 * readline prompts are for non-secret endpoints/ids only; the HDI1 builders THROW on a secret-shaped
 * value (kept). The wizard NEVER reads `~/.hermes` file contents — it only WRITES a printed block for
 * the user to merge, or delegates the merge to Hermes's own CLI.
 *
 * Honest scope: SETUP2 = generate + apply + verify onboarding. SpendGuard is turnkey via the env this
 * wizard writes (SETUP1a wired the bin to honor it). AGT advisory is turnkey the same way (SLICE-R9c):
 * a config `agt` section -> the AGT_* env -> R9b-2b's `integrationsFromEnv` registers the AGT secondary.
 * The honest boundary remains: REAL AGT live still needs the operator's Python sidecar — `e2e:live-agt`
 * is that gated path. `setup` starts NO services (Hermes/OpenShell/kernel/sidecars) — that is deployment;
 * doctor checks they are up. The apply delegates to `hermes mcp add` or prints — never a fragile
 * auto-merge.
 *
 * Testability: the I/O (config read, readline prompt, `hermes mcp add` spawn, doctor, stdout) is
 * INJECTABLE via the optional `deps` seam, defaulting to the real node-built-in implementations. Tests
 * inject fakes — no real Hermes / FS / TTY.
 *
 * Dependency direction: src/cli/setup.ts -> the hermes vendor-adapter barrel (the HDI1 builders, the
 * only place that may name Hermes) + ./doctor + Node stdlib + `zod`. The CLI is NOT in the
 * `no-vendor-in-core` from-set, so consuming the hermes adapter barrel is legal.
 */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type HermesMcpAddOptions,
  buildHermesMcpAddArgv,
  renderHermesMcpServersConfigYaml,
} from "../runtime/brain/adapters/hermes/index.js";
import { doctorCommand } from "./doctor.js";

type Env = NodeJS.ProcessEnv;

/** Fail-closed exit codes (mirrors main.ts / doctor.ts). */
const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;

/** The MCP server name Hermes uses to namespace our discovered tools (matches the bin's name). */
const SERVER_NAME = "agentos-exec";

/** Default config path when `--config` is not supplied. */
const DEFAULT_CONFIG_PATH = "./agent-os.config.json";

/** Path of the built bin, relative to the repo root (mirrors doctor.ts). */
const BIN_REL_PATH = "dist/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js";

// ================================================================================================
// (1) Config schema — zod `.strict()` (fail-closed: unknown key / wrong type / missing / partial)
// ================================================================================================

/**
 * The declarative `agent-os.config.json` schema.
 *
 * • `openshell` + `kernel` are REQUIRED.
 * • `spendguard` is OPTIONAL but ALL-OR-NOTHING: a PARTIAL spendguard object (some-but-not-all fields)
 *   is a zod error — the fail-closed "thought SpendGuard was on but mis-set it" guard (mirrors IT1b).
 *   Because the object's fields are all required, an under-specified spendguard fails to parse rather
 *   than silently becoming a half-configured gate.
 * • `agt` is OPTIONAL but ALL-OR-NOTHING (SLICE-R9c): the AGT advisory section carries `udsPath`
 *   (REQUIRED when `agt` is present), plus optional `scope` ("effectful" | "all") and `timeoutMs`
 *   (positive int). A PARTIAL agt (present but no `udsPath` / a bad scope / a non-int timeoutMs) is a
 *   zod error — fail-closed, never a half-configured advisory. When present, setup writes the matching
 *   `AGT_*` env into the bin's `mcp_servers.env`, which R9b-2b's `integrationsFromEnv` reads to register
 *   the AGT secondary; absent `agt` -> no `AGT_*` -> byte-identical to today.
 * • `.strict()` everywhere: an unknown top-level OR nested key is still REJECTED — honest over
 *   silently-ignored (e.g. an `agt.endpoint` key, which the AGT section does not define, fails-closed).
 */
const OpenShellSchema = z
  .object({
    endpoint: z.string(),
    mtlsDir: z.string(),
    image: z.string(),
  })
  .strict();

const KernelSchema = z
  .object({
    ingestEndpoint: z.string(),
  })
  .strict();

const SpendGuardSchema = z
  .object({
    udsPath: z.string(),
    budgetId: z.string(),
    unitId: z.string(),
    windowInstanceId: z.string(),
  })
  .strict();

/**
 * The AGT advisory section (SLICE-R9c). `udsPath` is REQUIRED when `agt` is present (all-or-nothing via
 * the object: an empty `{}` fails to parse). `scope` defaults to "effectful" downstream (R9b-2b) when
 * omitted; an explicit value must be "effectful" | "all". `timeoutMs`, when set, must be a positive
 * integer. All NON-secret (a path / an enum / a number). `.strict()` rejects any unknown key.
 */
const AgtSchema = z
  .object({
    udsPath: z.string(),
    scope: z.enum(["effectful", "all"]).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const AgentOsConfigSchema = z
  .object({
    openshell: OpenShellSchema,
    kernel: KernelSchema,
    spendguard: SpendGuardSchema.optional(),
    agt: AgtSchema.optional(),
  })
  .strict();

/** The validated, fully-typed config. */
export type AgentOsConfig = z.infer<typeof AgentOsConfigSchema>;

/**
 * Parse + validate a raw `agent-os.config.json` string. Fail-closed: malformed JSON, an unknown key
 * (`.strict()`), a wrong type, a missing required section, or a PARTIAL spendguard all THROW a clear
 * message — never a partial config.
 */
export function loadAgentOsConfig(raw: string): AgentOsConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`agent-os.config.json is not valid JSON: ${messageOf(err)}`);
  }
  const result = AgentOsConfigSchema.safeParse(json);
  if (!result.success) {
    // zod's message names the offending path/type/unknown-key; surface it, never the values.
    throw new Error(`agent-os.config.json is invalid: ${result.error.message}`);
  }
  return result.data;
}

// ================================================================================================
// Injectable deps seam — defaults to real node-built-in implementations; tests inject fakes.
// ================================================================================================

export interface SetupDeps {
  /** Read the config file at `path`; undefined if absent/unreadable (real: `fs.readFileSync`). */
  readConfigFile(path: string): string | undefined;
  /** Prompt the user for a NON-secret value (real: `node:readline`). */
  prompt(question: string): Promise<string>;
  /** Run `hermes mcp add <argv>` non-destructively (real: `spawnSync("hermes", argv)`). */
  runHermesMcpAdd(argv: string[]): { ok: boolean; stderr?: string };
  /** Run the SETUP1b preflight against the BUILT env (real: `doctorCommand`). */
  doctor(env: Env): Promise<number>;
  /** Emit one user-facing line (real: `process.stdout.write`). */
  print(line: string): void;
  /**
   * Whether stdout is an interactive TTY (real: `process.stdout.isTTY === true`). Gates the apply
   * mode: a TTY can answer Hermes's discovery-first "Enable tools?" prompt, so the interactive path
   * runs `hermes mcp add`; no-TTY falls back to the headless PRINT path. Injectable so the apply
   * branch is testable without a real terminal.
   */
  isInteractiveTty(): boolean;
}

/** The path of the built bin, resolved from the repo root (this module lives at <root>/{src,dist}/cli). */
function binPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  return resolve(repoRoot, BIN_REL_PATH);
}

/** Real, node-built-in deps (the production default). */
function realDeps(): SetupDeps {
  return {
    readConfigFile(path: string): string | undefined {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    async prompt(question: string): Promise<string> {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await new Promise<string>((res) => rl.question(question, res));
      } finally {
        rl.close();
      }
    },
    runHermesMcpAdd(argv: string[]): { ok: boolean; stderr?: string } {
      const r = spawnSync("hermes", argv, { stdio: "inherit" });
      if (r.error !== undefined) return { ok: false, stderr: r.error.message };
      if (r.signal !== null) return { ok: false, stderr: `terminated by signal ${r.signal}` };
      return { ok: (r.status ?? 1) === 0 };
    },
    doctor(env: Env): Promise<number> {
      return doctorCommand([], env);
    },
    print(line: string): void {
      process.stdout.write(`${line}\n`);
    },
    isInteractiveTty(): boolean {
      return process.stdout.isTTY === true;
    },
  };
}

// ================================================================================================
// Flag parsing — the CLI's minimal flag style.
// ================================================================================================

interface SetupFlags {
  config: string;
  print: boolean;
  nonInteractive: boolean;
}

/** Parse `--config <path> | --print | --non-interactive`. Returns undefined on a malformed flag. */
function parseSetupFlags(args: string[]): SetupFlags | undefined {
  const out: SetupFlags = {
    config: DEFAULT_CONFIG_PATH,
    print: false,
    nonInteractive: false,
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--print") {
      out.print = true;
    } else if (flag === "--non-interactive") {
      out.nonInteractive = true;
    } else if (flag === "--config") {
      const value = args[i + 1];
      if (value === undefined) return undefined;
      out.config = value;
      i++;
    } else {
      return undefined;
    }
  }
  return out;
}

// ================================================================================================
// (2)-(6) setupCommand — load -> prompt-missing -> validate -> build -> apply -> doctor -> exit
// ================================================================================================

export async function setupCommand(
  rest: string[],
  env: Env,
  deps: SetupDeps = realDeps(),
): Promise<number> {
  const flags = parseSetupFlags(rest);
  if (flags === undefined) {
    deps.print("error: setup accepts only --config <path>, --print, --non-interactive");
    return EXIT_USAGE;
  }

  // --- LOAD: read the config file. -------------------------------------------------------------
  const raw = deps.readConfigFile(flags.config);
  if (raw === undefined) {
    // The config file is absent. Interactive mode could prompt for ALL fields, but the declarative
    // contract is "fill agent-os.config.json"; an absent file under --non-interactive is fail-closed.
    // (Interactive prompting for a missing-but-present required field is handled below; a wholly
    // absent file with no scaffold is fail-closed either way — never a half-config.)
    deps.print(
      `error: cannot read config '${flags.config}' — create it (see README) or pass --config`,
    );
    return EXIT_INVALID;
  }

  // --- VALIDATE (fail-closed): JSON.parse + zod .strict. --------------------------------------
  let config: AgentOsConfig;
  try {
    config = loadAgentOsConfig(raw);
  } catch (err) {
    // The optional interactive re-prompt is intentionally narrow: it only fills a MISSING required
    // string when there is room to ask. A structurally-invalid config (unknown key / partial
    // spendguard / wrong type) is fail-closed — never patched silently. Honest + simple.
    if (!flags.nonInteractive) {
      const recovered = await tryInteractiveRecover(raw, deps);
      if (recovered !== undefined) {
        config = recovered;
      } else {
        deps.print(`error: ${messageOf(err)}`);
        return EXIT_INVALID;
      }
    } else {
      deps.print(`error: ${messageOf(err)}`);
      return EXIT_INVALID;
    }
  }

  // --- BUILD: the registration env (NON-secret only) + the HDI1 argv / config.yaml block. ------
  const registrationEnv = buildRegistrationEnv(config);
  const opts: HermesMcpAddOptions = {
    name: SERVER_NAME,
    binPath: binPath(),
    env: registrationEnv,
  };

  // CREDENTIAL-BLIND: the HDI1 builders THROW on a secret-shaped env value. We build BEFORE applying,
  // so a secret in a wrong place fails-closed (non-zero) and NOTHING is applied/printed.
  let argv: string[];
  let yamlBlock: string;
  try {
    argv = buildHermesMcpAddArgv(opts);
    yamlBlock = renderHermesMcpServersConfigYaml(opts);
  } catch {
    // Never echo the offending value (it may be secret-shaped). A static, value-free message only.
    deps.print(
      "error: refusing to register — a config value looks secret-shaped (config carries NON-secret endpoints/ids only)",
    );
    return EXIT_INVALID;
  }

  // --- APPLY (non-destructive). ----------------------------------------------------------------
  const interactive = !flags.print && !flags.nonInteractive && deps.isInteractiveTty();
  if (interactive) {
    // Hermes OWNS the non-destructive config.yaml merge; the user answers its "Enable tools?" prompt.
    const r = deps.runHermesMcpAdd(argv);
    if (!r.ok) {
      deps.print(
        `error: \`hermes mcp add ${SERVER_NAME}\` failed${r.stderr ? `: ${r.stderr}` : ""}`,
      );
      return EXIT_INVALID;
    }
    deps.print(`registered \`${SERVER_NAME}\` via \`hermes mcp add\` (non-destructive merge).`);
  } else {
    // Headless / --print / no-TTY: print the block + the target path for a MANUAL merge. We NEVER
    // auto-merge the user's real config.yaml.
    const target = configYamlPath(env);
    deps.print(
      `# Add the following to ${target} (manual merge — Hermes owns the file; we never rewrite it):`,
    );
    // The rendered block is credential-blind by construction (it shares the HDI1 no-secret guard).
    deps.print(yamlBlock.replace(/\n$/, ""));
  }

  // --- VERIFY: run the SETUP1b preflight against the BUILT env; surface its result. ------------
  const doctorEnv: Env = { ...env, ...registrationEnv };
  const doctorCode = await deps.doctor(doctorEnv);
  if (doctorCode !== 0) {
    deps.print("preflight (doctor) FAILED — fix the reported checks, then re-run `agentos setup`.");
    return doctorCode; // surface the preflight's fail-closed non-zero exit verbatim.
  }

  deps.print("setup complete — `agentos-exec` registered and preflight green.");
  return EXIT_OK;
}

/**
 * Build the `agentos-exec` registration env — the bin's NON-secret runtime endpoints, plus (when the
 * config declares spendguard) the SPENDGUARD_* topology that SETUP1a's bin honors, plus (when the config
 * declares agt) the AGT_* topology that R9b-2b's `integrationsFromEnv` reads to register the AGT advisory
 * secondary. All values come straight from the validated config; no value is a secret (paths / ids /
 * enums / a number). Absent `agt` -> NO `AGT_*` keys -> byte-identical to today (no AGT secondary).
 */
function buildRegistrationEnv(config: AgentOsConfig): Record<string, string> {
  const env: Record<string, string> = {
    AGENTOS_OPENSHELL_ENDPOINT: config.openshell.endpoint,
    AGENTOS_OPENSHELL_MTLS: config.openshell.mtlsDir,
    AGENTOS_OPENSHELL_IMAGE: config.openshell.image,
    AGENTOS_KERNEL_INGEST_ENDPOINT: config.kernel.ingestEndpoint,
  };
  if (config.spendguard !== undefined) {
    env.SPENDGUARD_UDS_PATH = config.spendguard.udsPath;
    env.SPENDGUARD_BUDGET_ID = config.spendguard.budgetId;
    env.SPENDGUARD_UNIT_ID = config.spendguard.unitId;
    env.SPENDGUARD_WINDOW_INSTANCE_ID = config.spendguard.windowInstanceId;
  }
  if (config.agt !== undefined) {
    // udsPath is REQUIRED by the schema when `agt` is present; scope/timeoutMs are optional. R9b-2b's
    // `parseAgtConfig` defaults scope to "effectful" when AGT_SCOPE is unset, so we only write the
    // optional keys when the operator declared them.
    env.AGT_UDS_PATH = config.agt.udsPath;
    if (config.agt.scope !== undefined) env.AGT_SCOPE = config.agt.scope;
    if (config.agt.timeoutMs !== undefined) env.AGT_TIMEOUT_MS = String(config.agt.timeoutMs);
  }
  return env;
}

/**
 * The target `config.yaml` path Hermes reads: `$HERMES_HOME/config.yaml`, defaulting to
 * `~/.hermes/config.yaml`. We print this for a MANUAL merge — we never read or rewrite the file.
 */
function configYamlPath(env: Env): string {
  const home =
    env.HERMES_HOME && env.HERMES_HOME.length > 0 ? env.HERMES_HOME : resolve(homedir(), ".hermes");
  return resolve(home, "config.yaml");
}

/**
 * Narrow interactive recovery: when the config is invalid ONLY because a single required string field
 * is MISSING (not because of an unknown key / wrong type / partial spendguard), ask for it via
 * readline and re-validate. Returns the recovered config, or undefined when recovery is not safe (any
 * structural error — fail-closed, never patch). The prompts are for NON-secret endpoints/ids only.
 */
async function tryInteractiveRecover(
  raw: string,
  deps: SetupDeps,
): Promise<AgentOsConfig | undefined> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined; // malformed JSON is not a fillable "missing field" — fail-closed.
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const obj = json as Record<string, unknown>;

  // Only the two REQUIRED top-level sections are promptable, and only when wholly absent. We do NOT
  // patch a partial spendguard or an unknown key — those stay fail-closed.
  const patched: Record<string, unknown> = { ...obj };
  if (patched.openshell === undefined) {
    const endpoint = (await deps.prompt("openshell.endpoint (host:port): ")).trim();
    const mtlsDir = (await deps.prompt("openshell.mtlsDir (path): ")).trim();
    const image = (await deps.prompt("openshell.image (ref): ")).trim();
    if (endpoint === "" || mtlsDir === "" || image === "") return undefined;
    patched.openshell = { endpoint, mtlsDir, image };
  }
  if (patched.kernel === undefined) {
    const ingestEndpoint = (await deps.prompt("kernel.ingestEndpoint (host:port): ")).trim();
    if (ingestEndpoint === "") return undefined;
    patched.kernel = { ingestEndpoint };
  }

  const result = AgentOsConfigSchema.safeParse(patched);
  return result.success ? result.data : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
