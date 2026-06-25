/**
 * SLICE-EXEC4a — a protocol-level, GOVERNED MCP server that advertises ONLY our two seed exec tools and
 * routes EVERY `tools/call` through the EXISTING governed pipeline. RED-first. IN-REPO ONLY.
 *
 * WHO EXECUTES (the EXEC4 thesis): in ACP+MCP the brain (Hermes) is the MCP *client*; it `tools/call`s OUR
 * server, and OUR handler executes + returns — the brain NEVER self-runs. EXEC4a proves the GOVERNED MCP
 * boundary against a FAKE MCP client (scripted JSON-RPC requests -> asserted responses) + a FAKE substrate
 * (echoes argv). NO live, NO real Hermes, NO stdio bin, NO `acp-stdio.ts` change. Advertising to a real
 * Hermes + the descriptor shape + autonomous discovery = EXEC4b (a posture decision).
 *
 * INVARIANTS (each with a NON-VACUITY mutation noted in-line):
 *   1. deny-by-default / only-bounded-tools-exposed — tools/list = EXACTLY the registered bounded seed
 *      tools (HDI2a: the 7 read-only-safe tools), nothing unexpected; an unregistered/unbound tools/call
 *      is denied at policy and never reaches the substrate.
 *   2. composer-fixed argv — the brain's `arguments` are DECLARED params, never argv; a smuggled `argv`
 *      key is rejected by the strict argSchema, substrate 0 calls.
 *   3. commit-before-effect — the AuditEvent receipt is appended BEFORE the effect runs.
 *   4. credential-blind — a secret-shaped arg is denied at the screen stage, substrate 0 calls.
 *   5. fail-closed protocol — malformed / unknown method -> JSON-RPC error, NEVER a fabricated ok.
 *   8. single-execution-path (load-bearing EXEC4 gate) — every tools/call routes through
 *      `runGovernedToolCall` ONLY; a bypass mutation makes the deny tests go RED.
 *   9. schema-no-drift — the advertised inputSchema is DERIVED from the binding's strict argSchema
 *      (single source of truth); a looser advertised schema is contradicted by enforcement.
 *
 * (maxTurns/cost/ephemeral-sandbox are N/A at the single-call MCP layer — the MCP server governs ONE
 * tools/call per request; loop bounding lives in the closed loop, not here.)
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../../../audit/index.js";
import type { CommitAppender } from "../../../../../commitgate/index.js";
import { type CostGate, InMemoryCostGate } from "../../../../../cost/index.js";
import { authorizeToolInvoke } from "../../../../../tools/index.js";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
} from "../../../../substrate/index.js";
import { makeArgsCredentialScreen } from "../args-credential-screen.js";
import { seedBindings, seedRegistry } from "../exec-seed-tools.js";
import {
  type ExecMcpServerDeps,
  argSchemaToJsonSchema,
  createExecMcpServer,
} from "./exec-mcp-server.js";

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

// --- a spying Fake substrate: records lifecycle + exec calls + lets a script drive exec output ----
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

/**
 * Build a fully-governed MCP server deps kit over a Fake substrate. `effectOrder` records audit-vs-exec
 * order. The host (NOT the single-call MCP layer) owns the ephemeral sandbox lifecycle, so the kit
 * provisions one live sandbox up front and wires its real id into the deps (sandbox lifecycle is N/A at
 * the single-call layer — the server governs ONE tools/call against a pre-provisioned sandbox).
 */
async function makeServerKit(opts: { substrate?: SpyFakeSandboxAdapter } = {}): Promise<ServerKit> {
  const substrate = opts.substrate ?? new SpyFakeSandboxAdapter();
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
    // The server tags the exec call so the spy can record commit-before-effect ordering.
    onEffect: () => effectOrder.push("effect"),
    context: validCtx,
  };
  return { deps, substrate, appendCalls, effectOrder };
}

// ==================================================================================================
// RED1 — tools/list advertises EXACTLY the registered bounded seed tools (HDI2a: the 7 read-only-safe
//        tools), each inputSchema DERIVED from the strict argSchema (required + additionalProperties:
//        false). NOTHING unexpected (no fs/terminal/argv/shell/exec.run).
// ==================================================================================================
describe("EXEC4a — RED1 tools/list advertises exactly the bounded seed tools, schema-derived", () => {
  it("returns exactly the bounded seed tools with descriptions + DERIVED inputSchemas, nothing else", async () => {
    const { deps } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(resp.error).toBeUndefined();
    const tools = (
      resp.result as { tools: { name: string; description: string; inputSchema: unknown }[] }
    ).tools;

    // EXACTLY the registered bounded seed tools, nothing else (no fs/terminal/raw-argv/shell/command
    // tool). SLICE-HDI2a grew the read-only-safe set from 2 to 7; SLICE-HDI2b added the ONE bounded
    // general exec tool `exec.run` (a full argv vector, never a shell string) -> 8; SLICE-CAP1 added the
    // FIRST capability-breadth tool `exec.write_file` (in-sandbox write, content via stdin bytes) -> 9;
    // SLICE-CAP2 adds the in-sandbox GIT FAMILY (git.status/diff/log/add/commit — fixed-subcommand,
    // string-only args) -> 14. SLICE-CAP6's net.fetch (network-egress) is NOT here: this kit uses the
    // DEFAULT (egress-UNWIRED) seedRegistry()/seedBindings(), and net.fetch registers + advertises ONLY
    // where egress is WIRED + enforced (the bin). The invariant is unchanged — ONLY the registered bounded
    // seed tools are advertised, nothing unexpected (git.push, the network/destructive edge, is DEFERRED).
    expect(tools.map((t) => t.name).sort()).toEqual([
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
    ]);
    const names = tools.map((t) => t.name);
    // `exec.run` is now a REGISTERED bounded tool (no longer forbidden); the raw `argv`/`shell`/
    // `command`/`terminal`/`fs` capabilities remain not-tools; `git.push` (network/destructive) is DEFERRED.
    for (const forbidden of [
      "fs",
      "fs/read",
      "terminal",
      "shell",
      "command",
      "argv",
      "exec.rm",
      "git.push",
    ]) {
      expect(names).not.toContain(forbidden);
    }

    // Each inputSchema is BYTE-DERIVED from its binding's strict argSchema (single source of truth).
    const bindings = seedBindings();
    for (const tool of tools) {
      const binding = bindings.get(tool.name);
      expect(binding).toBeDefined();
      if (binding === undefined) continue;
      const derived = argSchemaToJsonSchema(binding.argSchema);
      expect(tool.inputSchema).toEqual(derived);
    }

    // The DERIVED schema for exec.echo carries the strict guarantees (no-drift).
    const echo = tools.find((t) => t.name === "exec.echo");
    expect(echo?.description).toBe("echo a line of text");
    expect(echo?.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
    const ls = tools.find((t) => t.name === "exec.ls");
    expect(ls?.inputSchema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    });
  });

  // NON-VACUITY (schema-no-drift): an advertised inputSchema that CLAIMS an extra `argv` field is allowed
  // (or drops additionalProperties:false) would diverge from the strict argSchema that enforcement uses.
  // The advertised schema MUST be byte-derived from the argSchema, and enforcement MUST reject the extra
  // field. If a mutation hand-wrote a looser advertised schema, this drift would show: the schema says
  // additionalProperties allowed, but a tools/call with the extra field is REJECTED by enforcement.
  it("the advertised inputSchema agrees with what enforcement actually accepts (no drift)", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const list = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const echo = (
      list.result as { tools: { name: string; inputSchema: { additionalProperties: boolean } }[] }
    ).tools.find((t) => t.name === "exec.echo");
    // Advertised: additionalProperties:false. So an extra arg MUST be rejected by enforcement.
    expect(echo?.inputSchema.additionalProperties).toBe(false);

    const call = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "exec.echo", arguments: { text: "hi", argv: "; rm -rf /" } },
    });
    const result = call.result as { isError: boolean };
    // Enforcement REJECTS the extra `argv` (strict argSchema) — agreeing with the advertised schema.
    expect(result.isError).toBe(true);
    expect(substrate.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// RED2 — bound tools/call exec.echo {text:'hi'} routes screen->authorize->cost->commit-before-effect
//        ->bindingWrappedExecEffect over the Fake; isError:false; redacted echoed output; receipt
//        appended BEFORE the effect.
// ==================================================================================================
describe("EXEC4a — RED2 bound tools/call exec.echo routes through the full governed pipeline", () => {
  it("isError:false; content carries the redacted echoed output; commit-before-effect", async () => {
    const { deps, substrate, appendCalls, effectOrder } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "exec.echo", arguments: { text: "hi" } },
    });
    expect(resp.error).toBeUndefined();
    const result = resp.result as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(false);
    // The argv was built FROM THE BINDING (pure vector), NOT from the brain's raw args.
    expect(substrate.execCalls[0]?.argv).toEqual(["echo", "hi"]);
    // The Fake echoes the joined argv -> the content carries the real-ish output.
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("echo hi");

    // commit-before-effect: the audit receipt was appended BEFORE the effect ran.
    expect(appendCalls.length).toBe(1);
    expect(effectOrder).toEqual(["append", "effect"]);
  });
});

// ==================================================================================================
// RED3 — unknown/unregistered tool name -> denied@policy -> isError:true, substrate 0 calls.
// ==================================================================================================
describe("EXEC4a — RED3 unregistered tool name denied@policy (substrate 0 calls)", () => {
  it("tools/call exec.rm -> isError:true, execSandbox 0 calls", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "exec.rm", arguments: { path: "/" } },
    });
    const result = resp.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DENIED");
    expect(result.content[0]?.text).toContain("policy");
    // The unregistered tool NEVER reached the substrate.
    expect(substrate.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// RED4 — poisoned/smuggled-arg exec.echo {text, argv} -> strict argSchema reject -> isError:true,
//        substrate 0 calls (the brain cannot smuggle argv through the MCP arguments).
// ==================================================================================================
describe("EXEC4a — RED4 smuggled argv rejected by the strict argSchema (substrate 0 calls)", () => {
  it("tools/call exec.echo {text, argv:'; rm -rf /'} -> isError:true, execSandbox 0 calls", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "exec.echo", arguments: { text: "x", argv: "; rm -rf /" } },
    });
    const result = resp.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    // The smuggled command NEVER executed.
    expect(substrate.execCalls.length).toBe(0);
    expect(result.content[0]?.text).not.toContain("rm -rf");
  });
});

// ==================================================================================================
// RED5 — credential-blind: exec.echo {text:<runtime sk- canary>} -> denied@screen -> isError:true.
// ==================================================================================================
describe("EXEC4a — RED5 credential-blind: a secret-shaped arg denied@screen (substrate 0 calls)", () => {
  it("tools/call exec.echo {text:<canary>} -> isError:true, denied@screen, execSandbox 0 calls", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);
    const canary = secretCanary();

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "exec.echo", arguments: { text: canary } },
    });
    const result = resp.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("screen");
    // The screen denied BEFORE the effect — the substrate never saw the call, and the canary never
    // egresses in the error text (redacted).
    expect(substrate.execCalls.length).toBe(0);
    expect(result.content[0]?.text).not.toContain(canary);
  });
});

// ==================================================================================================
// RED6 — protocol fail-closed: malformed request / unknown method -> JSON-RPC error, never a fake ok.
// ==================================================================================================
describe("EXEC4a — RED6 protocol fail-closed (never a fabricated ok)", () => {
  it("an unknown method -> -32601 method-not-found error, no result", async () => {
    const { deps } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/destroy",
      params: {},
    });
    expect(resp.result).toBeUndefined();
    expect(resp.error?.code).toBe(-32601);
  });

  it("a malformed request (no method) -> JSON-RPC error, never a result", async () => {
    const { deps } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({ jsonrpc: "2.0", id: 22 } as never);
    expect(resp.result).toBeUndefined();
    expect(resp.error).toBeDefined();
    // Parse/invalid-request family (-32700 or -32600), never default-allow.
    expect([-32700, -32600]).toContain(resp.error?.code);
  });

  it("a tools/call with a non-object params -> error, never an executed effect", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: 42 as never,
    });
    // Either a JSON-RPC error OR an isError result — but NEVER a fabricated ok / NEVER an exec.
    if (resp.error === undefined) {
      expect((resp.result as { isError: boolean }).isError).toBe(true);
    }
    expect(substrate.execCalls.length).toBe(0);
  });

  it("initialize -> minimal serverInfo + capabilities {tools:{}}", async () => {
    const { deps } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      capabilities: { tools: unknown };
      serverInfo: { name: string };
    };
    expect(result.capabilities.tools).toBeDefined();
    expect(typeof result.serverInfo.name).toBe("string");
  });
});

// ==================================================================================================
// RED7 — SINGLE-EXECUTION-PATH non-vacuity. The handler routes EVERY call through runGovernedToolCall
//        ONLY. If a mutation made the handler call the substrate/effect DIRECTLY (bypassing
//        screen/authorize/cost/commit), the deny tests (RED3/RED4/RED5) would EXECUTE the
//        unauthorized/poisoned/secret call. This test pins it: across the three deny vectors, the
//        substrate is called EXACTLY 0 times — the only execution edge is the governed one.
// ==================================================================================================
describe("EXEC4a — RED7 single-execution-path: deny vectors never reach the substrate", () => {
  it("unregistered + smuggled-argv + secret-arg all yield isError:true with ZERO substrate calls", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);
    const canary = secretCanary();

    const denied = [
      { name: "exec.rm", arguments: { path: "/" } }, // policy
      { name: "exec.echo", arguments: { text: "x", argv: "; rm -rf /" } }, // strict-schema
      { name: "exec.echo", arguments: { text: canary } }, // screen
    ];
    let id = 30;
    for (const params of denied) {
      const resp = await server.handle({ jsonrpc: "2.0", id: ++id, method: "tools/call", params });
      expect((resp.result as { isError: boolean }).isError).toBe(true);
    }
    // The load-bearing assertion: NOT ONE of the three denied vectors executed. A direct-substrate
    // bypass mutation would make >=1 of these reach execSandbox -> this goes RED.
    expect(substrate.execCalls.length).toBe(0);

    // A legitimately bound call DOES execute through the same single edge (proving the edge is live).
    const ok = await server.handle({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "exec.echo", arguments: { text: "hi" } },
    });
    expect((ok.result as { isError: boolean }).isError).toBe(false);
    expect(substrate.execCalls.length).toBe(1);
  });
});
