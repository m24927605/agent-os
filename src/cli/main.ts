/**
 * Agent OS — `agentos` CLI (SLICE-P2R-R9-S3).
 *
 * A THIN, zero-third-party-dependency CLI (built on Node's built-in `process.argv` +
 * `node:child_process` + `node:fs`) exposing two exit-code-ised subcommands for tool authors and
 * auditors:
 *
 *   agentos manifest lint <file>            read JSON -> R3 `parseToolManifest` -> 0 (valid) / 1 (invalid)
 *   agentos verify --chain <f> --pubkey <f> spawn the standalone verifier binary, RELAY its exit code
 *                                           (0=intact, 1=broken, 2=bad input)
 *
 * This module's ONLY responsibility is to map argv -> (call SDK parse / spawn verifier) -> exit code.
 * It re-implements NEITHER schema logic (delegated to R3 via the SDK barrel) NOR chain-verification
 * logic (delegated to the standalone verifier binary, consumed across a PROCESS boundary — never an
 * import of Go/kernel internals).
 *
 * Fail-closed law: an unknown subcommand, a missing required argument, a missing file, or an absent
 * verifier binary ALWAYS yields a non-zero exit. The CLI never silently exits 0, and never reports a
 * chain as intact when verification could not actually run.
 *
 * Dependency direction (low coupling): src/cli/main.ts -> src/sdk/index.ts (parseToolManifest) and
 * Node stdlib only; the verifier is reached via process spawn, not import.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseToolManifest } from "../sdk/index.js";
import { doctorCommand } from "./doctor.js";

/** Exit-code contract, fail-closed by construction. */
const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;

type Env = NodeJS.ProcessEnv;

/**
 * Testable entrypoint (mirrors the verifier's `verifyMain` pattern). Returns the process exit code;
 * the bin wrapper passes it to `process.exit`. `env` is injectable so tests can point
 * `AGENTOS_VERIFIER_BIN` at a fixture without mutating `process.env`.
 */
export async function runCli(argv: string[], env: Env = process.env): Promise<number> {
  const [subcommand, ...rest] = argv;

  switch (subcommand) {
    case "manifest":
      return manifestCommand(rest);
    case "verify":
      return verifyCommand(rest, env);
    case "doctor":
      return doctorCommand(rest, env);
    default:
      // Unknown / missing subcommand — fail-closed, never a silent 0.
      process.stderr.write(
        "usage: agentos <manifest lint <file> | verify --chain <f> --pubkey <f> | doctor>\n",
      );
      return EXIT_USAGE;
  }
}

/** `manifest lint <file>` — read JSON, delegate to R3 parse, map to 0/1. */
function manifestCommand(args: string[]): number {
  const [action, file] = args;
  if (action !== "lint") {
    process.stderr.write(`error: unknown manifest action '${action ?? ""}' (expected: lint)\n`);
    return EXIT_USAGE;
  }
  if (file === undefined) {
    process.stderr.write("error: manifest lint requires <file>\n");
    return EXIT_USAGE;
  }

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    process.stderr.write(`error: cannot read '${file}': ${messageOf(err)}\n`);
    return EXIT_INVALID;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`error: '${file}' is not valid JSON: ${messageOf(err)}\n`);
    return EXIT_INVALID;
  }

  try {
    const manifest = parseToolManifest(json);
    process.stdout.write(`ok ${manifest.name}@${manifest.version}\n`);
    return EXIT_OK;
  } catch (err) {
    process.stderr.write(`invalid: ${messageOf(err)}\n`);
    return EXIT_INVALID;
  }
}

/**
 * `verify --chain <f> --pubkey <f>` — spawn the standalone verifier binary and RELAY its exit code.
 * The binary path defaults to `agentos-verifier` on PATH and can be overridden with the
 * `AGENTOS_VERIFIER_BIN` env var (so S5's release artifact, or a fixture in tests, can be targeted).
 * Fail-closed: missing args or an unspawnable binary => non-zero; the verifier's 0/1/2 is passed
 * through unchanged so "broken" is never swallowed into "intact".
 */
function verifyCommand(args: string[], env: Env): number {
  const opts = parseFlags(args);
  if (opts === undefined) {
    process.stderr.write("error: verify accepts only --chain <f> and --pubkey <f>\n");
    return EXIT_USAGE;
  }
  const { chain, pubkey } = opts;
  if (pubkey === undefined) {
    process.stderr.write("error: verify requires --pubkey <f>\n");
    return EXIT_USAGE;
  }

  const bin = env.AGENTOS_VERIFIER_BIN ?? "agentos-verifier";
  const binArgs = ["--pubkey", pubkey];
  if (chain !== undefined) {
    binArgs.push("--chain", chain);
  }

  const result = spawnSync(bin, binArgs, { stdio: "inherit", env });
  if (result.error !== undefined) {
    // Binary absent / not executable — fail-closed: NEVER report intact.
    process.stderr.write(`error: cannot run verifier '${bin}': ${result.error.message}\n`);
    return EXIT_USAGE;
  }
  if (result.signal !== null) {
    process.stderr.write(`error: verifier terminated by signal ${result.signal}\n`);
    return EXIT_USAGE;
  }
  // Relay the verifier's exit code verbatim (0=intact, 1=broken, 2=bad input).
  return result.status ?? EXIT_USAGE;
}

/** Minimal `--key value` flag parser for the verify subcommand. Returns undefined on malformed input. */
function parseFlags(args: string[]): { chain?: string; pubkey?: string } | undefined {
  const out: { chain?: string; pubkey?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--chain" || flag === "--pubkey") {
      if (value === undefined) return undefined;
      if (flag === "--chain") out.chain = value;
      else out.pubkey = value;
      i++;
    } else {
      return undefined;
    }
  }
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Process bootstrap: when this module is the entrypoint (the `agentos` bin), parse argv and relay the
// exit code. Guarded so importing `runCli` (tests, SDK consumers) has NO side effect.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
