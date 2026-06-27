/**
 * SLICE-EXEC3b / SLICE-HDI2a — the SHARED seed exec tools (manifests + composer-held bindings) reused by
 * the EXEC3a join test (`exec-closed-loop.test.ts`), the EXEC3b live capstone (`exec-capstone.live.test.ts`),
 * and AUTO-advertised + AUTO-governed by the EXEC4a MCP server (`mcp/exec-mcp-server.ts`).
 *
 * The EXEC3a slice introduced the FIRST two read-only seed tools — `exec.echo` (argvPrefix ["echo"],
 * strict {text}) and `exec.ls` (argvPrefix ["ls"], strict {path}) — extracted out of the test file so the
 * live capstone composes the EXACT bindings the in-repo join proved, not a re-declared lookalike that
 * could drift. SLICE-HDI2a GROWS this read-only-safe set by PURE ADDITION (five more read-only tools —
 * `exec.cat` / `exec.head` / `exec.pwd` / `exec.wc` / `exec.grep`): each is a manifest + a binding +
 * registration, and NO governance is relaxed. The MCP server auto-advertises every `seedBindings()` key
 * and auto-governs every `tools/call` via `runGovernedToolCall`; the `exec.**` allow rule already covers
 * `exec.*` — so adding a tool is exactly a manifest + a binding + registration.
 *
 * The brain proposes only a REGISTERED tool NAME + DECLARED params; the composer's binding fixes
 * `argvPrefix` + a STRICT `argSchema` + a pure `toArgv` builder, so argv is a pure string vector built in
 * ONE place — never a shell string, never `sh -c`, never raw brain input. Every HDI2a arg is STRING-ONLY
 * so the in-house `argSchemaToJsonSchema` derives each inputSchema without change.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone alongside `exec-closed-loop.ts`; imports
 * ONLY `zod`, the neutral `tools` public barrel, and the in-module `ExecToolBinding` type. Re-exported
 * via the hermes barrel.
 */
import { z } from "zod";
import { placeholderForKey } from "../../../../credential/index.js";
import { buildExecRunProjection } from "../../../../policy/index.js";
import { type Primitive, ToolRegistry, WIRED_PRIMITIVES } from "../../../../tools/index.js";
import type { ExecToolBinding } from "./exec-closed-loop.js";

/** A valid `exec.echo` ToolManifest (read-only, no host damage). */
export const echoManifest = {
  name: "exec.echo",
  version: "1.0.0",
  description: "echo a line of text",
  action: "tool:invoke",
  resourcePattern: "exec/echo",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/** A valid `exec.ls` ToolManifest. */
export const lsManifest = {
  name: "exec.ls",
  version: "1.0.0",
  description: "list a path",
  action: "tool:invoke",
  resourcePattern: "exec/ls",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/** exec.echo binding: argvPrefix ["echo"], strict {text}, toArgv -> [text]. */
export const echoBinding: ExecToolBinding = {
  argvPrefix: ["echo"],
  argSchema: z.object({ text: z.string() }).strict(),
  toArgv: (a) => [(a as { text: string }).text],
};

/** exec.ls binding: argvPrefix ["ls"], strict {path}, toArgv -> [path]. */
export const lsBinding: ExecToolBinding = {
  argvPrefix: ["ls"],
  argSchema: z.object({ path: z.string() }).strict(),
  toArgv: (a) => [(a as { path: string }).path],
};

// ------------------------------------------------------------------------------------------------
// SLICE-HDI2a — read-only-safe additions. Each manifest is modeled EXACTLY on echoManifest/lsManifest
// (sideEffect:"read", idempotent, no approval, no bundle-ref); each binding holds a STRICT string-only
// argSchema + a pure `toArgv` so argv stays a pure string vector built in ONE place (never a shell
// string, never `sh -c`). PURE ADDITION: no governance is relaxed.
// ------------------------------------------------------------------------------------------------

/** A valid `exec.cat` ToolManifest (read-only). */
export const catManifest = {
  name: "exec.cat",
  version: "1.0.0",
  description: "print the contents of a file",
  action: "tool:invoke",
  resourcePattern: "exec/cat",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/** A valid `exec.head` ToolManifest (read-only; default 10 lines, no numeric arg — string-only). */
export const headManifest = {
  name: "exec.head",
  version: "1.0.0",
  description: "print the first lines of a file (default 10)",
  action: "tool:invoke",
  resourcePattern: "exec/head",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/** A valid `exec.pwd` ToolManifest (read-only; no args). */
export const pwdManifest = {
  name: "exec.pwd",
  version: "1.0.0",
  description: "print the working directory",
  action: "tool:invoke",
  resourcePattern: "exec/pwd",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/** A valid `exec.wc` ToolManifest (read-only). */
export const wcManifest = {
  name: "exec.wc",
  version: "1.0.0",
  description: "count lines, words, and bytes of a file",
  action: "tool:invoke",
  resourcePattern: "exec/wc",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/** A valid `exec.grep` ToolManifest (read-only). */
export const grepManifest = {
  name: "exec.grep",
  version: "1.0.0",
  description: "search a file for lines matching a pattern (with line numbers)",
  action: "tool:invoke",
  resourcePattern: "exec/grep",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/** exec.cat binding: argvPrefix ["cat"], strict {path}, toArgv -> [path]. */
export const catBinding: ExecToolBinding = {
  argvPrefix: ["cat"],
  argSchema: z.object({ path: z.string() }).strict(),
  toArgv: (a) => [(a as { path: string }).path],
};

/** exec.head binding: argvPrefix ["head"], strict {path}, toArgv -> [path] (head's own default 10 lines). */
export const headBinding: ExecToolBinding = {
  argvPrefix: ["head"],
  argSchema: z.object({ path: z.string() }).strict(),
  toArgv: (a) => [(a as { path: string }).path],
};

/** exec.pwd binding: argvPrefix ["pwd"], strict EMPTY object, toArgv -> []. */
export const pwdBinding: ExecToolBinding = {
  argvPrefix: ["pwd"],
  argSchema: z.object({}).strict(),
  toArgv: () => [],
};

/** exec.wc binding: argvPrefix ["wc"], strict {path}, toArgv -> [path]. */
export const wcBinding: ExecToolBinding = {
  argvPrefix: ["wc"],
  argSchema: z.object({ path: z.string() }).strict(),
  toArgv: (a) => [(a as { path: string }).path],
};

/**
 * exec.grep binding: argvPrefix ["grep","-n","-e"], strict {pattern, path}, toArgv -> [pattern, path].
 * The "-e" BEFORE the pattern guards a pattern that starts with "-" from being parsed as a grep flag —
 * pattern + path are LITERAL argv elements, never shell.
 */
export const grepBinding: ExecToolBinding = {
  argvPrefix: ["grep", "-n", "-e"],
  argSchema: z.object({ pattern: z.string(), path: z.string() }).strict(),
  toArgv: (a) => {
    const v = a as { pattern: string; path: string };
    return [v.pattern, v.path];
  },
};

// ------------------------------------------------------------------------------------------------
// SLICE-HDI2b — the ONE bounded GENERAL exec tool: the "maximum utility" capability (user-approved
// posture). Unlike the HDI2a whitelist (a fixed program per tool), `exec.run` lets the brain supply a
// FULL argv VECTOR and runs it DIRECTLY (argvPrefix [] + toArgv = the raw vector = execve argv[0] with
// args). It is NOT bounded by a program whitelist; it is bounded by the SEALED ephemeral
// zero-credential no-egress sandbox + the governance pipeline.
//
// WHY KEEPING THIS SAFE (and `requiresApproval:false`): the brain proposes a TOOL NAME + the DECLARED
// `argv` field — NEVER a shell string. argv is built in ONE place (binding.argvPrefix [] + toArgv) and
// passed VERBATIM as the process argv — there is NO shell, NEVER `sh -c` / `bash -c`. A "; rm -rf /"
// can only appear as an EXPLICIT literal token the brain typed into the vector (e.g. argv ["rm","-rf",
// "/"]); with no shell, it is just an argument — and even then it is bounded by the EPHEMERAL
// ZERO-CREDENTIAL NO-EGRESS sandbox (nothing to steal, no outbound network, destroyed after the loop).
// `requiresApproval` stays FALSE on purpose: the boundary is the governance pipeline + the SEALED
// sandbox, NOT an interactive gate — so the AUTONOMOUS loop can actually use this capability. The
// sandbox seal (zero credentials + no egress + ephemeral) is the deployment fact that makes it safe.
// `sideEffect:"write"` (it can mutate the ephemeral sandbox fs), `idempotent:false` (running a command
// is not idempotent in general).
// ------------------------------------------------------------------------------------------------

/** A valid `exec.run` ToolManifest — the bounded GENERAL exec tool (write to the ephemeral sandbox fs). */
export const runManifest = {
  name: "exec.run",
  version: "1.0.0",
  description: "run a command (an explicit argv vector — never a shell string) in the sandbox",
  action: "tool:invoke",
  resourcePattern: "exec/run",
  sideEffect: "write" as const,
  idempotent: false,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/**
 * exec.run binding: argvPrefix [] (NO fixed program), strict {argv: string[] (min 1)}, toArgv -> [...argv].
 * So the brain supplies the FULL argv vector and the effect runs `[...argvPrefix, ...toArgv] = [...argv]`
 * DIRECTLY — execve argv[0] with args, NEVER a shell string, NEVER `sh -c` / `bash -c`. The `.min(1)`
 * enforces a non-empty vector (an empty argv has no program to run). The `.strict()` rejects any smuggled
 * extra key (e.g. a `cmd` shell string) — the brain cannot smuggle a second argv channel.
 */
export const runBinding: ExecToolBinding = {
  argvPrefix: [],
  argSchema: z.object({ argv: z.array(z.string()).min(1) }).strict(),
  toArgv: (a) => [...(a as { argv: string[] }).argv],
  // SLICE-R9b-2b — exec.run is EFFECTFUL (sideEffect:"write"), so it declares a governance projector: a
  // thin wrapper that extracts the VALIDATED `{ argv }` and builds the R9b-1 credential-blind projection
  // the AGT advisory consumes. `buildProjectionForCall` only ever calls this AFTER `argSchema.safeParse`
  // succeeds, so `a` is the validated `{ argv: string[] }`. Read-only seed tools declare NONE.
  governanceProjector: (a) => buildExecRunProjection({ argv: (a as { argv: string[] }).argv }),
};

// ------------------------------------------------------------------------------------------------
// SLICE-CAP1 — the FIRST capability-breadth tool: an IN-SANDBOX FILE WRITE. The clean way to write a
// file without the content EVER touching argv/shell is `tee -- <path>` with the content delivered on
// STDIN as bytes (the `toStdin?` binding seam). argv is ALWAYS exactly ["tee","--",<path>] (a pure
// string vector — the `--` literal-guard, mirroring grep's `-e`, stops a `-`-leading path being parsed
// as a tee flag); the content is STDIN BYTES, so `"; rm -rf /"` is written as DATA, never interpreted.
//
// `sideEffect:"write"` (it mutates the ephemeral sandbox fs), `idempotent:false`, `requiresApproval:false`
// (same posture as exec.run: the boundary is the governance pipeline + the SEALED ephemeral zero-credential
// no-egress sandbox, NOT an interactive gate — and the write lands ONLY on the ephemeral sandbox fs,
// destroyed with the sandbox; it is NOT host-persistent — that is a later slice with a write-target
// allowlist). The content is SCREENED (credential-blind) but NOT projected to the AGT: the
// governanceProjector projects only the argv (tee/--/path = the write TARGET), never the content — the
// screen governs the content. `apply_patch` is deferred to a later slice.
// ------------------------------------------------------------------------------------------------

/** A valid `exec.write_file` ToolManifest — in-sandbox file write (content via stdin, never argv/shell). */
export const writeFileManifest = {
  name: "exec.write_file",
  version: "1.0.0",
  description: "write a file in the sandbox (content delivered via stdin, never argv/shell)",
  action: "tool:invoke",
  resourcePattern: "exec/write_file",
  sideEffect: "write" as const,
  idempotent: false,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/**
 * exec.write_file binding: argvPrefix ["tee","--"], strict {path, content}, toArgv -> [path] (content is
 * NOT in argv), toStdin -> the content's UTF-8 bytes. So argv is the pure vector ["tee","--",<path>] and
 * the content travels as STDIN BYTES — never a shell string, never an argv element. The `--` stops a
 * `-`-leading path being parsed as a tee flag; `path.min(1)` rejects an empty path; `.strict()` rejects
 * any smuggled extra key (e.g. an `argv`/`stdin` second channel).
 */
export const writeFileBinding: ExecToolBinding = {
  argvPrefix: ["tee", "--"],
  argSchema: z.object({ path: z.string().min(1), content: z.string() }).strict(),
  toArgv: (a) => [(a as { path: string }).path],
  toStdin: (a) => new TextEncoder().encode((a as { content: string }).content),
  // SLICE-CAP1 — exec.write_file is EFFECTFUL (sideEffect:"write"), so it declares a governance projector:
  // a thin wrapper that builds the R9b-1 credential-blind projection over the tool's ARGV (tee/--/path =
  // the write TARGET). The content is NOT projected (credential-blind: the screen governs the content;
  // the AGT advisory sees the target, not the bytes). `buildProjectionForCall` only calls this AFTER
  // `argSchema.safeParse` succeeds, so `a` is the validated `{ path, content }`.
  governanceProjector: (a) =>
    buildExecRunProjection({ argv: ["tee", "--", (a as { path: string }).path] }),
};

// ------------------------------------------------------------------------------------------------
// SLICE-CAP2 — the in-sandbox GIT FAMILY: the common git actions a real development loop needs — see +
// record version state (status/diff/log/add/commit). PURE ADDITION: each git tool is a manifest + a
// binding + registration — NO new primitive, NO converter extension, NO seal-punch.
//
// FIXED SUBCOMMAND: the git SUBCOMMAND (and every fixed flag) lives ONLY in the binding's `argvPrefix`
// (e.g. ["git","status","--porcelain"]). The brain proposes a tool NAME + DECLARED string args (path/
// message), NEVER the subcommand or a flag — it cannot inject one (`.strict()` rejects unknown keys; the
// read tools take the EMPTY strict object). argv is a pure string vector built in ONE place.
//
// NO SHELL: `git.add` puts the path AFTER `--` (mirroring grep's `-e` / write_file's `--`), so a
// `-`-leading or `"; rm -rf /"` path is a SINGLE LITERAL token — never a flag, never shell-interpreted.
// `git.commit` puts the message as the single `-m` argument — one literal token, never split, never a
// shell string.
//
// POSTURE: read tools (status/diff/log) are `sideEffect:"read"`, `idempotent:true`; add/commit are
// `sideEffect:"write"`, `idempotent:false`. ALL are `requiresApproval:false` — the same in-sandbox
// posture as exec.run/exec.write_file. A LOCAL in-sandbox commit is NOT destructive; the destructive/
// network edge is `git.push`, which is DEFERRED to Slice 5/6 (it needs the egress primitive + approval).
// Each write-or-read tool declares a `governanceProjector` wrapping `buildExecRunProjection` on the
// tool's argv (mirroring exec.run / exec.write_file).
// ------------------------------------------------------------------------------------------------

/** A valid `git.status` ToolManifest (read-only; in-sandbox version status). */
export const gitStatusManifest = {
  name: "git.status",
  version: "1.0.0",
  description: "show the in-sandbox git working-tree status (porcelain)",
  action: "tool:invoke",
  resourcePattern: "git/status",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/** A valid `git.diff` ToolManifest (read-only; working-tree diff). */
export const gitDiffManifest = {
  name: "git.diff",
  version: "1.0.0",
  description: "show the in-sandbox git working-tree diff",
  action: "tool:invoke",
  resourcePattern: "git/diff",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/** A valid `git.log` ToolManifest (read-only; last 50 commits, one line each). */
export const gitLogManifest = {
  name: "git.log",
  version: "1.0.0",
  description: "show the in-sandbox git log (oneline, last 50)",
  action: "tool:invoke",
  resourcePattern: "git/log",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/** A valid `git.add` ToolManifest (write; stage a path in the sandbox work-tree). */
export const gitAddManifest = {
  name: "git.add",
  version: "1.0.0",
  description: "stage a path in the in-sandbox git work-tree",
  action: "tool:invoke",
  resourcePattern: "git/add",
  sideEffect: "write" as const,
  idempotent: false,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/** A valid `git.commit` ToolManifest (write; in-sandbox commit — NOT destructive, NOT a push). */
export const gitCommitManifest = {
  name: "git.commit",
  version: "1.0.0",
  description: "record an in-sandbox git commit with a message (local only, never a push)",
  action: "tool:invoke",
  resourcePattern: "git/commit",
  sideEffect: "write" as const,
  idempotent: false,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox" as const,
};

/** git.status binding: argvPrefix ["git","status","--porcelain"], EMPTY strict object, toArgv -> []. */
export const gitStatusBinding: ExecToolBinding = {
  argvPrefix: ["git", "status", "--porcelain"],
  argSchema: z.object({}).strict(),
  toArgv: () => [],
  governanceProjector: () => buildExecRunProjection({ argv: ["git", "status", "--porcelain"] }),
};

/** git.diff binding: argvPrefix ["git","diff"], EMPTY strict object, toArgv -> []. */
export const gitDiffBinding: ExecToolBinding = {
  argvPrefix: ["git", "diff"],
  argSchema: z.object({}).strict(),
  toArgv: () => [],
  governanceProjector: () => buildExecRunProjection({ argv: ["git", "diff"] }),
};

/** git.log binding: argvPrefix ["git","log","--oneline","-n","50"] (HARD cap 50), EMPTY strict object. */
export const gitLogBinding: ExecToolBinding = {
  argvPrefix: ["git", "log", "--oneline", "-n", "50"],
  argSchema: z.object({}).strict(),
  toArgv: () => [],
  governanceProjector: () =>
    buildExecRunProjection({ argv: ["git", "log", "--oneline", "-n", "50"] }),
};

/**
 * git.add binding: argvPrefix ["git","add","--"], strict {path}, toArgv -> [path]. The `--` (mirroring
 * grep's `-e` / write_file's `--`) stops a `-`-leading path being parsed as a git flag — the path is a
 * SINGLE LITERAL argv token AFTER `--`, never shell. `path.min(1)` rejects an empty path; `.strict()`
 * rejects any smuggled extra key (e.g. an `argv` second channel).
 */
export const gitAddBinding: ExecToolBinding = {
  argvPrefix: ["git", "add", "--"],
  argSchema: z.object({ path: z.string().min(1) }).strict(),
  toArgv: (a) => [(a as { path: string }).path],
  // SLICE-CAP2 — git.add is EFFECTFUL (sideEffect:"write"), so it declares a governance projector: a thin
  // wrapper that builds the R9b-1 credential-blind projection over the tool's ARGV (git/add/--/path).
  // `buildProjectionForCall` only calls this AFTER `argSchema.safeParse` succeeds, so `a` is validated.
  governanceProjector: (a) =>
    buildExecRunProjection({ argv: ["git", "add", "--", (a as { path: string }).path] }),
};

/**
 * git.commit binding: argvPrefix ["git","commit","-m"], strict {message}, toArgv -> [message]. The
 * message is the SINGLE `-m` argument — ONE literal argv token, never split on spaces, never a shell
 * string. `message.min(1)` rejects an empty message; `.strict()` rejects any smuggled extra key.
 */
export const gitCommitBinding: ExecToolBinding = {
  argvPrefix: ["git", "commit", "-m"],
  argSchema: z.object({ message: z.string().min(1) }).strict(),
  toArgv: (a) => [(a as { message: string }).message],
  // SLICE-CAP2 — git.commit is EFFECTFUL (sideEffect:"write"), so it declares a governance projector over
  // the tool's ARGV (git/commit/-m/message). The message is screened (credential-blind) by the args screen.
  governanceProjector: (a) =>
    buildExecRunProjection({ argv: ["git", "commit", "-m", (a as { message: string }).message] }),
};

// ------------------------------------------------------------------------------------------------
// SLICE-CAP6 — the FIRST real network-egress tool: `net.fetch` (config/proxy-disabled `curl`). It DECLARES
// `containment:"network-egress"` (CAP3 demands "egress-allowlist" WIRED to register), and its URL is IN
// argv so `buildExecRunProjection` extracts `networkHosts = [URL host]` -> the bin egress fold (CAP5)
// gates it in-repo. (git.push's egress target is NOT argv-visible -> CAP6b.) Posture: read / non-idempotent
// / no-approval (a network READ is gated by EGRESS, not approval). Honest boundary: the egress GATING is
// real in-repo (the PDP networkHosts fold); real network reach + the SecretResolver-at-egress credential
// resolution are deploy/EXEC2-gated (unauthenticated-to-allowlisted until EXEC2). See CAP6-net-fetch.md.
// ------------------------------------------------------------------------------------------------

/** A valid `net.fetch` ToolManifest — the FIRST real network-egress tool (config/proxy-disabled curl). */
export const netFetchManifest = {
  name: "net.fetch",
  version: "1.0.0",
  description: "fetch a URL over the network (curl -sS -- <url>) — gated by the egress allowlist",
  action: "tool:invoke",
  resourcePattern: "net/fetch",
  sideEffect: "read" as const,
  idempotent: false,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "network-egress" as const,
};

/**
 * SLICE-CAP6 — the env var naming the OPTIONAL auth-token KEY net.fetch's `toEnv` emits a PLACEHOLDER for.
 * NON-secret config (it names a KEY, never a value). UNCONFIGURED (unset / blank) => NO auth env =>
 * net.fetch is unauthenticated-to-allowlisted (the EXEC2-until honest boundary). The KEY's real value is
 * resolved by OpenShell's SecretResolver at the sandbox egress boundary; agent-os only ever assembles the
 * PLACEHOLDER, never the secret.
 */
const NET_FETCH_AUTH_KEY_ENV = "AGENTOS_NET_FETCH_AUTH_KEY";

/**
 * A safe env-KEY shape: an UPPERCASE C-identifier (`[A-Z][A-Z0-9_]*`). This is the contract net.fetch's
 * auth key must satisfy. It deliberately excludes control names that alter curl's network/credential
 * behavior — proxy routing (`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`/`FTP_PROXY`), config home
 * (`CURL_HOME`/`HOME`/`CURLOPT_*`), CA bundle (`CURL_CA_BUNDLE`/`SSL_CERT_*`) — which are denied explicitly
 * below even though some match the shape.
 */
const SAFE_ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

/** Env names that would alter curl's network destination / TLS / config resolution — NEVER an auth key. */
const FORBIDDEN_AUTH_KEYS: ReadonlySet<string> = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FTP_PROXY",
  "CURL_HOME",
  "HOME",
  "CURL_CA_BUNDLE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/**
 * Build net.fetch's OPTIONAL auth env from a configured token KEY. PURE over its argument. The key MUST be
 * an uppercase C-identifier (`SAFE_ENV_KEY`) AND NOT a curl-control/proxy name (`FORBIDDEN_AUTH_KEYS`) —
 * otherwise it returns `{}` (fail-closed: an unsafe/blank/undefined key yields NO auth env, never a curl-
 * behavior-altering env). A valid key returns `{ [key]: placeholderForKey(key) }` — a CREDENTIAL
 * PLACEHOLDER in OpenShell's `openshell:resolve:env:<KEY>` grammar, NEVER a literal secret. This is the
 * seam EXEC2's SecretResolver-at-egress resolves; `makeExecEffect`'s INPUT guard PASSES the placeholder
 * and REJECTS any literal secret.
 */
export function netFetchAuthEnv(authKey: string | undefined): Readonly<Record<string, string>> {
  const key = (authKey ?? "").trim();
  if (key.length === 0) return {};
  if (!SAFE_ENV_KEY.test(key)) return {}; // not a plain uppercase env-key shape — deny
  if (FORBIDDEN_AUTH_KEYS.has(key)) return {}; // a curl-control/proxy name — never an auth key
  return { [key]: placeholderForKey(key) };
}

/**
 * A PLAIN DNS hostname (or localhost): dot-separated `[A-Za-z0-9-]` labels where the FINAL label (the TLD)
 * contains at least one LETTER, OR the literal `localhost`. The letter-in-TLD requirement DELIBERATELY
 * rejects dotted-numeric IPv4 literals (`127.0.0.1`) AND the AMBIGUOUS integer/octal/hex IP forms
 * (`2130706433` / `0x7f000001`) that the WHATWG parser normalizes to a DIFFERENT string than
 * `buildExecRunProjection`'s raw-token extraction sees. Bracketed IPv6 (`[::1]`) is rejected too (the `[`
 * is not in the label charset). The point: the host the PDP egress fold gates (the projection's raw token)
 * MUST equal the host curl connects to — admit ONLY a plain DNS name whose normalized + raw forms agree.
 */
const PLAIN_DNS_HOST = /^(?:localhost|(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*)$/;

/**
 * DENY-BY-DEFAULT URL validator: ONLY an absolute http/https URL whose authority is a PLAIN DNS hostname
 * (or localhost), with NO userinfo, NO port-only/IP-literal ambiguity. Closes the egress-bypass fail-open:
 *  - a no-authority scheme (file:///, mailto:, data:) / host-less URL projects NO networkHosts, so the bin
 *    egress fold (fires only for networkHosts.length > 0) would not gate it -> denied here;
 *  - an IP-literal / integer-IP host (`http://2130706433/`) where the WHATWG-normalized connect host
 *    (`127.0.0.1`) DIFFERS from the projection's raw token (`2130706433`) -> denied here (projected host
 *    MUST equal the real destination);
 *  - userinfo (`user:pass@host`) -> denied (a credential never rides the URL — use the toEnv placeholder).
 * Requiring a plain DNS host means EVERY admitted url's projected token == its curl connect host AND is
 * subject to the egress decision. Pure; fail-closed on any throw.
 *
 * EXPORTED (SLICE-ACT5a) so the BROWSER sub-family (`browser.navigate`) REUSES the IDENTICAL url
 * validator net.fetch / git.push use — one https-only / plain-DNS-host / no-userinfo / no-IP-literal
 * contract, never a parallel re-implementation that could drift.
 */
export function isAllowedFetchUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username.length > 0 || u.password.length > 0) return false;
  if (!PLAIN_DNS_HOST.test(u.hostname)) return false;
  // The projection extracts the raw authority token (up to the first /?#); require the raw host substring
  // to EQUAL the normalized host, so the gated token is byte-identical to the connect host (no normalization
  // skew). `URL` lowercases the host; we compare case-insensitively against the raw authority's host part.
  const rawAuthority = raw.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0] ?? "";
  const rawHost = (rawAuthority.split("@").pop() ?? "").split(":", 1)[0] ?? "";
  if (rawHost.toLowerCase() !== u.hostname.toLowerCase()) return false;
  return true;
}

/**
 * HARDENED net.fetch argv prefix. `-q` (FIRST, before any other flag) makes curl IGNORE every config file
 * (`.curlrc` / `-K`), so an agent that can write the sandbox fs (e.g. exec.write_file) CANNOT plant a
 * config that redirects/proxies the request to a host other than the one projected into networkHosts.
 * `--noproxy "*"` neutralizes ALL proxy env (HTTP(S)_PROXY/ALL_PROXY) so the real destination is the URL
 * host — NOT a proxy. `--globoff` disables curl URL globbing so `https://host/[1-1000]` is a LITERAL path
 * (no fan-out, no host-glob that would make the real destinations differ from the projected token). The
 * trailing `--` makes the url a SINGLE literal token (never a curl flag, never shell). So the PDP-projected
 * host == the real curl destination, the CAP6 egress claim holds.
 */
export const NET_FETCH_ARGV_PREFIX: readonly string[] = [
  "curl",
  "-q",
  "--globoff",
  "--noproxy",
  "*",
  "-sS",
  "--",
];

/**
 * net.fetch binding. argvPrefix = NET_FETCH_ARGV_PREFIX (config/proxy-disabled curl + `--` guard). The url
 * is validated by `isAllowedFetchUrl` (http/https + plain DNS host + no userinfo) so EVERY admitted url
 * produces a host subject to the egress fold. `.strict()` rejects a smuggled extra key. `toEnv` emits the
 * OPTIONAL credential PLACEHOLDER (never a literal secret; default unset => `{}`).
 *
 * `governanceProjector` builds the credential-blind projection over the argv, then OVERRIDES `networkHosts`
 * to the BARE `new URL(url).hostname` (NO port). The bin's egress allowlist (`AGENTOS_EGRESS_ALLOW`) is a
 * HOST list, so the gated token must be host-only: `https://api.allowed.example:443/x` projects
 * `api.allowed.example` and matches the allowlist entry `api.allowed.example` (a default OR non-default
 * port no longer needs a separate `host:port` allowlist entry). NON-VACUITY: remove this projector => no
 * networkHosts => the network-egress fail-closed gate denies (the destination is unknown).
 */
export const netFetchBinding: ExecToolBinding = {
  argvPrefix: NET_FETCH_ARGV_PREFIX,
  argSchema: z.object({ url: z.string().min(1).refine(isAllowedFetchUrl) }).strict(),
  toArgv: (a) => [(a as { url: string }).url],
  toEnv: () => netFetchAuthEnv(process.env[NET_FETCH_AUTH_KEY_ENV]),
  governanceProjector: (a) => {
    const url = (a as { url: string }).url;
    const base = buildExecRunProjection({ argv: [...NET_FETCH_ARGV_PREFIX, url] });
    // Override networkHosts to the BARE hostname (no port): the egress allowlist is host-based. The url is
    // already validated (http/https + plain DNS host), so `new URL` cannot throw here.
    return { ...base, networkHosts: [new URL(url).hostname] };
  },
};

// ------------------------------------------------------------------------------------------------
// SLICE-CAP6b — the FIRST real DESTRUCTIVE tool: `git.push` (`git push -- <url> <branch>`). It is the
// first tool that is BOTH `sideEffect:"destructive"` (=> the manifest superRefine FORCES
// `requiresApproval:true`) AND `containment:"network-egress"` (=> it punches the seal to the network and
// names its egress primitive). CAP2 DEFERRED it because a remote-NAME push is not argv-visible; CAP6b
// unblocks it by taking an EXPLICIT https URL (NOT a remote name) — so the URL host is IN argv and
// PROJECTABLE: the egress fold can gate it AND it clears CAP6's "network-egress with no projectable host =>
// deny" fail-closed rule (git.push HAS a host via the URL).
//
// requiredPrimitives (network-egress + destructive) => `["egress-allowlist","approval"]`. The bin wires
// BOTH, so git.push REGISTERS there; a composition missing EITHER primitive => CAP3 assertRegisterable
// refuses it (deny-by-default).
//
// NO SHELL / NO FLAG INJECTION: argv is ALWAYS exactly ["git","push","--",<url>,<branch>]. The `--`
// (mirroring git.add's `--`) makes a `-`-leading repo arg a SINGLE LITERAL token, never a `git push` flag
// (VERIFIED valid git syntax: `git push -- <repository> <refspec>` parses the repo as a pathname, and a
// `--upload-pack=evil` AFTER `--` is rejected as a "strange pathname", never executed as a flag). The
// branch is a strictly-validated literal token (`^[A-Za-z0-9._/-]+$`, no leading `-`), so it can never be
// coerced into a flag (`--force`/`-d`) either — defense-in-depth on top of the positional ordering.
//
// CREDENTIAL-BLIND: `toEnv` emits ONLY a credential PLACEHOLDER (`placeholderForKey`, NEVER a literal
// secret); the url is validated by the SAME `isAllowedFetchUrl` net.fetch uses (rejects userinfo), and the
// projection's networkHosts is host-ONLY. `governanceProjector` reuses net.fetch's EXACT hostname
// projection (`new URL(url).hostname`, NOT buildExecRunProjection's raw token), so the projected host ==
// git's real connect host AND matches a host-only egress allowlist entry.
//
// HONEST BOUNDARY: the approval gate + egress gate + boundary record + credential placeholder are REAL
// in-repo (fake-proven). The real push reaching a remote + the SecretResolver-at-egress credential
// resolution are deploy/EXEC2-gated (git.push is unauthenticated-to-allowlisted until EXEC2). git in the
// sandbox is a deploy fact. Remote-name push, SSH URLs, and real auth are OUT OF SCOPE.
// ------------------------------------------------------------------------------------------------

/** A valid `git.push` ToolManifest — the FIRST real DESTRUCTIVE + network-egress tool (https URL, approval-gated). */
export const gitPushManifest = {
  name: "git.push",
  version: "1.0.0",
  description:
    "push a branch to an https git remote (git push -- <url> <branch>) — egress + approval gated",
  action: "tool:invoke",
  resourcePattern: "git/push",
  sideEffect: "destructive" as const,
  idempotent: false,
  // FORCED true by the manifest superRefine (sideEffect "destructive" => requiresApproval:true). A
  // destructive tool can NEVER escape the approval gate; set it true to satisfy parseToolManifest.
  requiresApproval: true,
  bundleRefOnly: false,
  containment: "network-egress" as const,
};

/**
 * SLICE-CAP6b — the env var naming the OPTIONAL git-credential KEY git.push's `toEnv` emits a PLACEHOLDER
 * for. NON-secret config (it names a KEY, never a value). UNCONFIGURED (unset / blank) => NO auth env =>
 * git.push is unauthenticated-to-allowlisted (the EXEC2-until honest boundary, mirroring net.fetch). The
 * KEY's real value is resolved by OpenShell's SecretResolver at the sandbox egress boundary; agent-os only
 * ever assembles the PLACEHOLDER, never the secret. Reuses net.fetch's SAFE_ENV_KEY shape + the fail-closed
 * `netFetchAuthEnv` builder (an uppercase C-identifier that is NOT a curl/proxy-control name).
 */
const GIT_PUSH_AUTH_KEY_ENV = "AGENTOS_GIT_PUSH_AUTH_KEY";

/**
 * The strict branch-name validator: a `git` ref-name shape — dot/slash/dash/underscore + alphanumerics —
 * that does NOT start with `-`. The leading-`-` exclusion is the NO-FLAG-INJECTION guard: a branch can
 * never be `--force` / `-d` / `--mirror` / `--delete` (a `git push` flag). The charset excludes whitespace
 * and shell metacharacters, so the branch is always a SINGLE literal argv token. (This is intentionally
 * stricter than full git ref-name rules — it is an allowlist, not a denylist; exotic but legal ref names
 * are out of scope for this slice and can widen later if needed.)
 */
const SAFE_BRANCH_NAME = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/**
 * git.push binding. argvPrefix = ["git","push","--"] (the `--` guard, VERIFIED valid `git push` syntax).
 * The url is validated by the SAME `isAllowedFetchUrl` net.fetch uses (http/https + plain DNS host + no
 * userinfo), so every admitted url produces a host subject to the egress fold AND the projected host equals
 * git's real connect host. The branch is validated by `SAFE_BRANCH_NAME` (no leading `-` => no flag
 * injection). `.strict()` rejects any smuggled extra key. `toArgv` -> [url, branch] (two literal tokens
 * after `--`). `toEnv` emits the OPTIONAL credential PLACEHOLDER (never a literal secret; default unset =>
 * `{}`), reusing net.fetch's fail-closed `netFetchAuthEnv` key validator.
 *
 * `governanceProjector` builds the credential-blind projection over the argv, then OVERRIDES `networkHosts`
 * to the BARE `new URL(url).hostname` (NO port) — the EXACT net.fetch pattern (NOT buildExecRunProjection's
 * raw token), so the gated token is host-only and equals git's real connect host. NON-VACUITY: remove this
 * projector => no networkHosts => the network-egress fail-closed gate denies (the destination is unknown).
 */
export const gitPushBinding: ExecToolBinding = {
  argvPrefix: ["git", "push", "--"],
  argSchema: z
    .object({
      // SLICE-EXEC-HARDENING (CAP6b MINOR) — `.max(2048)` is a reasonable upper bound on a git remote URL
      // (a cheap DoS/abuse hardening). Pure tightening: every existing short url is unaffected (the cap is
      // an upper bound, not a relaxation); it is layered alongside the existing `isAllowedFetchUrl` refine.
      url: z.string().min(1).max(2048).refine(isAllowedFetchUrl),
      // SLICE-EXEC-HARDENING (CAP6b MINOR) — `.max(255)` caps the branch at the git ref practical limit,
      // AFTER the SAFE_BRANCH_NAME charset/no-flag guard. Pure tightening: every existing short branch is
      // unaffected; only an over-length (>255-char) branch is newly rejected.
      branch: z.string().regex(SAFE_BRANCH_NAME).max(255),
    })
    .strict(),
  toArgv: (a) => {
    const v = a as { url: string; branch: string };
    return [v.url, v.branch];
  },
  toEnv: () => netFetchAuthEnv(process.env[GIT_PUSH_AUTH_KEY_ENV]),
  governanceProjector: (a) => {
    const url = (a as { url: string }).url;
    const branch = (a as { branch: string }).branch;
    const base = buildExecRunProjection({ argv: ["git", "push", "--", url, branch] });
    // Override networkHosts to the BARE hostname (no port): the egress allowlist is host-based. The url is
    // already validated (http/https + plain DNS host), so `new URL` cannot throw here.
    return { ...base, networkHosts: [new URL(url).hostname] };
  },
};

/**
 * A fresh ToolRegistry holding the seed exec tools (so authorize can admit only these names).
 * SLICE-HDI2a grew this from the two EXEC3a tools to the read-only-safe set; SLICE-HDI2b adds the ONE
 * bounded general exec tool `exec.run`; SLICE-CAP1 adds the FIRST capability-breadth tool `exec.write_file`;
 * SLICE-CAP2 adds the in-sandbox GIT FAMILY (git.status/diff/log/add/commit); SLICE-CAP6 adds the FIRST
 * real network-egress tool `net.fetch` — but ONLY when egress is WIRED + enforced (see below). `git.push`
 * is DEFERRED (CAP6b — egress not argv-visible).
 *
 * SLICE-CAP4b — OPTIONAL params so the BIN (the autonomous path) can (a) build the registry with a `wired`
 * set INCLUDING "approval" (because it injects an `approve` seam — coupled: an approve seam ⟺ "approval"
 * wired for THIS registry), and (b) add EXTRA seed tools (e.g. a destructive approval-requiring tool that
 * could not register without "approval" wired). BOTH default to today's values (`WIRED_PRIMITIVES` empty +
 * no extras), so every existing `seedRegistry()` call is byte-identical (the 14 in-sandbox seed tools
 * require NO primitive, so they register under any wired set).
 *
 * SLICE-CAP6 — `net.fetch` (`containment:"network-egress"`) is registered ONLY when the composition's
 * `wired` set actually contains "egress-allowlist". This keeps "a WIRED primitive ⟺ enforcement is
 * present" HONEST: net.fetch appears ONLY in a composition that has wired egress (the BIN, which folds the
 * egress decision in its authorize closure). A composition that has NOT wired egress (the DEFAULT
 * `seedRegistry()` over the empty `WIRED_PRIMITIVES`) does NOT register net.fetch at all — exactly the
 * CAP3 ordering ("composition without egress wired refuses the network-egress tool"). The 14 in-sandbox
 * tools are byte-identical (they require no primitive).
 */
export function seedRegistry(
  wired: ReadonlySet<Primitive> = WIRED_PRIMITIVES,
  extra: readonly unknown[] = [],
): ToolRegistry {
  const r = new ToolRegistry(undefined, wired);
  r.register(echoManifest);
  r.register(lsManifest);
  r.register(catManifest);
  r.register(headManifest);
  r.register(pwdManifest);
  r.register(wcManifest);
  r.register(grepManifest);
  r.register(runManifest);
  r.register(writeFileManifest);
  r.register(gitStatusManifest);
  r.register(gitDiffManifest);
  r.register(gitLogManifest);
  r.register(gitAddManifest);
  r.register(gitCommitManifest);
  // SLICE-CAP6 — net.fetch (network-egress) registers ONLY where egress is WIRED + enforced (the bin). A
  // composition without "egress-allowlist" wired never sees it (the CAP3 ordering — and the egress fold,
  // which lives in the bin authorize closure, is the matching enforcement). Defense-in-depth: even if it
  // were registered here, the ToolRegistry's own CAP3 gate would THROW without the primitive wired.
  if (wired.has("egress-allowlist")) r.register(netFetchManifest);
  // SLICE-CAP6b — git.push (network-egress + destructive) registers ONLY where BOTH "egress-allowlist" AND
  // "approval" are WIRED + enforced (the bin). It is the FIRST destructive tool: a composition missing
  // EITHER primitive never sees it (the CAP3 ordering — egress fold + approval stage are the matching
  // enforcement). Defense-in-depth: even if registered here, the ToolRegistry's CAP3 gate would THROW
  // without BOTH primitives wired (network-egress needs egress-allowlist; destructive needs approval).
  if (wired.has("egress-allowlist") && wired.has("approval")) r.register(gitPushManifest);
  for (const m of extra) r.register(m);
  return r;
}

/**
 * The composer-held bindings map for the seed exec tools (parallel to the registry). SLICE-CAP4b — an
 * OPTIONAL `extra` map of (name -> binding) so the BIN can add the binding for an extra seed tool
 * (parallel to `seedRegistry`'s `extra`). Default empty => byte-identical to today (the 14 seed tools).
 *
 * SLICE-CAP6 — `net.fetch`'s binding is included ONLY when the composition's `wired` set contains
 * "egress-allowlist" (PARALLEL to `seedRegistry`'s conditional registration). The MCP server advertises
 * EXACTLY the `seedBindings()` keys, so a tool advertised WITHOUT egress enforcement would be unsafe; and
 * a binding with no corresponding registered manifest would be inert. `wired` is the SECOND optional param
 * (after `extra`) so every existing `seedBindings()` / `seedBindings(extra)` call is byte-identical (empty
 * `WIRED_PRIMITIVES` => the 14-tool map). The bin passes its `{"approval","egress-allowlist"}` superset =>
 * the 15-tool map including net.fetch.
 */
export function seedBindings(
  extra: ReadonlyMap<string, ExecToolBinding> = new Map(),
  wired: ReadonlySet<Primitive> = WIRED_PRIMITIVES,
): ReadonlyMap<string, ExecToolBinding> {
  const entries: [string, ExecToolBinding][] = [
    ["exec.echo", echoBinding],
    ["exec.ls", lsBinding],
    ["exec.cat", catBinding],
    ["exec.head", headBinding],
    ["exec.pwd", pwdBinding],
    ["exec.wc", wcBinding],
    ["exec.grep", grepBinding],
    ["exec.run", runBinding],
    ["exec.write_file", writeFileBinding],
    ["git.status", gitStatusBinding],
    ["git.diff", gitDiffBinding],
    ["git.log", gitLogBinding],
    ["git.add", gitAddBinding],
    ["git.commit", gitCommitBinding],
  ];
  // SLICE-CAP6 — net.fetch's binding (and thus its tools/list advertisement) appears ONLY where egress is
  // wired + enforced (PARALLEL to seedRegistry's conditional registration). No egress wired => not
  // advertised, not invocable (its manifest is also not registered).
  if (wired.has("egress-allowlist")) entries.push(["net.fetch", netFetchBinding]);
  // SLICE-CAP6b — git.push's binding (and thus its tools/list advertisement) appears ONLY where BOTH
  // egress AND approval are wired + enforced (PARALLEL to seedRegistry's conditional registration). A
  // composition missing EITHER primitive advertises neither git.push's binding nor its manifest — "a
  // WIRED primitive ⟺ enforcement present" stays honest for the FIRST destructive tool.
  if (wired.has("egress-allowlist") && wired.has("approval"))
    entries.push(["git.push", gitPushBinding]);
  return new Map<string, ExecToolBinding>([...entries, ...extra]);
}
