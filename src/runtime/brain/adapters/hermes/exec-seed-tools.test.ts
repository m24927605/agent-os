/**
 * SLICE-HDI2a — the read-only-safe growth of the SHARED governed seed toolset. PURE ADDITION: each new
 * tool = a manifest + a binding + registration in `seedRegistry()`/`seedBindings()`; NO governance is
 * relaxed. The MCP server AUTO-advertises every `seedBindings()` key + AUTO-governs every `tools/call`
 * through `runGovernedToolCall`, and the `exec.**` allow rule already covers `exec.*` — so this slice
 * proves the FIVE new read-only tools (`exec.cat` / `exec.head` / `exec.pwd` / `exec.wc` / `exec.grep`)
 * are advertised with DERIVED schemas, build their EXACT argv from the binding (a pure string vector,
 * never a shell string), and are bounded by the SAME governance the two original seed tools rode:
 *
 *   - composer-fixed argv — the brain's `arguments` are DECLARED params, never argv; a smuggled extra
 *     key is rejected by the strict argSchema, the substrate sees 0 calls.
 *   - credential-blind — a secret-shaped arg is denied at the screen stage, the substrate sees 0 calls.
 *   - commit-before-effect — the audit receipt is appended BEFORE the effect runs.
 *   - schema-no-drift — the advertised inputSchema is DERIVED from the binding's strict argSchema.
 *
 * Each invariant carries a NON-VACUITY mutation noted in-line (exact-set / per-tool toArgv / smuggled
 * key / secret). Proven against a FAKE substrate (echoes the joined argv) through `createExecMcpServer`.
 * NO live, NO real Hermes, NO real drive — the live drive of the new tools via a real Hermes is
 * user-initiated, not run here.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
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
import { runBinding, seedBindings, seedRegistry } from "./exec-seed-tools.js";
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

// --- a spying Fake substrate: records lifecycle + exec calls + echoes the joined argv on stdout -------
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

// The full seed set after CAP2 — sorted. EXACT (a tool removed/added wrongly flips this). SLICE-HDI2b
// added the ONE bounded general exec tool `exec.run` (a full argv vector, run DIRECTLY — never a shell
// string). SLICE-CAP1 added the FIRST capability-breadth tool `exec.write_file` (in-sandbox file write —
// argv ["tee","--",path], content via stdin bytes, never argv/shell), so the set of 8 became 9. SLICE-CAP2
// adds the in-sandbox GIT FAMILY (git.status/diff/log/add/commit — each a FIXED-subcommand argvPrefix,
// string-only args), so 9 becomes 14. git.push (network/destructive) is DEFERRED — NOT in the set.
const FULL_SEED_SET = [
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

// ==================================================================================================
// HDI2a-1 — tools/list now advertises the FULL read-only seed set (7 tools), each inputSchema DERIVED
//           from its strict argSchema. NOTHING unexpected (no fs/terminal/argv/shell/exec.rm/exec.run).
//           NON-VACUITY: the exact-set assertion flips RED if a tool were removed or an extra advertised.
// ==================================================================================================
describe("HDI2a-1 tools/list advertises the full read-only seed set, each schema-derived", () => {
  it("returns exactly the 14 bounded seed tools, each with a DERIVED inputSchema, nothing else", async () => {
    const { deps } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(resp.error).toBeUndefined();
    const tools = (resp.result as { tools: { name: string; inputSchema: unknown }[] }).tools;

    // EXACTLY the bounded seed set — nothing else (no fs/terminal/raw-argv/shell/exec.rm). NOTE: HDI2b
    // makes `exec.run` a REGISTERED bounded tool, so it is now IN the set (no longer forbidden); the
    // raw `argv`/`shell`/`command`/`terminal`/`fs` capabilities are STILL not tools.
    expect(tools.map((t) => t.name).sort()).toEqual(FULL_SEED_SET);
    const names = tools.map((t) => t.name);
    for (const forbidden of ["fs", "fs/read", "terminal", "shell", "command", "argv", "exec.rm"]) {
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

  // INFO polish: each advertised description is SOURCED from the registered manifest (single source of
  // truth), so EVERY seed tool (not just echo/ls) gets its real description — never the tool-name fallback.
  // NON-VACUITY: before the fix, cat/head/pwd/wc/grep fell back to their NAME; now they are the manifests'.
  it("sources each tool's description from its registered manifest (not the tool-name fallback)", async () => {
    const { deps } = await makeServerKit();
    const server = createExecMcpServer(deps);
    const registry = seedRegistry();

    const resp = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = (resp.result as { tools: { name: string; description: string }[] }).tools;

    for (const tool of tools) {
      const manifestDesc = registry.lookup(tool.name)?.description;
      expect(manifestDesc).toBeDefined();
      // The advertised description equals the registered manifest description (no drift, no name fallback).
      expect(tool.description).toBe(manifestDesc);
      // And it is a real description, NOT the tool-name fallback.
      expect(tool.description).not.toBe(tool.name);
    }
    // Spot-check a NEW tool that previously fell back to its name.
    const wc = tools.find((t) => t.name === "exec.wc");
    expect(wc?.description).toBe("count lines, words, and bytes of a file");
  });

  // Each NEW tool's DERIVED schema carries the strict guarantees (string-only fields, additionalProperties:false).
  it("derives {path} for cat/head/wc, {pattern,path} for grep, and the EMPTY strict object for pwd", async () => {
    const { deps } = await makeServerKit();
    const server = createExecMcpServer(deps);
    const resp = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = (resp.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    const schemaOf = (name: string) => tools.find((t) => t.name === name)?.inputSchema;

    for (const name of ["exec.cat", "exec.head", "exec.wc"]) {
      expect(schemaOf(name)).toEqual({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      });
    }
    expect(schemaOf("exec.grep")).toEqual({
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern", "path"],
      additionalProperties: false,
    });
    // pwd is the EMPTY strict object — no properties, no required, additionalProperties:false.
    expect(schemaOf("exec.pwd")).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });
});

// ==================================================================================================
// HDI2a-2 — for EACH new tool, a governed tools/call builds the EXACT argv from the binding (a pure
//           string vector), routes screen->authorize->cost->commit-before-effect->effect over the Fake;
//           isError:false; commit-before-effect holds.
//           NON-VACUITY: a toArgv mutation (e.g. cat -> reversed, grep dropping "-e") flips the argv
//           assertion RED — the argv is the pure vector the binding builds, nothing else.
// ==================================================================================================
describe("HDI2a-2 each new tool builds its EXACT argv from the binding (pure vector), commit-before-effect", () => {
  const cases: { name: string; args: Record<string, unknown>; argv: string[] }[] = [
    { name: "exec.cat", args: { path: "/etc/x" }, argv: ["cat", "/etc/x"] },
    { name: "exec.head", args: { path: "/etc/x" }, argv: ["head", "/etc/x"] },
    { name: "exec.pwd", args: {}, argv: ["pwd"] },
    { name: "exec.wc", args: { path: "/etc/x" }, argv: ["wc", "/etc/x"] },
    // The "-e" guards a pattern that starts with "-" from being parsed as a grep flag: pattern + path
    // are LITERAL argv elements, never shell. Dropping "-e" (a mutation) flips this RED.
    {
      name: "exec.grep",
      args: { pattern: "-r", path: "f" },
      argv: ["grep", "-n", "-e", "-r", "f"],
    },
  ];

  for (const { name, args, argv } of cases) {
    it(`${name} -> argv ${JSON.stringify(argv)}; isError:false; receipt appended BEFORE effect`, async () => {
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
      // The argv was built FROM THE BINDING (pure vector) — never from the brain's raw args.
      expect(substrate.execCalls.length).toBe(1);
      expect(substrate.execCalls[0]?.argv).toEqual(argv);
      // The Fake echoes the joined argv -> the content carries the real-ish output.
      expect(result.content[0]?.text).toContain(argv.join(" "));
      // commit-before-effect: the audit receipt was appended BEFORE the effect ran.
      expect(appendCalls.length).toBe(1);
      expect(effectOrder).toEqual(["append", "effect"]);
    });
  }
});

// ==================================================================================================
// HDI2a-3 — for EACH new tool, a smuggled extra key -> strict argSchema reject -> isError:true, the
//           substrate sees 0 calls. The brain cannot smuggle argv through the MCP arguments.
//           NON-VACUITY: a non-strict argSchema (a mutation) would ADMIT the extra key -> this RED.
// ==================================================================================================
describe("HDI2a-3 a smuggled extra key is rejected by the strict argSchema (substrate 0 calls)", () => {
  const cases: { name: string; args: Record<string, unknown> }[] = [
    { name: "exec.cat", args: { path: "f", argv: "; rm -rf /" } },
    { name: "exec.head", args: { path: "f", argv: "; rm -rf /" } },
    { name: "exec.pwd", args: { argv: "; rm -rf /" } },
    { name: "exec.wc", args: { path: "f", argv: "; rm -rf /" } },
    { name: "exec.grep", args: { pattern: "x", path: "f", argv: "; rm -rf /" } },
  ];

  for (const { name, args } of cases) {
    it(`${name} {..., argv:'; rm -rf /'} -> isError:true, execSandbox 0 calls`, async () => {
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
      // The smuggled command NEVER executed and never echoed back.
      expect(substrate.execCalls.length).toBe(0);
      expect(result.content[0]?.text).not.toContain("rm -rf");
    });
  }
});

// ==================================================================================================
// HDI2a-4 — for EACH new tool that takes a string arg, a secret-shaped value (runtime-built sk- canary)
//           is denied at the screen stage -> isError:true, the substrate sees 0 calls, the canary never
//           egresses (redacted). NON-VACUITY: removing the credential-blind screen (a mutation) would
//           let the secret through to the effect -> this RED.
// ==================================================================================================
describe("HDI2a-4 a secret-shaped arg is denied@screen (substrate 0 calls, canary never egresses)", () => {
  // pwd has no string arg to poison; the other four each carry a secret-shaped value in a declared field.
  const cases: { name: string; field: string; other?: Record<string, unknown> }[] = [
    { name: "exec.cat", field: "path" },
    { name: "exec.head", field: "path" },
    { name: "exec.wc", field: "path" },
    { name: "exec.grep", field: "pattern", other: { path: "f" } },
  ];

  for (const { name, field, other } of cases) {
    it(`${name} {${field}:<canary>} -> isError:true, denied@screen, execSandbox 0 calls`, async () => {
      const { deps, substrate } = await makeServerKit();
      const server = createExecMcpServer(deps);
      const canary = secretCanary();

      const resp = await server.handle({
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name, arguments: { [field]: canary, ...(other ?? {}) } },
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
// SLICE-HDI2b — the ONE bounded GENERAL exec tool `exec.run {argv: string[]}` (the "maximum utility"
// capability, user-approved posture). The brain supplies a FULL argv VECTOR; the binding runs it
// DIRECTLY (argvPrefix [] + the vector = the raw argv, execve argv[0] with args) — NEVER a shell
// string, NEVER `sh -c` / `bash -c`. The boundary is the governance pipeline + the SEALED ephemeral
// zero-credential no-egress sandbox, NOT a whitelist. `exec.run` is now a REGISTERED bounded tool, so
// the exact-set is 8 tools and `exec.run` is no longer forbidden — but the `argv`/`shell`/`command`
// capabilities remain not-tools (raw-argv injection still impossible — the brain proposes a tool NAME +
// the DECLARED `argv` field, governed identically to every other tool).
// ==================================================================================================

// --------------------------------------------------------------------------------------------------
// HDI2b-1 — tools/list now advertises exec.run, with the DERIVED array inputSchema. The advertised
//           schema EQUALS argSchemaToJsonSchema(runBinding.argSchema) (no-drift): a `z.array(z.string())`
//           field derives `{type:"array", items:{type:"string"}}`, `argv` is required, the object is
//           additionalProperties:false.
//           NON-VACUITY: a hand-written schema (or a converter that dropped the array support) would
//           diverge from the byte-derived assertion.
// --------------------------------------------------------------------------------------------------
describe("HDI2b-1 tools/list advertises exec.run with the DERIVED array inputSchema (no-drift)", () => {
  it("exec.run is advertised with {argv:{type:'array',items:{type:'string'}}} required, additionalProperties:false", async () => {
    const { deps } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(resp.error).toBeUndefined();
    const tools = (resp.result as { tools: { name: string; inputSchema: unknown }[] }).tools;

    const run = tools.find((t) => t.name === "exec.run");
    expect(run).toBeDefined();
    // The DERIVED array schema — argv is an array of strings, required, additionalProperties:false.
    expect(run?.inputSchema).toEqual({
      type: "object",
      properties: { argv: { type: "array", items: { type: "string" } } },
      required: ["argv"],
      additionalProperties: false,
    });
    // schema-no-drift: it is BYTE-DERIVED from the binding's strict argSchema (single source of truth).
    expect(run?.inputSchema).toEqual(argSchemaToJsonSchema(runBinding.argSchema));
  });
});

// --------------------------------------------------------------------------------------------------
// HDI2b-2 — a governed tools/call exec.run {argv:["echo","hi"]} runs the FULL VECTOR DIRECTLY: the Fake
//           substrate receives argv EXACTLY ["echo","hi"] (argvPrefix [] + the vector; NO wrapper, NO
//           "sh"/"-c" prepended); isError:false; commit-before-effect holds.
//           NON-VACUITY (the LOAD-BEARING "never sh -c" proof): a toArgv/effect mutation that wrapped the
//           vector in ["sh","-c", argv.join(" ")] flips RED — the substrate argv has NO "sh"/"-c" and
//           equals the raw vector exactly.
// --------------------------------------------------------------------------------------------------
describe("HDI2b-2 exec.run runs the full argv vector DIRECTLY (never sh -c), commit-before-effect", () => {
  it("exec.run {argv:['echo','hi']} -> substrate argv EXACTLY ['echo','hi']; isError:false; append BEFORE effect", async () => {
    const { deps, substrate, appendCalls, effectOrder } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "exec.run", arguments: { argv: ["echo", "hi"] } },
    });
    expect(resp.error).toBeUndefined();
    const result = resp.result as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(false);
    // The substrate received the RAW VECTOR, built DIRECTLY (argvPrefix [] + toArgv = [...argv]).
    expect(substrate.execCalls.length).toBe(1);
    const ranArgv = substrate.execCalls[0]?.argv ?? [];
    expect(ranArgv).toEqual(["echo", "hi"]);
    // THE LOAD-BEARING "never sh -c" PROOF — the argv is the raw vector, NEVER wrapped in a shell.
    expect(ranArgv).not.toContain("sh");
    expect(ranArgv).not.toContain("-c");
    expect(ranArgv).not.toContain("bash");
    expect(ranArgv[0]).toBe("echo"); // execve argv[0] is the brain's first token, not a shell.
    // The Fake echoes the joined argv -> the content carries the real-ish output.
    expect(result.content[0]?.text).toContain("echo hi");
    // commit-before-effect: the audit receipt was appended BEFORE the effect ran.
    expect(appendCalls.length).toBe(1);
    expect(effectOrder).toEqual(["append", "effect"]);
  });

  it("a ';'-laden token is just a LITERAL argv element (no shell to interpret it)", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);

    // The brain types "; rm -rf /" as ONE explicit argv token. There is no shell — it cannot be a
    // separator/injection; it is a literal argument to `echo`. (Bounded further by the sealed sandbox.)
    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "exec.run", arguments: { argv: ["echo", "; rm -rf /"] } },
    });
    const result = resp.result as { isError: boolean };
    expect(result.isError).toBe(false);
    // The vector reached the substrate VERBATIM — argv[0] is "echo", the dangerous string is a literal arg.
    expect(substrate.execCalls.length).toBe(1);
    expect(substrate.execCalls[0]?.argv).toEqual(["echo", "; rm -rf /"]);
    expect(substrate.execCalls[0]?.argv).not.toContain("sh");
    expect(substrate.execCalls[0]?.argv[0]).toBe("echo");
  });
});

// --------------------------------------------------------------------------------------------------
// HDI2b-3 — deny-by-default: exec.run is denied if NOT registered (drop it from a LOCAL kit's registry ->
//           denied@policy, substrate 0). A smuggled extra key {argv, cmd} -> strict reject -> isError:true,
//           substrate 0. A secret-shaped element {argv:["echo", <canary>]} -> denied@screen, substrate 0,
//           canary never egresses.
//           NON-VACUITY: a non-strict argSchema would admit the extra `cmd` key; removing the screen would
//           let the secret element through to the effect.
// --------------------------------------------------------------------------------------------------
describe("HDI2b-3 exec.run is governed identically: deny-by-default, strict, credential-blind", () => {
  it("exec.run denied@policy when NOT registered (substrate 0 calls)", async () => {
    const { deps, substrate } = await makeServerKit();
    // Drop exec.run from THIS kit only (deny-by-default: an unregistered name is denied at the policy
    // gate and never reaches the substrate). We wrap the registry (lookup/has hide exec.run) and the
    // authorize closure so exec.run is admitted by NOTHING — exactly as an unregistered tool would be.
    const denyRegistryDeps: ExecMcpServerDeps = {
      ...deps,
      registry: {
        has: (n: string) => n !== "exec.run" && deps.registry.has(n),
        lookup: (n: string) => (n === "exec.run" ? undefined : deps.registry.lookup(n)),
      },
      authorize: (tc: { tool: string; context: unknown }) => {
        if (tc.tool === "exec.run")
          return { effect: "deny" as const, reason: "not registered (deny-by-default)" };
        return deps.authorize(tc as never);
      },
    };
    const server = createExecMcpServer(denyRegistryDeps);

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "exec.run", arguments: { argv: ["echo", "hi"] } },
    });
    const result = resp.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy");
    expect(substrate.execCalls.length).toBe(0);
  });

  it("exec.run {argv, cmd} smuggled extra key -> strict reject -> isError:true, substrate 0 calls", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "exec.run", arguments: { argv: ["x"], cmd: "y" } },
    });
    const result = resp.result as { isError: boolean };
    expect(result.isError).toBe(true);
    // The smuggled `cmd` key was rejected by the strict argSchema -> the effect never ran.
    expect(substrate.execCalls.length).toBe(0);
  });

  it("exec.run {argv:['echo', <canary>]} -> denied@screen, substrate 0, canary never egresses", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);
    const canary = secretCanary();

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "exec.run", arguments: { argv: ["echo", canary] } },
    });
    const result = resp.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("screen");
    // The screen denied BEFORE the effect — the substrate never saw the call, canary never egresses.
    expect(substrate.execCalls.length).toBe(0);
    expect(result.content[0]?.text).not.toContain(canary);
  });
});

// --------------------------------------------------------------------------------------------------
// HDI2b-4 — argSchemaToJsonSchema array extension (focused unit test). A `z.array(z.string())` field
//           derives `{type:"array", items:{type:"string"}}`; a NON-string array element (z.array(
//           z.number())) STILL THROWS (fail-closed — we never advertise an unenforceable schema). The
//           min(1) is an enforcement detail not carried into the JSON-Schema.
//           NON-VACUITY: if the converter emitted a type for a number array instead of throwing, the
//           throw assertion flips RED.
// --------------------------------------------------------------------------------------------------
describe("HDI2b-4 argSchemaToJsonSchema: string-array -> array/items:string; other shapes still throw", () => {
  it("derives {type:'array', items:{type:'string'}} for a z.array(z.string()) field", () => {
    const schema = z.object({ argv: z.array(z.string()).min(1) }).strict();
    expect(argSchemaToJsonSchema(schema)).toEqual({
      type: "object",
      properties: { argv: { type: "array", items: { type: "string" } } },
      required: ["argv"],
      additionalProperties: false,
    });
  });

  it("an OPTIONAL string-array field is derived but NOT required", () => {
    const schema = z.object({ argv: z.array(z.string()).optional() }).strict();
    expect(argSchemaToJsonSchema(schema)).toEqual({
      type: "object",
      properties: { argv: { type: "array", items: { type: "string" } } },
      required: [],
      additionalProperties: false,
    });
  });

  it("a NON-string array element (z.array(z.number())) THROWS — fail-closed (never advertises it)", () => {
    const schema = z.object({ ns: z.array(z.number()) }).strict();
    expect(() => argSchemaToJsonSchema(schema)).toThrow();
  });

  it("a bare number field STILL throws (the array support did not loosen other shapes)", () => {
    const schema = z.object({ n: z.number() }).strict();
    expect(() => argSchemaToJsonSchema(schema)).toThrow();
  });

  it("an array-of-arrays element STILL throws (only a string element is supported)", () => {
    const schema = z.object({ nested: z.array(z.array(z.string())) }).strict();
    expect(() => argSchemaToJsonSchema(schema)).toThrow();
  });
});
