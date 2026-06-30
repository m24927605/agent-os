/**
 * Agent OS — `agentos config render` / `agentos config check` (SLICE-SETUP3 Step 5C/6: the config COMPILER).
 *
 * The unified `agent-os.config.json` is the ONE declarative, NON-SECRET source. `config render` COMPILES it to
 * each system's native artifact under `.agentos/rendered/` + a `render.lock.json` (config hash + per-target
 * sha256 + agentos version); `config check` re-renders in memory and FAILS CLOSED (non-zero) if a target or the
 * config drifted from the lock — the GitOps / CI staleness guard. Each artifact is APPLIED through the owning
 * system's own CLI (printed alongside it); Agent OS never auto-rewrites a foreign system's file.
 *
 * Honest scope: the OpenShell egress artifact is a REFERENCE — the Option B auto-provisioner is the canonical,
 * MERGE-AWARE apply at sandbox creation (a manual `openshell policy set` REPLACES the whole policy). NemoClaw has
 * no auto-provisioner, so its onboard stanza is the real apply path. CREDENTIAL-BLIND: every rendered artifact +
 * the lock hold NON-secret bytes only (the source config is non-secret by schema; secrets live in env / egress).
 *
 * Testability: the I/O (config read, lock read, file write, stdout) is INJECTABLE via the `deps` seam.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildEgressNetworkPolicies } from "../runtime/openshell/index.js";
import { type AgentOsConfig, buildRegistrationEnv, loadAgentOsConfig } from "./setup.js";

type Env = NodeJS.ProcessEnv;

/** Fail-closed exit codes (mirrors main.ts / setup.ts / doctor.ts). */
const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;

const DEFAULT_CONFIG_PATH = "./agent-os.config.json";
const RENDER_DIR = ".agentos/rendered";
const LOCK_PATH = ".agentos/render.lock.json";
/** Stamped into the lock for provenance; the configHash + per-target sha256 are what drive drift. */
const AGENTOS_VERSION = "0.0.0";

/** One compiled native artifact: where it goes (under RENDER_DIR), its bytes, and how to APPLY it. */
export interface RenderedArtifact {
  readonly relPath: string;
  readonly content: string;
  readonly apply: string;
}

/** The render.lock.json shape: provenance + the per-target content hashes the drift check compares against. */
export interface RenderLock {
  readonly version: string;
  readonly configHash: string;
  readonly targets: { readonly relPath: string; readonly sha256: string }[];
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * PURE: compile the declarative config into the list of native artifacts. Each section renders ONLY when present
 * (absent => no artifact => deny-by-default / byte-identical to today). Deterministic + order-stable so the lock
 * hashes are reproducible. Never emits a secret (the source config is non-secret by schema).
 */
export function renderArtifacts(config: AgentOsConfig): RenderedArtifact[] {
  const out: RenderedArtifact[] = [];

  // 1. The bin's NON-secret registration env, as a sorted `.env` reference (what `agentos setup` exports).
  const env = buildRegistrationEnv(config);
  const envLines = `${Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n")}\n`;
  out.push({
    relPath: "registration.env",
    content: envLines,
    apply: "exported into Hermes's mcp_servers.env by `agentos setup` (reference)",
  });

  // 2. OpenShell egress policy (REFERENCE) — only when an egress allowlist is configured. Built from the SAME
  //    `buildEgressNetworkPolicies` the Option B auto-provisioner uses, so the reference matches the live apply.
  const np = config.openshell.networkPolicy;
  const egress = np?.egressAllow ?? [];
  const git = np?.gitEgressAllow ?? [];
  if (egress.length > 0 || git.length > 0) {
    const policy = { network_policies: buildEgressNetworkPolicies(egress, git) };
    out.push({
      relPath: "openshell-egress.json",
      content: `${JSON.stringify(policy, null, 2)}\n`,
      apply:
        "the Option B auto-provisioner applies this MERGE-AWARE at sandbox creation (canonical); manual `openshell policy set` REPLACES the whole policy — prefer the auto-provisioner",
    });
  }

  // 3. NemoClaw onboard stanza — NemoClaw has no auto-provisioner, so this is the real apply path.
  if (config.nemoclaw !== undefined) {
    const img = config.nemoclaw.image !== undefined ? ` --image ${config.nemoclaw.image}` : "";
    const cmd = `nemohermes onboard --gateway ${config.nemoclaw.gateway}${img}`;
    out.push({
      relPath: "nemoclaw-onboard.txt",
      content: `# Onboard the in-sandbox Hermes brain (apply via NemoClaw's own CLI):\n${cmd}\n`,
      apply: cmd,
    });
  }

  return out;
}

/** PURE: build the lock from the source bytes + the rendered artifacts (targets sorted for stability). */
export function buildRenderLock(
  version: string,
  configRaw: string,
  artifacts: readonly RenderedArtifact[],
): RenderLock {
  return {
    version,
    configHash: sha256(configRaw),
    targets: artifacts
      .map((a) => ({ relPath: a.relPath, sha256: sha256(a.content) }))
      .sort((x, y) => x.relPath.localeCompare(y.relPath)),
  };
}

/**
 * PURE drift report: does a FRESH render of the current config match the committed lock? Reports per-target
 * IN-SYNC / DRIFT and config-hash drift; `inSync` is false if ANYTHING diverged (=> `config check` fail-closes).
 */
export function driftReport(
  lock: RenderLock,
  configRaw: string,
  artifacts: readonly RenderedArtifact[],
): { inSync: boolean; lines: string[] } {
  const fresh = buildRenderLock(lock.version, configRaw, artifacts);
  const lines: string[] = [];
  let inSync = true;
  if (fresh.configHash !== lock.configHash) {
    inSync = false;
    lines.push("DRIFT config — agent-os.config.json changed since the last `config render`");
  }
  const locked = new Map(lock.targets.map((t) => [t.relPath, t.sha256]));
  for (const t of fresh.targets) {
    const was = locked.get(t.relPath);
    if (was === undefined) {
      inSync = false;
      lines.push(`DRIFT ${t.relPath} — new target not in render.lock`);
    } else if (was !== t.sha256) {
      inSync = false;
      lines.push(`DRIFT ${t.relPath} — content differs from render.lock`);
    } else {
      lines.push(`IN-SYNC ${t.relPath}`);
    }
    locked.delete(t.relPath);
  }
  for (const stale of locked.keys()) {
    inSync = false;
    lines.push(`DRIFT ${stale} — in render.lock but no longer rendered`);
  }
  return { inSync, lines };
}

/** Injectable I/O seam; defaults to real node built-ins. */
export interface ConfigDeps {
  readFile(path: string): string | undefined;
  writeFile(path: string, content: string): void;
  print(line: string): void;
}

function realConfigDeps(): ConfigDeps {
  return {
    readFile(path: string): string | undefined {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    writeFile(path: string, content: string): void {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
    print(line: string): void {
      process.stdout.write(`${line}\n`);
    },
  };
}

/** Parse `[render|check] [--config <path>]`; undefined on a malformed/unknown flag (fail-closed). */
function parseConfigArgs(
  rest: string[],
): { action: "render" | "check"; configPath: string } | undefined {
  const [action, ...flags] = rest;
  if (action !== "render" && action !== "check") return undefined;
  let configPath = DEFAULT_CONFIG_PATH;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--config") {
      const value = flags[i + 1];
      if (value === undefined) return undefined;
      configPath = value;
      i++;
    } else {
      return undefined;
    }
  }
  return { action, configPath };
}

/**
 * `agentos config render | check`. render: compile -> write `.agentos/rendered/*` + `render.lock.json`. check:
 * re-render in memory + compare to the lock; non-zero on ANY drift (CI staleness guard). Fail-closed on a
 * missing/invalid config or (for check) a missing/invalid lock.
 */
export async function configCommand(
  rest: string[],
  _env: Env,
  deps: ConfigDeps = realConfigDeps(),
): Promise<number> {
  const parsed = parseConfigArgs(rest);
  if (parsed === undefined) {
    deps.print("error: config accepts `render` | `check` [--config <path>]");
    return EXIT_USAGE;
  }

  const raw = deps.readFile(parsed.configPath);
  if (raw === undefined) {
    deps.print(
      `error: cannot read config '${parsed.configPath}' — run \`agentos setup --init\` first`,
    );
    return EXIT_INVALID;
  }
  let config: AgentOsConfig;
  try {
    config = loadAgentOsConfig(raw);
  } catch (err) {
    deps.print(`error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_INVALID;
  }
  const artifacts = renderArtifacts(config);

  if (parsed.action === "render") {
    for (const a of artifacts) {
      deps.writeFile(resolve(RENDER_DIR, a.relPath), a.content);
      deps.print(`wrote ${RENDER_DIR}/${a.relPath} — apply: ${a.apply}`);
    }
    deps.writeFile(
      LOCK_PATH,
      `${JSON.stringify(buildRenderLock(AGENTOS_VERSION, raw, artifacts), null, 2)}\n`,
    );
    deps.print(
      `wrote ${LOCK_PATH} (${artifacts.length} target(s)). Commit it to gate drift in CI (\`config check\`).`,
    );
    return EXIT_OK;
  }

  // check
  const lockRaw = deps.readFile(LOCK_PATH);
  if (lockRaw === undefined) {
    deps.print(`error: no ${LOCK_PATH} — run \`agentos config render\` first`);
    return EXIT_INVALID;
  }
  let lock: RenderLock;
  try {
    lock = JSON.parse(lockRaw) as RenderLock;
  } catch {
    deps.print(`error: ${LOCK_PATH} is not valid JSON`);
    return EXIT_INVALID;
  }
  const { inSync, lines } = driftReport(lock, raw, artifacts);
  for (const l of lines) deps.print(l);
  if (!inSync) {
    deps.print("DRIFT detected — run `agentos config render` and commit the result.");
    return EXIT_INVALID;
  }
  deps.print("IN-SYNC — rendered artifacts match render.lock.");
  return EXIT_OK;
}
