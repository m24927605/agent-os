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
import { buildExecRunProjection } from "../../../../policy/index.js";
import { ToolRegistry } from "../../../../tools/index.js";
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

/**
 * A fresh ToolRegistry holding the seed exec tools (so authorize can admit only these names).
 * SLICE-HDI2a grew this from the two EXEC3a tools to the read-only-safe set; SLICE-HDI2b adds the ONE
 * bounded general exec tool `exec.run`; SLICE-CAP1 adds the FIRST capability-breadth tool `exec.write_file`;
 * SLICE-CAP2 adds the in-sandbox GIT FAMILY (git.status/diff/log/add/commit). `git.push` is DEFERRED.
 */
export function seedRegistry(): ToolRegistry {
  const r = new ToolRegistry();
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
  return r;
}

/** The composer-held bindings map for the seed exec tools (parallel to the registry). */
export function seedBindings(): ReadonlyMap<string, ExecToolBinding> {
  return new Map<string, ExecToolBinding>([
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
  ]);
}
