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
import { seedBindings, seedRegistry } from "./exec-seed-tools.js";
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

// The full read-only seed set after HDI2a — sorted. EXACT (a tool removed/added wrongly flips this).
const FULL_SEED_SET = [
  "exec.cat",
  "exec.echo",
  "exec.grep",
  "exec.head",
  "exec.ls",
  "exec.pwd",
  "exec.wc",
];

// ==================================================================================================
// HDI2a-1 — tools/list now advertises the FULL read-only seed set (7 tools), each inputSchema DERIVED
//           from its strict argSchema. NOTHING unexpected (no fs/terminal/argv/shell/exec.rm/exec.run).
//           NON-VACUITY: the exact-set assertion flips RED if a tool were removed or an extra advertised.
// ==================================================================================================
describe("HDI2a-1 tools/list advertises the full read-only seed set, each schema-derived", () => {
  it("returns exactly the 7 bounded seed tools, each with a DERIVED inputSchema, nothing else", async () => {
    const { deps } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(resp.error).toBeUndefined();
    const tools = (resp.result as { tools: { name: string; inputSchema: unknown }[] }).tools;

    // EXACTLY the bounded seed set — nothing else (no fs/terminal/raw-argv/shell/exec.run/exec.rm).
    expect(tools.map((t) => t.name).sort()).toEqual(FULL_SEED_SET);
    const names = tools.map((t) => t.name);
    for (const forbidden of [
      "fs",
      "fs/read",
      "terminal",
      "shell",
      "command",
      "argv",
      "exec.rm",
      "exec.run",
    ]) {
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
