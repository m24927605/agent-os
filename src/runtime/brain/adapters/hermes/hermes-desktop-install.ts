/**
 * SLICE-HDI1 — the PURE, Hermes-free install core: build the argv for Hermes Desktop's own
 * `hermes mcp add` CLI so a real Hermes Desktop user can register Agent OS's governed MCP bin into their
 * `~/.hermes/config.yaml` `mcp_servers` map.
 *
 * WHY DELEGATE (don't hand-edit YAML): Hermes OWNS the `config.yaml` format (an auto-reloaded
 * `mcp_servers` MAP whose entries are `{command, args:[...], env:{KEY: "val"}}`). Hermes's own CLI
 * upserts that map idempotently. So the install builds the `hermes mcp add` ARGV and lets Hermes write
 * the file — we never clobber the user's config, never reimplement Hermes's YAML shape, only touch the
 * one `agentos-exec` key.
 *
 * THE CLI CONTRACT (grounded from the installed Hermes — hermes_cli/subcommands/mcp.py):
 *   hermes mcp add <name> --command <cmd> --env KEY=VALUE [KEY=VALUE …] --args <REMAINDER…>
 *   • `--command` is the stdio command to spawn (here always `node`).
 *   • `--env` is `nargs=*` of `KEY=VALUE` pairs (the bin's NON-secret runtime endpoints).
 *   • `--args` is `nargs=REMAINDER` — it MUST be the LAST option, because EVERYTHING after it is taken
 *     as the spawned command's args vector. Putting `--args` before `--env` would make REMAINDER swallow
 *     the env pairs. So `buildHermesMcpAddArgv` ALWAYS emits `--args` last.
 *
 * CREDENTIAL-BLIND (fail-closed): the install takes ONLY non-secret inputs (the absolute bin path + the
 * NON-secret OpenShell/kernel host:port endpoints + an mTLS DIR path). If ANY env value looks
 * secret-shaped (the repo's `redactSecrets`-changed detector — same construction as every bootstrap
 * + the args credential screen), the builder THROWS rather than emit a secret into the install argv /
 * into `config.yaml`. The real credential boundary remains a sandbox provisioned with ZERO credentials
 * + NO egress; this guard is the best-effort gate keeping a literal secret out of the persisted config.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone (the only place that may name Hermes).
 * Imports ONLY the neutral `substrate` PUBLIC barrel (the `redactSecrets`-changed secret detector) — no
 * deep import, no vendor named in core. Re-exported via the hermes barrel.
 */
import { type ExecSecretDetector, defaultExecSecretDetector } from "../../../substrate/index.js";

/** The default MCP server name Hermes uses to namespace our discovered tools (matches the bin's name). */
const DEFAULT_NAME = "agentos-exec";

/** Inputs for the install — ONLY non-secret: the absolute bin path + the bin's runtime endpoint env. */
export interface HermesMcpAddOptions {
  /** The Hermes mcp_servers key (defaults to `agentos-exec`). */
  readonly name?: string;
  /** Absolute path to the BUILT bin a real Hermes spawns (`node <binPath>`). */
  readonly binPath: string;
  /** The bin's NON-secret runtime env (OpenShell/kernel host:port + an mTLS DIR path). */
  readonly env: Readonly<Record<string, string>>;
  /** Optional secret detector override (defaults to the production `redactSecrets`-changed test). */
  readonly detectSecret?: ExecSecretDetector;
}

const SECRET_REASON =
  "credential-blind: refusing to emit a secret-shaped value into the Hermes install argv / config.yaml";

/**
 * Fail-closed credential screen over the install env. A value (or its rendered `KEY=VALUE`) that the
 * detector flags secret-shaped — OR a detector that THROWS — DENIES by throwing, so a literal secret can
 * never be written into the persisted Hermes config. Benign endpoints (host:port, a filesystem path)
 * pass.
 */
function assertNoSecretEnv(
  env: Readonly<Record<string, string>>,
  detectSecret: ExecSecretDetector,
): void {
  for (const [key, value] of Object.entries(env)) {
    let flagged: boolean;
    try {
      // Screen the VALUE and the rendered KEY=VALUE token (a secret-named key with a secret value is the
      // shape the bootstrap detector catches). Fail-closed on either.
      flagged = detectSecret(value) || detectSecret(`${key}=${value}`);
    } catch {
      // Deny-by-default: a detector that throws must never let a value through on a failed check.
      throw new Error(SECRET_REASON);
    }
    if (flagged) throw new Error(SECRET_REASON);
  }
}

/**
 * Build the argv for `hermes mcp add` registering the governed exec bin. The shape (grounded from the
 * Hermes CLI):
 *
 *   ["mcp","add", name, "--command","node", "--env", "K1=V1","K2=V2",…, "--args", binPath]
 *
 * Load-bearing invariants:
 *   • `--args` is the LAST flag and is immediately followed by EXACTLY the bin path (nargs=REMAINDER).
 *   • `--env` (and its KEY=VALUE pairs) appear BEFORE `--args`, never after (REMAINDER would swallow them).
 *   • the `--env` flag is omitted entirely when `env` is empty (an empty nargs=* would dangle).
 *   • CREDENTIAL-BLIND: a secret-shaped env value THROWS — no secret ever enters the argv.
 */
export function buildHermesMcpAddArgv(opts: HermesMcpAddOptions): string[] {
  const detectSecret = opts.detectSecret ?? defaultExecSecretDetector;
  // Fail-closed FIRST: never build an argv that would carry a secret into config.yaml.
  assertNoSecretEnv(opts.env, detectSecret);

  const name = opts.name ?? DEFAULT_NAME;
  const envPairs = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`);

  const argv: string[] = ["mcp", "add", name, "--command", "node"];
  if (envPairs.length > 0) argv.push("--env", ...envPairs);
  // `--args` is REMAINDER — it MUST be last; everything after it is the spawned bin's args vector.
  argv.push("--args", opts.binPath);
  return argv;
}

/**
 * Render the equivalent MANUAL `config.yaml` `mcp_servers` snippet — used by the install script's
 * no-Hermes clean-BLOCK path (when the `hermes` CLI is absent, we print this so the user can paste it
 * into `~/.hermes/config.yaml` themselves). Same credential-blind guard as the argv builder.
 *
 * Mirrors Hermes's documented shape (cli-config.yaml.example): the entry is a MAP with `command`,
 * `args:[…]`, and an `env:` YAML MAP.
 */
export function renderHermesConfigYamlSnippet(opts: HermesMcpAddOptions): string {
  const detectSecret = opts.detectSecret ?? defaultExecSecretDetector;
  assertNoSecretEnv(opts.env, detectSecret);

  const name = opts.name ?? DEFAULT_NAME;
  const lines: string[] = [
    "mcp_servers:",
    `  ${name}:`,
    "    command: node",
    "    args:",
    `      - ${opts.binPath}`,
  ];
  const envEntries = Object.entries(opts.env);
  if (envEntries.length > 0) {
    lines.push("    env:");
    for (const [k, v] of envEntries) {
      // Quote the value so host:port / path strings round-trip as YAML scalars.
      lines.push(`      ${k}: "${v}"`);
    }
  }
  return `${lines.join("\n")}\n`;
}
