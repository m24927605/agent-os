/**
 * SLICE-R9b-1 — credential-blind governance projection for `exec.run`.
 *
 * The PURE, vendor-neutral function that turns validated `exec.run` args (`{ argv }`) into a minimal,
 * redacted, BOUNDED `GovernanceProjection` — the "what is this action" detail an AGT advisory engine
 * will later (R9b-2) consume. This module is INERT today: nothing imports it, no PolicyRequest /
 * closure references it. It is isolated here because a credential-blind projection is R9's most
 * sensitive new component and deserves independent review before any transport / AGT wiring.
 *
 * VENDOR-NEUTRALITY: lives in the policy core zone and imports ONLY the vendor-neutral `redactSecrets`
 * through the audit public barrel. It never names or imports a vendor (hermes/nemoclaw/openshell/agt/
 * spendguard), so `no-vendor-in-core` holds and the AGT adapter layer can import it later without a
 * cross-zone violation. The PDP ignores this projection; only the AGT adapter reads it.
 *
 * ⚠️ BEST-EFFORT credential-blind (NOT an absolute guarantee — read carefully):
 *   - env / stdin / file contents are STRUCTURALLY never inputs (the function takes only `{ argv }`),
 *     so they cannot appear in any field.
 *   - EVERY string field passes `redactSecrets`, which scrubs KNOWN secret SHAPES only (the audit
 *     `SECRET_VALUE` regex: sk-/ghp_/AKIA/xox/JWT/PEM). The by-KEY scrub does NOT apply to standalone
 *     argv tokens.
 *   - `networkHosts` STRIPS `user:pass@` userinfo BEFORE keeping the host (mirrors SETUP1b
 *     `splitEndpoint`), then redacts — so a `user:secret@host` token yields only `host`.
 *   - `argvRedacted` is BOUNDED at MAX_TOKENS; overflow sets `truncated=true` (explicit, never silent).
 *   ⚠️ LIMITATION: a NON-shape credential passed as a plain arg (e.g. `--password=hunter2`,
 *     `--api-key ZZZ_custom_999`) is NOT detected by shape-redaction and CAN survive in `argvRedacted`.
 *     This projection is therefore safe to hand ONLY to the operator's local AGT advisory engine — a
 *     trusted governance peer (like the PDP / SpendGuard's DecisionLedger), NEVER a log / WORM / audit
 *     payload / artifact / trace / fixture sink. It is NOT a guarantee that no credential of any form
 *     can pass; it is best-effort shape-redaction + userinfo-strip + bounding + no-env/stdin/contents.
 * PURE: no I/O, no throw on normal input; defensive on empty / very long argv.
 */
import { redactSecrets } from "../audit/index.js";

/**
 * The minimal, BEST-EFFORT credential-blind action-detail an AGT advisory engine consumes. Vendor-
 * neutral; the PDP ignores it. Every string field is shape-redacted; `argvRedacted` is bounded;
 * `networkHosts` has userinfo stripped. NON-shape credentials in a plain arg can still survive in
 * `argvRedacted` — see the module header; consume ONLY in the local AGT engine, never a log/WORM sink.
 * `version` pins the contract for the (future) AGT adapter that reads it.
 */
export interface GovernanceProjection {
  readonly version: 1;
  /** Coarse class derived from basename(argv0): filesystem / network / shell / process / unknown. */
  readonly operationClass: string;
  /** argv[0], redacted. */
  readonly argv0: string;
  /** Original token count (BEFORE truncation) — truncation is explicit, never silent. */
  readonly argc: number;
  /** Each token redactSecrets'd, bounded at MAX_TOKENS. */
  readonly argvRedacted: readonly string[];
  /** True when argc > MAX_TOKENS (the overflow that argvRedacted dropped). */
  readonly truncated: boolean;
  /** basename(argv0) is a known shell AND some later token is exactly `-c`. */
  readonly usesShellInterpreter: boolean;
  /** host[:port] extracted from URL-like / host:port tokens; userinfo stripped, redacted, de-duped. */
  readonly networkHosts: readonly string[];
  /** Best-effort intersection with a known destructive-flag set — a HINT for AGT, not exhaustive. */
  readonly destructiveFlags: readonly string[];
}

/** Bound on `argvRedacted` — caps the projection size; overflow sets `truncated`. */
const MAX_TOKENS = 64;

/** Shell interpreters that take a `-c` command string. basename(argv0) ∈ this set ⇒ shell. */
const SHELL_BASENAMES: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Known destructive flags (best-effort hint, not exhaustive). */
const DESTRUCTIVE_FLAGS: ReadonlySet<string> = new Set([
  "-rf",
  "-fr",
  "--force",
  "--no-preserve-root",
]);

/** Coarse operationClass buckets keyed by basename(argv0). */
const FILESYSTEM_CMDS: ReadonlySet<string> = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "rmdir",
  "ln",
  "touch",
  "chmod",
  "chown",
  "dd",
  "ls",
  "cat",
]);
const NETWORK_CMDS: ReadonlySet<string> = new Set(["curl", "wget", "nc", "ssh", "scp", "ftp"]);
const PROCESS_CMDS: ReadonlySet<string> = new Set([
  "node",
  "python",
  "python3",
  "npm",
  "pnpm",
  "yarn",
  "ruby",
  "go",
  "java",
  "deno",
]);

/** Pure basename: last path segment after `/` (and after `\` for safety). No I/O. */
function basename(token: string): string {
  const lastSlash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  return lastSlash >= 0 ? token.slice(lastSlash + 1) : token;
}

/** Coarse, deterministic operationClass from basename(argv0). */
function classifyOperation(argv0: string): string {
  const base = basename(argv0);
  if (SHELL_BASENAMES.has(base)) return "shell";
  if (NETWORK_CMDS.has(base)) return "network";
  if (FILESYSTEM_CMDS.has(base)) return "filesystem";
  if (PROCESS_CMDS.has(base)) return "process";
  return "unknown";
}

/**
 * Strip a `user:pass@` userinfo prefix and a `scheme://` prefix from an authority — mirrors SETUP1b
 * `splitEndpoint`. Reimplemented locally (NOT imported from src/cli) to keep this module vendor-neutral
 * and dependency-free. Returns the bare `host[:port]` authority with NO credential.
 */
function stripUserinfo(authority: string): string {
  const noScheme = authority.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const at = noScheme.lastIndexOf("@");
  // Everything up to and including the LAST `@` is userinfo (user:pass) — drop it entirely.
  return at >= 0 ? noScheme.slice(at + 1) : noScheme;
}

/**
 * Conservative network-host extraction from a single token. Returns the bare `host[:port]` (userinfo
 * stripped) when the token genuinely looks like a URL or `host:port`, else `undefined` — so flags and
 * plain words are NOT misclassified. The host is NOT redacted here; the caller redacts after de-dup.
 */
function extractHost(token: string): string | undefined {
  // A flag (`-c`, `--force`) is never a host.
  if (token.startsWith("-")) return undefined;

  // URL-like: scheme://... — strip scheme + userinfo, then keep host[:port] up to the first
  // path/query/fragment delimiter.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) {
    // split(_, 1) yields at most one element; default to "" so the type is a plain string.
    const authority = stripUserinfo(token).split(/[/?#]/, 1)[0] ?? "";
    return authority.length > 0 ? authority : undefined;
  }

  // Bare host:port — be conservative: a dotted hostname (or localhost) followed by a numeric port.
  // `key:value-not-a-host` (non-numeric port) and arbitrary `word:word` are rejected.
  const stripped = stripUserinfo(token);
  const m = /^([A-Za-z0-9.-]+):([0-9]{1,5})$/.exec(stripped);
  if (m) {
    // Capture group 1 always matches when `m` is non-null; `?? ""` satisfies noUncheckedIndexedAccess.
    const host = m[1] ?? "";
    // Require a dotted host or `localhost` so a bare `name:8080` without a dot isn't over-kept.
    if (host.includes(".") || host === "localhost") return stripped;
  }
  return undefined;
}

/**
 * Build the credential-blind projection from validated `exec.run` args (`{ argv }`). PURE: no I/O,
 * no throw on normal input. Defensive on empty argv (exec.run schema's `.min(1)` should prevent it,
 * but we return a safe projection rather than throw) and on very long argv (bounded by MAX_TOKENS).
 */
export function buildExecRunProjection(validated: {
  readonly argv: readonly string[];
}): GovernanceProjection {
  const argv = validated.argv;
  const argc = argv.length;

  // Defensive empty-argv path: no program, safe inert projection.
  if (argc === 0) {
    return {
      version: 1,
      operationClass: "unknown",
      argv0: "",
      argc: 0,
      argvRedacted: [],
      truncated: false,
      usesShellInterpreter: false,
      networkHosts: [],
      destructiveFlags: [],
    };
  }

  // argc > 0 here, so argv[0] exists; `?? ""` satisfies noUncheckedIndexedAccess without a non-null `!`.
  const rawArgv0 = argv[0] ?? "";
  const argv0 = redactSecrets(rawArgv0);

  // BOUNDED + per-token redacted. truncated is explicit (never silently drop the tail).
  const argvRedacted = argv.slice(0, MAX_TOKENS).map((t) => redactSecrets(t));
  const truncated = argc > MAX_TOKENS;

  // Shell interpreter: basename(argv0) ∈ shell set AND some LATER token is exactly `-c`.
  const usesShellInterpreter =
    SHELL_BASENAMES.has(basename(rawArgv0)) && argv.slice(1).some((t) => t === "-c");

  // networkHosts: extract host[:port] (userinfo stripped) from URL-like / host:port tokens, redact,
  // de-dup. Userinfo is stripped BEFORE redaction so a `user:secret@host` yields only `host`.
  const hosts = new Set<string>();
  for (const token of argv) {
    const host = extractHost(token);
    if (host !== undefined) hosts.add(redactSecrets(host));
  }
  const networkHosts = [...hosts];

  // destructiveFlags: best-effort intersection with the known set (a hint, not exhaustive). De-duped.
  const flags = new Set<string>();
  for (const token of argv) {
    if (DESTRUCTIVE_FLAGS.has(token)) flags.add(token);
  }
  const destructiveFlags = [...flags];

  return {
    version: 1,
    operationClass: classifyOperation(rawArgv0),
    argv0,
    argc,
    argvRedacted,
    truncated,
    usesShellInterpreter,
    networkHosts,
    destructiveFlags,
  };
}
