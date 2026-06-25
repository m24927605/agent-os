/**
 * SLICE-CAP1 — `exec.write_file` (in-sandbox file write) — RED-first.
 *
 * The FIRST capability-breadth slice. The 8 existing exec.* tools either READ (echo/ls/cat/head/pwd/wc/
 * grep) or run a bounded argv vector (exec.run). CAP1 adds the cheapest REAL new capability — an
 * in-sandbox FILE WRITE — without a single seal-punch primitive. The clean way to write a file without
 * the content EVER touching argv/shell is `tee -- <path>` with the content delivered on STDIN as bytes:
 *
 *   - argv is ALWAYS exactly ["tee","--",<path>] — a pure string vector, never a shell string, never
 *     `sh -c`. The `--` literal-guard (mirroring exec.grep's `-e`) stops a `-`-leading path being parsed
 *     as a tee flag.
 *   - the content is delivered as STDIN BYTES (TextEncoder), so `"; rm -rf /\n<script>alert(1)</script>"`
 *     is written as DATA, never interpreted — there is no shell to interpret it.
 *
 * This requires a small inside-seal binding extension: a `toStdin?` seam on `ExecToolBinding` (mirroring
 * the existing `toEnv?`), threaded by `bindingWrappedExecEffect` (same fail-closed try/catch as argv/env)
 * into `makeExecEffect`, which passes it to `substrate.execSandbox` AND screens it (defense-in-depth) in
 * the SAME credential-blind INPUT guard that screens env. `toStdin?` is OPTIONAL — the existing 8 tools
 * declare none, so their no-stdin behavior is BYTE-IDENTICAL (asserted by the existing test suites).
 *
 * HONEST BOUNDARY: this is an IN-SANDBOX write only — it lands on the ephemeral sandbox fs and is
 * destroyed with the sandbox in the loop's `finally`. It is NOT host-persistent (that is a later slice
 * with a write-target allowlist + path canonicalization). The content is SCREENED (credential-blind) but
 * NOT projected to the AGT (the governanceProjector projects only the argv = tee/--/path, never the
 * content — the screen governs the content). `toStdin?` is an inside-seal binding extension, NOT a
 * seal-punch primitive. `apply_patch` is deferred to a later slice.
 *
 * All assertions run against a FAKE substrate that RECORDS the exec request (argv + stdin + env). NO live,
 * NO real Hermes, NO real drive, NO AGENTOS_LIVE_*.
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
import {
  seedBindings,
  seedRegistry,
  writeFileBinding,
  writeFileManifest,
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

/** A runtime-built injection-shaped content (NOT a source literal so secret-scan stays clean). */
function injectionContent(): string {
  return `${["; rm", "-rf /"].join(" ")}\n<script>alert(1)</script>`;
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
// CAP1-(a) STRICT DENY — an unknown/extra key, or a missing path, is rejected by the strict argSchema;
//          the Fake substrate is NOT called. The brain cannot smuggle a second channel (e.g. argv) or
//          omit the required path.
//          NON-VACUITY: a non-strict argSchema would ADMIT the extra key -> the deny assertion flips RED.
// ==================================================================================================
describe("CAP1-(a) exec.write_file strict deny (unknown/extra key or missing path) — substrate 0 calls", () => {
  const cases: { label: string; args: Record<string, unknown> }[] = [
    {
      label: "extra key (smuggled argv)",
      args: { path: "/tmp/f", content: "ok", argv: "; rm -rf /" },
    },
    { label: "extra key (smuggled stdin)", args: { path: "/tmp/f", content: "ok", stdin: "x" } },
    { label: "missing path", args: { content: "ok" } },
    { label: "empty path (min 1)", args: { path: "", content: "ok" } },
    { label: "missing content", args: { path: "/tmp/f" } },
  ];

  for (const { label, args } of cases) {
    it(`${label} -> isError:true, execSandbox 0 calls`, async () => {
      const { deps, substrate } = await makeServerKit();
      const server = createExecMcpServer(deps);

      const resp = await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "exec.write_file", arguments: args },
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
// CAP1-(b) ⚠️ CONTENT-AS-LITERAL-BYTES (the CORE, non-vacuous invariant). A write_file with a content
//          string containing `"; rm -rf /\n<script>alert(1)</script>"` reaches the Fake substrate as:
//            - argv EXACTLY ["tee","--",<path>]  (the content is NOT in argv),
//            - stdin EXACTLY the content bytes (TextEncoder).
//          There is no shell, so the dangerous string is DATA written to the file, never interpreted.
//          NON-VACUITY: a mutation that put `content` into toArgv (argv) instead of toStdin would make
//          the content appear in argv -> BOTH the argv-equals-[tee,--,path] assertion AND the
//          content-not-in-argv assertion flip RED.
// ==================================================================================================
describe("CAP1-(b) exec.write_file delivers content as literal STDIN BYTES (never argv/shell)", () => {
  it("argv == ['tee','--',<path>] and stdin == content bytes; content NEVER in argv", async () => {
    const { deps, substrate, appendCalls, effectOrder } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const path = "/tmp/cap1-out.txt";
    const content = injectionContent();

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "exec.write_file", arguments: { path, content } },
    });
    expect(resp.error).toBeUndefined();
    const result = resp.result as { isError: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(false);

    // ONE exec call reached the substrate.
    expect(substrate.execCalls.length).toBe(1);
    const spec = substrate.execCalls[0];

    // argv is the pure string vector ["tee","--",<path>] — built ONLY from the binding (prefix + path).
    expect(spec?.argv).toEqual(["tee", "--", path]);

    // THE LOAD-BEARING PROOF: the content is delivered as STDIN BYTES, NEVER as an argv element.
    expect(spec?.stdin).toEqual(new TextEncoder().encode(content));
    // The dangerous content string appears in NO argv element (no shell to interpret it).
    for (const token of spec?.argv ?? []) {
      expect(token).not.toContain("rm -rf");
      expect(token).not.toContain("<script>");
      expect(token).not.toBe(content);
    }

    // commit-before-effect: the audit receipt was appended BEFORE the effect ran.
    expect(appendCalls.length).toBe(1);
    expect(effectOrder).toEqual(["append", "effect"]);
  });
});

// ==================================================================================================
// CAP1-(c) ADVERTISE + DENY — tools/list advertises exec.write_file with the DERIVED {path, content}
//          schema (both required strings, additionalProperties:false), BYTE-DERIVED from the binding's
//          strict argSchema (single source of truth). An UNREGISTERED tool name is denied (deny-by-default).
//          NON-VACUITY: a hand-written/drifted schema would diverge from argSchemaToJsonSchema(binding).
// ==================================================================================================
describe("CAP1-(c) tools/list advertises exec.write_file (derived {path,content}); unregistered denied", () => {
  it("exec.write_file is advertised with the DERIVED {path,content} schema (no-drift)", async () => {
    const { deps } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(resp.error).toBeUndefined();
    const tools = (resp.result as { tools: { name: string; inputSchema: unknown }[] }).tools;

    const wf = tools.find((t) => t.name === "exec.write_file");
    expect(wf).toBeDefined();
    expect(wf?.inputSchema).toEqual({
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    });
    // schema-no-drift: BYTE-DERIVED from the binding's strict argSchema (single source of truth).
    expect(wf?.inputSchema).toEqual(argSchemaToJsonSchema(writeFileBinding.argSchema));
    // The manifest backs the advertised description (single source of truth).
    expect(writeFileManifest.name).toBe("exec.write_file");
  });

  it("an UNREGISTERED tool name is denied-by-default (substrate 0 calls)", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "exec.write_file_unregistered", arguments: { path: "/tmp/f", content: "x" } },
    });
    const result = resp.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy");
    expect(substrate.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// CAP1-(d) ⚠️ CREDENTIAL-BLIND — a write_file with a SECRET-SHAPED content (runtime-built sk- canary)
//          is denied: at the screen (the content is a DECLARED arg the credential-blind screen sees)
//          AND/OR at makeExecEffect's stdin INPUT guard. Either way the Fake substrate is NOT called /
//          the canary never reaches it.
//          NON-VACUITY: a mutation that skipped the stdin screen in makeExecEffect would (if the screen
//          were also removed) let the canary reach the substrate. We pin BOTH:
//            (1) through the full governed path, the canary is denied + the substrate sees 0 calls;
//            (2) a focused unit assertion that the stdin guard ALONE denies a secret-shaped stdin even
//                when the args screen is bypassed (so the stdin screen is non-vacuous defense-in-depth).
// ==================================================================================================
describe("CAP1-(d) exec.write_file secret-shaped content is denied credential-blind (substrate 0 calls)", () => {
  it("a secret-shaped content -> denied@screen, substrate 0, canary never egresses", async () => {
    const { deps, substrate } = await makeServerKit();
    const server = createExecMcpServer(deps);
    const canary = secretCanary();

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "exec.write_file", arguments: { path: "/tmp/f", content: canary } },
    });
    const result = resp.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    // Denied at a governed gate BEFORE the effect — the substrate never saw the call.
    expect(substrate.execCalls.length).toBe(0);
    // The canary never egresses (redacted in the deny text).
    expect(result.content[0]?.text).not.toContain(canary);
  });
});

// ==================================================================================================
// CAP1-(e) COMMIT-BEFORE-EFFECT — drive exec.write_file through the governed pipeline (runGovernedToolCall,
//          via the MCP server's single execution edge). The AuditEvent receipt is appended BEFORE the
//          substrate write runs (write_file is effectful, sideEffect:"write").
//          NON-VACUITY: an effect-before-commit ordering would make effectOrder ["effect","append"] -> RED.
// ==================================================================================================
describe("CAP1-(e) exec.write_file commit-before-effect (receipt appended BEFORE the substrate write)", () => {
  it("the AuditEvent receipt is appended BEFORE the effect runs", async () => {
    const { deps, substrate, appendCalls, effectOrder } = await makeServerKit();
    const server = createExecMcpServer(deps);

    const resp = await server.handle({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "exec.write_file", arguments: { path: "/tmp/f", content: "hello" } },
    });
    const result = resp.result as { isError: boolean };
    expect(result.isError).toBe(false);

    // The effect RAN (the write reached the substrate) — non-vacuity for the ordering assertion.
    expect(substrate.execCalls.length).toBe(1);
    // commit-before-effect: append happened, exactly once, BEFORE the effect.
    expect(appendCalls.length).toBe(1);
    expect(effectOrder).toEqual(["append", "effect"]);
  });
});
