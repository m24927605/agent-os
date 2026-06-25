/**
 * SLICE-CAP2 — the in-sandbox GIT FAMILY (`git.status` / `git.diff` / `git.log` / `git.add` /
 * `git.commit`) — RED-first.
 *
 * The SECOND capability-breadth slice. CAP1 added an in-sandbox FILE WRITE; CAP2 adds the common git
 * actions a real development loop needs — see/record version state — as PURE ADDITIONS: each git tool =
 * a manifest + an ExecToolBinding (a FIXED `argvPrefix` with the subcommand baked in) + registration in
 * `seedRegistry()`/`seedBindings()`. NO new primitive, NO converter extension, NO seal-punch.
 *
 *   - FIXED SUBCOMMAND — the brain proposes a tool NAME + DECLARED string args (path/message), NEVER the
 *     git subcommand or a flag. The subcommand lives ONLY in the binding's `argvPrefix` (e.g.
 *     ["git","status","--porcelain"]); the brain cannot inject a subcommand or a flag.
 *   - NO SHELL — argv is a pure string vector. `git.add` puts the path AFTER `--` (mirroring grep's `-e`
 *     / write_file's `--`), so a `-`-leading or `"; rm -rf /"` path is a SINGLE LITERAL token, never a
 *     flag, never shell-interpreted. `git.commit` puts the message as the single `-m` argument — one
 *     literal token, never split, never a shell string.
 *   - STRICT DENY — `.strict()` rejects any smuggled extra key; the read tools take the EMPTY strict
 *     object (any extra key denies).
 *   - CREDENTIAL-BLIND — a secret-shaped path/message is denied at the screen (it is a DECLARED arg the
 *     credential-blind screen sees); the substrate is NEVER called.
 *   - COMMIT-BEFORE-EFFECT — the write-class tools (add/commit) are effectful; the audit receipt is
 *     appended BEFORE the substrate exec.
 *
 * HONEST BOUNDARY: this is IN-SANDBOX git ONLY — every action runs in the ephemeral sandbox against the
 * sandbox work-tree and is destroyed with the sandbox. A local in-sandbox commit is NOT destructive;
 * `git.push` is the network/destructive edge and is DEFERRED to Slice 5/6 (it is NOT in this slice). The
 * git binary + a git work-tree are a sandbox/deploy fact. All assertions run against a FAKE substrate
 * that RECORDS the exec request (argv). NO live, NO real Hermes, NO real drive, NO AGENTOS_LIVE_*.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../../audit/index.js";
import type { CommitAppender } from "../../../../commitgate/index.js";
import { type CostGate, InMemoryCostGate } from "../../../../cost/index.js";
import { authorizeToolInvoke } from "../../../../tools/index.js";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
} from "../../../substrate/index.js";
import { makeArgsCredentialScreen } from "./args-credential-screen.js";
import {
  gitAddBinding,
  gitAddManifest,
  gitCommitBinding,
  gitCommitManifest,
  gitDiffBinding,
  gitDiffManifest,
  gitLogBinding,
  gitLogManifest,
  gitStatusBinding,
  gitStatusManifest,
  seedBindings,
  seedRegistry,
} from "./exec-seed-tools.js";
import {
  type ExecMcpServerDeps,
  argSchemaToJsonSchema,
  createExecMcpServer,
} from "./mcp/exec-mcp-server.js";

const validCtx = {
  actorId: "agent:hermes",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

/** The repo's real detector (same construction as every bootstrap): secret-shaped iff redact changes it. */
const detectSecret = (v: unknown): boolean =>
  JSON.stringify(redactSecrets(v)) !== JSON.stringify(v);

/** Runtime-built secret canary matching audit/redact's `sk-...` shape (NOT a source literal). */
function secretCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`; // 24 alnum chars => matches /sk-[A-Za-z0-9]{16,}/
}

/** A runtime-built injection-shaped path (NOT a source literal so secret-scan stays clean). */
function injectionPath(): string {
  return `${["; rm", "-rf /"].join(" ")}\n-rf`;
}

/** A runtime-built shell-metachar / multiline commit message (NOT a source literal). */
function injectionMessage(): string {
  return `${["fix: foo", "; rm", "-rf /"].join(" ")} && echo $(whoami)\n-rf`;
}

// --- a spying Fake substrate: records lifecycle + exec calls (argv + stdin + env) ----------------
class SpyFakeSandboxAdapter extends FakeSandboxAdapter {
  readonly execCalls: ExecCommandSpec[] = [];
  override createSandbox(ctx: unknown, spec: SandboxSpec): Promise<AdapterResult> {
    return super.createSandbox(ctx, spec);
  }
  override execSandbox(
    ctx: unknown,
    sandboxId: string,
    spec: ExecCommandSpec,
  ): Promise<ExecResult> {
    this.execCalls.push(spec);
    return super.execSandbox(ctx, sandboxId, spec);
  }
}

interface ServerKit {
  readonly deps: ExecMcpServerDeps;
  readonly substrate: SpyFakeSandboxAdapter;
  readonly appendCalls: unknown[];
  readonly effectOrder: string[];
}

/** Build a fully-governed MCP server deps kit over a Fake substrate (mirrors the EXEC4a server kit). */
async function makeServerKit(): Promise<ServerKit> {
  const substrate = new SpyFakeSandboxAdapter();
  const created = (await substrate.createSandbox(validCtx, { image: "x" })) as {
    sandboxId: string;
  };
  await substrate.startSandbox(validCtx, created.sandboxId);
  const registry = seedRegistry();
  const bindings = seedBindings();
  const appendCalls: unknown[] = [];
  const effectOrder: string[] = [];
  let receiptId = 0;
  const cost: CostGate = new InMemoryCostGate(1_000_000);
  const appender: CommitAppender<unknown, { id: number }> = {
    append: (event) => {
      appendCalls.push(event);
      effectOrder.push("append");
      return Promise.resolve({ id: ++receiptId });
    },
  };
  const allowRules = [
    { id: "allow-exec", action: "tool:invoke", resource: "exec.**", tenantId: "tenant-a" },
    // CAP2 — mirror the production bin (exec-mcp-server-bin.ts): a SECOND allow rule admits the git family
    // (OR-combined). git.push is NOT registered, so deny-by-default still blocks it (no rule can admit an
    // unregistered name).
    { id: "allow-git", action: "tool:invoke", resource: "git.**", tenantId: "tenant-a" },
  ];
  const deps: ExecMcpServerDeps = {
    substrate,
    sandboxId: created.sandboxId,
    bindings,
    registry,
    screen: makeArgsCredentialScreen(detectSecret),
    authorize: (tc) => {
      const c = tc.context as typeof validCtx;
      const decision = authorizeToolInvoke(
        {
          requestId: c.requestId,
          tenantId: c.tenantId,
          projectId: c.projectId,
          taskId: c.taskId,
          actorId: c.actorId,
          action: "tool:invoke",
          resource: tc.tool,
        },
        registry,
        allowRules,
      );
      return { effect: decision.effect, reason: decision.reason };
    },
    cost,
    estimateTokens: () => 10,
    appender,
    detectSecret,
    onEffect: () => effectOrder.push("effect"),
    context: validCtx,
  };
  return { deps, substrate, appendCalls, effectOrder };
}

// ==================================================================================================
// CAP2-(a) FIXED SUBCOMMAND + NO SHELL — each git tool builds its EXACT argv from the binding (the fixed
//          argvPrefix with the subcommand baked in + the declared string arg, AFTER the `--`/`-m`). The
//          read tools build argv == the fixed prefix; add/commit append the SINGLE literal arg token.
//          NON-VACUITY: a toArgv/argvPrefix mutation that dropped the subcommand, dropped the `--`/`-m`,
//          or split the message into multiple tokens flips the argv assertion RED.
// ==================================================================================================
describe("CAP2-(a) each git tool builds its EXACT argv from the binding (fixed subcommand, no shell)", () => {
  const cases: { name: string; args: Record<string, unknown>; argv: string[] }[] = [
    { name: "git.status", args: {}, argv: ["git", "status", "--porcelain"] },
    { name: "git.diff", args: {}, argv: ["git", "diff"] },
    { name: "git.log", args: {}, argv: ["git", "log", "--oneline", "-n", "50"] },
    { name: "git.add", args: { path: "src/x.ts" }, argv: ["git", "add", "--", "src/x.ts"] },
    {
      name: "git.commit",
      args: { message: "feat: thing" },
      argv: ["git", "commit", "-m", "feat: thing"],
    },
  ];

  for (const { name, args, argv } of cases) {
    it(`${name} -> argv ${JSON.stringify(argv)}; isError:false; commit-before-effect`, async () => {
      const { deps, substrate, appendCalls, effectOrder } = await makeServerKit();
      const server = createExecMcpServer(deps);

      const resp = await server.handle({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name, arguments: args },
      });
      expect(resp.error).toBeUndefined();
      const result = resp.result as { isError: boolean; content: { type: string; text: string }[] };

      expect(result.isError).toBe(false);
      // The argv was built FROM THE BINDING (fixed prefix + the declared arg) — never the brain's raw args.
      expect(substrate.execCalls.length).toBe(1);
      expect(substrate.execCalls[0]?.argv).toEqual(argv);
      // The Fake echoes the joined argv -> the content carries the real-ish output.
      expect(result.content[0]?.text).toContain(argv.join(" "));
      // commit-before-effect holds for BOTH read + write tools (every git tool rides the same pipeline).
      expect(appendCalls.length).toBe(1);
      expect(effectOrder).toEqual(["append", "effect"]);
    });
  }
});

// ==================================================================================================
// CAP2-(b) ⚠️ NO-SHELL / FIXED-SUBCOMMAND (the CORE, non-vacuous invariant). A `git.add` path containing
//          `"; rm -rf /\n-rf"` reaches the substrate as argv EXACTLY ["git","add","--",<that string>] —
//          the path is a SINGLE literal token AFTER `--`, never a flag, never shell-interpreted. A
//          `git.commit` message containing shell metachars + a newline reaches the substrate as argv
//          EXACTLY ["git","commit","-m",<that string>] — one literal token.
//          NON-VACUITY: a mutation that splits the message into multiple tokens (e.g. message.split(" "))
//          or drops the `--`/`-m`/subcommand prefix flips these RED — the path/message is verified to be
//          ONE element at a FIXED index, with the prefix exactly preserved.
// ==================================================================================================
describe("CAP2-(b) git.add path / git.commit message are SINGLE literal argv tokens (never a flag, never shell)", () => {
  it("git.add path = `\"; rm -rf /\\n-rf\"` -> argv EXACTLY ['git','add','--',<path>] (literal, after --)", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);
    const path = injectionPath();

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "git.add", arguments: { path } },
    });
    const result = resp.result as { isError: boolean };
    expect(result.isError).toBe(false);

    expect(substrate.execCalls.length).toBe(1);
    const ranArgv = substrate.execCalls[0]?.argv ?? [];
    // The fixed prefix is preserved EXACTLY, and the dangerous path is ONE literal token AFTER `--`.
    expect(ranArgv).toEqual(["git", "add", "--", path]);
    expect(ranArgv.slice(0, 3)).toEqual(["git", "add", "--"]); // subcommand + `--` guard intact
    expect(ranArgv[3]).toBe(path); // the WHOLE path is a SINGLE element (never split into tokens)
    expect(ranArgv.length).toBe(4); // no token was split off
    // No shell wrapper sneaked in; the path is never parsed as a flag (it sits after `--`).
    expect(ranArgv).not.toContain("sh");
    expect(ranArgv).not.toContain("-c");
  });

  it("git.commit message = shell-metachar/multiline -> argv EXACTLY ['git','commit','-m',<message>] (one token)", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);
    const message = injectionMessage();

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "git.commit", arguments: { message } },
    });
    const result = resp.result as { isError: boolean };
    expect(result.isError).toBe(false);

    expect(substrate.execCalls.length).toBe(1);
    const ranArgv = substrate.execCalls[0]?.argv ?? [];
    // The fixed prefix is preserved EXACTLY, and the metachar/multiline message is ONE literal `-m` arg.
    expect(ranArgv).toEqual(["git", "commit", "-m", message]);
    expect(ranArgv.slice(0, 3)).toEqual(["git", "commit", "-m"]); // subcommand + `-m` flag intact
    expect(ranArgv[3]).toBe(message); // the WHOLE message is a SINGLE element (never split on spaces)
    expect(ranArgv.length).toBe(4); // message stays one token — no split into multiple argv elements
    expect(ranArgv).not.toContain("sh");
    expect(ranArgv).not.toContain("-c");
  });
});

// ==================================================================================================
// CAP2-(c) STRICT DENY — an unknown/extra key is rejected by the strict argSchema; the substrate is NOT
//          called. The read tools take the EMPTY strict object, so ANY extra key denies; add/commit deny
//          a smuggled second channel (e.g. argv) or a missing/empty required arg.
//          NON-VACUITY: a non-strict argSchema would ADMIT the extra key -> the deny assertion flips RED.
// ==================================================================================================
describe("CAP2-(c) a smuggled/extra/missing key is rejected by the strict argSchema (substrate 0 calls)", () => {
  const cases: { label: string; name: string; args: Record<string, unknown> }[] = [
    // read tools: the EMPTY strict object rejects ANY extra key.
    { label: "git.status extra key", name: "git.status", args: { argv: "; rm -rf /" } },
    { label: "git.diff extra key", name: "git.diff", args: { path: "x" } },
    { label: "git.log extra key", name: "git.log", args: { n: "999" } },
    // add/commit: a smuggled second channel, or a missing/empty required arg.
    { label: "git.add smuggled argv", name: "git.add", args: { path: "f", argv: "; rm -rf /" } },
    { label: "git.add missing path", name: "git.add", args: {} },
    { label: "git.add empty path (min 1)", name: "git.add", args: { path: "" } },
    {
      label: "git.commit smuggled argv",
      name: "git.commit",
      args: { message: "m", argv: "; rm -rf /" },
    },
    { label: "git.commit missing message", name: "git.commit", args: {} },
    { label: "git.commit empty message (min 1)", name: "git.commit", args: { message: "" } },
  ];

  for (const { label, name, args } of cases) {
    it(`${label} -> isError:true, execSandbox 0 calls`, async () => {
      const { deps, substrate } = await makeServerKit();
      const server = createExecMcpServer(deps);

      const resp = await server.handle({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const result = resp.result as { isError: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      // The strict argSchema rejected it BEFORE the effect — the substrate saw 0 calls.
      expect(substrate.execCalls.length).toBe(0);
      expect(result.content[0]?.text).not.toContain("rm -rf");
    });
  }
});

// ==================================================================================================
// CAP2-(d) ⚠️ CREDENTIAL-BLIND — a git.add path / git.commit message with a SECRET-SHAPED value
//          (runtime-built sk- canary) is denied at the screen (the path/message is a DECLARED arg the
//          credential-blind screen sees); the substrate is NOT called and the canary never egresses.
//          NON-VACUITY: removing the credential-blind screen would let the secret reach the effect -> RED.
// ==================================================================================================
describe("CAP2-(d) a secret-shaped path/message is denied@screen (substrate 0 calls, canary never egresses)", () => {
  const cases: { name: string; field: string }[] = [
    { name: "git.add", field: "path" },
    { name: "git.commit", field: "message" },
  ];

  for (const { name, field } of cases) {
    it(`${name} {${field}:<canary>} -> isError:true, denied@screen, execSandbox 0 calls`, async () => {
      const { deps, substrate } = await makeServerKit();
      const server = createExecMcpServer(deps);
      const canary = secretCanary();

      const resp = await server.handle({
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name, arguments: { [field]: canary } },
      });
      const result = resp.result as { isError: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("screen");
      // The screen denied BEFORE the effect — the substrate never saw the call, canary never egresses.
      expect(substrate.execCalls.length).toBe(0);
      expect(result.content[0]?.text).not.toContain(canary);
    });
  }
});

// ==================================================================================================
// CAP2-(e) COMMIT-BEFORE-EFFECT — drive git.commit through the governed pipeline (runGovernedToolCall, via
//          the MCP server's single execution edge). The AuditEvent receipt is appended BEFORE the substrate
//          exec (commit is effectful, sideEffect:"write").
//          NON-VACUITY: an effect-before-commit ordering would make effectOrder ["effect","append"] -> RED.
// ==================================================================================================
describe("CAP2-(e) git.commit commit-before-effect (receipt appended BEFORE the substrate exec)", () => {
  it("the AuditEvent receipt is appended BEFORE the effect runs", async () => {
    const { deps, substrate, appendCalls, effectOrder } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "git.commit", arguments: { message: "chore: snapshot" } },
    });
    const result = resp.result as { isError: boolean };
    expect(result.isError).toBe(false);

    // The effect RAN (the commit reached the substrate) — non-vacuity for the ordering assertion.
    expect(substrate.execCalls.length).toBe(1);
    // commit-before-effect: append happened, exactly once, BEFORE the effect.
    expect(appendCalls.length).toBe(1);
    expect(effectOrder).toEqual(["append", "effect"]);
  });
});

// ==================================================================================================
// CAP2-(f) ADVERTISE — tools/list now advertises ALL 14 tools (the 9 existing + the 5 git). The read git
//          tools advertise the EMPTY strict object schema; add/commit advertise their {path}/{message}
//          schema, each BYTE-DERIVED from the binding's strict argSchema (single source of truth). An
//          UNREGISTERED git-shaped name is denied (deny-by-default).
//          NON-VACUITY: the exact-set assertion flips RED if a git tool were missing or an extra advertised;
//          a hand-written/drifted schema would diverge from argSchemaToJsonSchema(binding).
// ==================================================================================================
// SLICE-CAP6's net.fetch (network-egress) is NOT here: this kit uses the DEFAULT (egress-UNWIRED)
// seedRegistry()/seedBindings(); net.fetch registers + advertises ONLY where egress is WIRED + enforced
// (the bin — see exec-mcp-server-bin.cap6.test.ts).
const FULL_SEED_SET_14 = [
  "exec.cat",
  "exec.echo",
  "exec.grep",
  "exec.head",
  "exec.ls",
  "exec.pwd",
  "exec.run",
  "exec.wc",
  "exec.write_file",
  "git.add",
  "git.commit",
  "git.diff",
  "git.log",
  "git.status",
];

describe("CAP2-(f) tools/list advertises all 14 tools (9 + 5 git), each schema-derived; unregistered denied", () => {
  it("returns exactly the 14 bounded seed tools, each inputSchema BYTE-DERIVED from its strict argSchema", async () => {
    const { deps } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(resp.error).toBeUndefined();
    const tools = (resp.result as { tools: { name: string; inputSchema: unknown }[] }).tools;

    // EXACTLY the 14 bounded seed tools — nothing else (no git.push, no fs/terminal/raw-argv/shell).
    expect(tools.map((t) => t.name).sort()).toEqual(FULL_SEED_SET_14);
    const names = tools.map((t) => t.name);
    // git.push is the network/destructive edge — DEFERRED to Slice 5/6, NOT a tool here.
    for (const forbidden of ["git.push", "fs", "terminal", "shell", "command", "argv", "exec.rm"]) {
      expect(names).not.toContain(forbidden);
    }

    // Each inputSchema is BYTE-DERIVED from its binding's strict argSchema (single source of truth).
    const bindings = seedBindings();
    for (const tool of tools) {
      const binding = bindings.get(tool.name);
      expect(binding).toBeDefined();
      if (binding === undefined) continue;
      expect(tool.inputSchema).toEqual(argSchemaToJsonSchema(binding.argSchema));
    }
  });

  it("derives the EMPTY strict object for status/diff/log, {path} for add, {message} for commit", async () => {
    const { deps } = await makeServerKit();
    const server = createExecMcpServer(deps);
    const resp = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = (resp.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    const schemaOf = (name: string) => tools.find((t) => t.name === name)?.inputSchema;

    for (const name of ["git.status", "git.diff", "git.log"]) {
      expect(schemaOf(name)).toEqual({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      });
    }
    expect(schemaOf("git.add")).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    });
    expect(schemaOf("git.commit")).toEqual({
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    });
    // schema-no-drift: BYTE-DERIVED from each binding's strict argSchema (single source of truth).
    expect(schemaOf("git.status")).toEqual(argSchemaToJsonSchema(gitStatusBinding.argSchema));
    expect(schemaOf("git.diff")).toEqual(argSchemaToJsonSchema(gitDiffBinding.argSchema));
    expect(schemaOf("git.log")).toEqual(argSchemaToJsonSchema(gitLogBinding.argSchema));
    expect(schemaOf("git.add")).toEqual(argSchemaToJsonSchema(gitAddBinding.argSchema));
    expect(schemaOf("git.commit")).toEqual(argSchemaToJsonSchema(gitCommitBinding.argSchema));
    // The manifests back the advertised names (single source of truth).
    expect(gitStatusManifest.name).toBe("git.status");
    expect(gitDiffManifest.name).toBe("git.diff");
    expect(gitLogManifest.name).toBe("git.log");
    expect(gitAddManifest.name).toBe("git.add");
    expect(gitCommitManifest.name).toBe("git.commit");
  });

  it("an UNREGISTERED git-shaped name (git.push) is denied-by-default (substrate 0 calls)", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "git.push", arguments: {} },
    });
    const result = resp.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy");
    expect(substrate.execCalls.length).toBe(0);
  });
});
