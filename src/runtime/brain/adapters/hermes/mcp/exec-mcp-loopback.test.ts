/**
 * SLICE-EXEC4b (in-repo half) — the IN-PROCESS governed MCP loopback server, proven by a Fake MCP client
 * driving the REAL transport (a loopback HTTP POST -> the EXEC4a `handle` -> governed over a Fake
 * substrate). RED-first. IN-REPO ONLY (no Hermes, no credits, no OpenShell).
 *
 * THE WE-STAY-EXECUTOR THESIS (what this file proves about the transport): a Hermes `tools/call` is an
 * HTTP request to a loopback URL Agent OS hosts IN-PROCESS; the request body is dispatched to the EXACT
 * EXEC4a `createExecMcpServer(deps).handle(...)` and the result returns over the same socket. So the
 * single execution edge (`runGovernedToolCall`) + the WORM appender + the screen/authorize/cost gates all
 * stay in OUR process — the transport is a thin byte-pipe, NOT a second governance path. These tests
 * assert the transport does NOT bypass governance: tools/list advertises only the bounded set; a bound
 * tools/call executes through the full pipeline; an unknown / secret / smuggled-argv call is `isError:true`
 * with the substrate untouched.
 *
 * HONEST BOUNDARY: this drives a FAKE MCP client (a raw HTTP POST of JSON-RPC) over the REAL loopback
 * transport + a FAKE substrate. A REAL Hermes autonomously discovering via `tools/list` + calling via
 * `tools/call` over this descriptor + the exact ACP `mcpServers` shape it accepts = the gated live test
 * (`exec-mcp.live.test.ts`), user-initiated.
 */
import { request as httpRequest } from "node:http";
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
import { startExecMcpLoopbackServer } from "./exec-mcp-loopback.js";
import type { ExecMcpServerDeps } from "./exec-mcp-server.js";

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

/** A spying Fake substrate: records exec calls so we can prove deny vectors never reach the substrate. */
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

async function makeDeps(substrate: SpyFakeSandboxAdapter): Promise<ExecMcpServerDeps> {
  const created = (await substrate.createSandbox(validCtx, { image: "x" })) as {
    sandboxId: string;
  };
  await substrate.startSandbox(validCtx, created.sandboxId);
  const registry = seedRegistry();
  const cost: CostGate = new InMemoryCostGate(1_000_000);
  let receiptId = 0;
  const appender: CommitAppender<unknown, { id: number }> = {
    append: () => Promise.resolve({ id: ++receiptId }),
  };
  const allowRules = [
    { id: "allow-exec", action: "tool:invoke", resource: "exec.**", tenantId: "tenant-a" },
  ];
  return {
    substrate,
    sandboxId: created.sandboxId,
    bindings: seedBindings(),
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
    context: validCtx,
  };
}

/** A minimal Fake MCP client: POST a JSON-RPC request to the loopback URL, parse the JSON response. */
function rpc(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const u = new URL(url);
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": payload.byteLength },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          data += c;
        });
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              json: data.length > 0 ? JSON.parse(data) : null,
            });
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ==================================================================================================
// RED-L1 — the loopback transport binds 127.0.0.1, advertises ONLY the bounded set, and yields a
//          descriptor whose URL is reachable. A Fake MCP client POSTing tools/list gets EXACTLY the
//          registered bounded seed tools (HDI2a: the 7 read-only-safe tools), nothing unexpected.
// ==================================================================================================
describe("EXEC4b (in-repo) — RED-L1 loopback tools/list advertises exactly the bounded seed tools", () => {
  it("binds 127.0.0.1 + a descriptor URL; tools/list over the REAL transport = the bounded seed set", async () => {
    const substrate = new SpyFakeSandboxAdapter();
    const server = await startExecMcpLoopbackServer(await makeDeps(substrate));
    try {
      // The descriptor Hermes would receive is loopback-only.
      expect(server.descriptor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      expect(server.descriptor.name).toBe("agentos-exec");

      const { status, json } = await rpc(server.descriptor.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      expect(status).toBe(200);
      const tools = (json as { result: { tools: { name: string }[] } }).result.tools;
      // EXACTLY the registered bounded seed tools (HDI2a grew this to 7; HDI2b adds exec.run -> 8;
      // CAP1 adds exec.write_file -> 9; CAP2 adds the git family -> 14), nothing unexpected.
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
    } finally {
      await server.close();
    }
  });
});

// ==================================================================================================
// RED-L2 — a bound tools/call executes through the FULL governed pipeline over the loopback transport
//          (the transport does NOT bypass governance): isError:false, real-ish redacted output, the
//          argv was built from the BINDING (not the brain's raw args), and the substrate ran once.
// ==================================================================================================
describe("EXEC4b (in-repo) — RED-L2 a bound tools/call executes through the governed pipeline over loopback", () => {
  it("tools/call exec.echo {text:'hi'} -> isError:false; argv from binding; substrate ran once", async () => {
    const substrate = new SpyFakeSandboxAdapter();
    const server = await startExecMcpLoopbackServer(await makeDeps(substrate));
    try {
      const { json } = await rpc(server.descriptor.url, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "exec.echo", arguments: { text: "hi" } },
      });
      const result = (json as { result: { isError: boolean; content: { text: string }[] } }).result;
      expect(result.isError).toBe(false);
      expect(result.content[0]?.text).toContain("echo hi");
      // The argv was built from the binding (pure vector), NOT from raw MCP arguments.
      expect(substrate.execCalls[0]?.argv).toEqual(["echo", "hi"]);
      expect(substrate.execCalls.length).toBe(1);
    } finally {
      await server.close();
    }
  });
});

// ==================================================================================================
// RED-L3 — the transport does NOT bypass governance: unknown / secret / smuggled-argv tools/call all
//          come back isError:true with ZERO substrate calls (the loopback edge is the governed one).
// ==================================================================================================
describe("EXEC4b (in-repo) — RED-L3 deny vectors over loopback never reach the substrate", () => {
  it("unknown + secret + smuggled-argv all isError:true with ZERO substrate calls", async () => {
    const substrate = new SpyFakeSandboxAdapter();
    const server = await startExecMcpLoopbackServer(await makeDeps(substrate));
    const canary = secretCanary();
    try {
      const denied = [
        { name: "exec.rm", arguments: { path: "/" } }, // policy
        { name: "exec.echo", arguments: { text: "x", argv: "; rm -rf /" } }, // strict-schema
        { name: "exec.echo", arguments: { text: canary } }, // screen
      ];
      let id = 30;
      for (const params of denied) {
        const { json } = await rpc(server.descriptor.url, {
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params,
        });
        const result = (json as { result: { isError: boolean; content: { text: string }[] } })
          .result;
        expect(result.isError).toBe(true);
        // The canary must never egress in the error text (redacted, defense-in-depth).
        expect(result.content[0]?.text ?? "").not.toContain(canary);
      }
      // The load-bearing assertion: NOT ONE deny vector executed over the loopback transport.
      expect(substrate.execCalls.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("a non-POST request (GET) is refused (405) — the server is a JSON-RPC POST endpoint only", async () => {
    const substrate = new SpyFakeSandboxAdapter();
    const server = await startExecMcpLoopbackServer(await makeDeps(substrate));
    try {
      const u = new URL(server.descriptor.url);
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { hostname: u.hostname, port: u.port, path: u.pathname, method: "GET" },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(405);
      expect(substrate.execCalls.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("a malformed (non-JSON) POST body -> a JSON-RPC parse error, never a fabricated ok / never an exec", async () => {
    const substrate = new SpyFakeSandboxAdapter();
    const server = await startExecMcpLoopbackServer(await makeDeps(substrate));
    try {
      const u = new URL(server.descriptor.url);
      const payload = Buffer.from("this is not json", "utf8");
      const { json } = await new Promise<{ json: unknown }>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: u.hostname,
            port: u.port,
            path: u.pathname,
            method: "POST",
            headers: { "content-type": "application/json", "content-length": payload.byteLength },
          },
          (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (c: string) => {
              data += c;
            });
            res.on("end", () => resolve({ json: data.length > 0 ? JSON.parse(data) : null }));
          },
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
      });
      // Fail-closed: a JSON-RPC error envelope, never a fabricated result.
      const env = json as { result?: unknown; error?: { code: number } };
      expect(env.result).toBeUndefined();
      expect(env.error?.code).toBe(-32700);
      expect(substrate.execCalls.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("a POST body LARGER than the 64 KiB cap -> 413; rejected BEFORE parse/dispatch (substrate 0 calls)", async () => {
    const substrate = new SpyFakeSandboxAdapter();
    const server = await startExecMcpLoopbackServer(await makeDeps(substrate));
    try {
      const u = new URL(server.descriptor.url);
      // An OVERSIZED body (> the 64 KiB deny-by-default cap). It is intentionally a well-formed JSON
      // tools/call so that — were the cap removed — it would be parsed + dispatched (the mutation flips
      // this test to 200/parse instead of 413). The cap must reject it BEFORE any buffering past the limit.
      const oversized = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "exec.echo", arguments: { text: "x".repeat(70 * 1024) } },
        }),
        "utf8",
      );
      expect(oversized.byteLength).toBeGreaterThan(64 * 1024);

      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: u.hostname,
            port: u.port,
            path: u.pathname,
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": oversized.byteLength,
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        // The server destroys the request once the cap is exceeded; tolerate the resulting socket reset
        // (ECONNRESET/EPIPE) — the only thing that matters is the 413 status was sent first.
        req.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ECONNRESET" || err.code === "EPIPE") return;
          reject(err);
        });
        req.write(oversized);
        req.end();
      });

      // Deny-by-default: an oversized body is refused with 413 BEFORE any parse/dispatch.
      expect(status).toBe(413);
      // The load-bearing assertion: the oversized body never reached the governed handler -> no exec.
      expect(substrate.execCalls.length).toBe(0);
    } finally {
      await server.close();
    }
  });
});
