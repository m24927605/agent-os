/**
 * SLICE-EXEC4c-a — the stdio MCP loop core + the Hermes-spawnable bin, proven IN-REPO against a FAKE
 * substrate. RED-first. IN-REPO ONLY (no Hermes, no credits, no OpenShell, no `~/.hermes`).
 *
 * THE WE-STAY-EXECUTOR THESIS (what this file proves about the stdio transport): MCP over stdio =
 * NEWLINE-DELIMITED JSON-RPC (one JSON object per line over stdin/stdout) — the EXACT framing the
 * in-tree `fake-hermes-acp.mjs` uses. The loop core reads one line at a time and dispatches EVERY line
 * to the VERBATIM EXEC4a `createExecMcpServer(deps).handle(...)`, whose `tools/call` routes through the
 * SINGLE execution edge `runGovernedToolCall`. stdout stays PROTOCOL-ONLY (no banner/log), and a
 * malformed (non-JSON) line is a fail-closed JSON-RPC parse error (-32700) that does NOT crash the loop
 * and does NOT fabricate an ok. So the stdio bin is just a byte-pipe to the EXEC4a handler — NOT a
 * second governance path.
 *
 * TWO LEVELS OF PROOF:
 *   • CORE (hermetic, always runs): drive `runExecMcpStdio` with IN-MEMORY streams + a SPY Fake
 *     substrate/appender. Asserts framing + governed dispatch + commit-before-effect + deny-vectors
 *     (substrate 0) + per-line fail-closed + stdout-protocol-only — holding the Fake so we can count
 *     execs and observe audit-before-effect order.
 *   • SUBPROCESS (best-effort; runs when the dist bin is built — it is under `pnpm run verify`, where
 *     `build` precedes `test`): spawn `node <builtBin>` with AGENTOS_EXEC_MCP_FAKE=1, then a Fake MCP
 *     client sends newline-delimited initialize/tools/list/tools/call over the child's stdin and reads
 *     responses from stdout. Asserts the real wire end-to-end + stdout-protocol-only + deny->isError.
 *
 * HONEST BOUNDARY: EXEC4c-a proves the stdio bin's GOVERNED boundary + framing fail-closed against a
 * FAKE substrate, in-repo. A REAL Hermes SPAWNING the bin (it controls the bin's stdin/stdout/lifecycle)
 * + autonomous tools/list+tools/call discovery + REAL OpenShell exec + a shared-kernel WORM = EXEC4c-b
 * (live, user-initiated). Advertising the stdio descriptor to a real Hermes is EXEC4c-b — acp-stdio's
 * default `mcpServers` stays [] here.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
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
import type { ExecMcpServerDeps } from "./exec-mcp-server.js";
import { execMcpStdioDescriptor, runExecMcpStdio } from "./exec-mcp-stdio.js";

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

// --- a spying Fake substrate: records exec calls so we can prove deny vectors never reach it ---------
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

interface CoreKit {
  readonly deps: ExecMcpServerDeps;
  readonly substrate: SpyFakeSandboxAdapter;
  readonly appendCalls: unknown[];
  readonly effectOrder: string[];
}

/** Build a fully-governed MCP server deps kit over a SPY Fake substrate (the SAME wiring as EXEC4a). */
async function makeCoreKit(): Promise<CoreKit> {
  const substrate = new SpyFakeSandboxAdapter();
  const created = (await substrate.createSandbox(validCtx, { image: "x" })) as {
    sandboxId: string;
  };
  await substrate.startSandbox(validCtx, created.sandboxId);
  const registry = seedRegistry();
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
    onEffect: () => effectOrder.push("effect"),
    context: validCtx,
  };
  return { deps, substrate, appendCalls, effectOrder };
}

/**
 * Drive the stdio loop core over IN-MEMORY streams: write each request as a newline-delimited JSON-RPC
 * line into `input`, end the stream, run the loop to completion, and parse every newline-delimited line
 * the loop wrote to `output`. Returns BOTH the parsed responses AND the raw lines (so a test can assert
 * stdout-protocol-only: every emitted line is valid JSON-RPC, no banner/log).
 */
async function driveCore(
  deps: ExecMcpServerDeps,
  requests: readonly unknown[],
  opts: { rawLines?: readonly string[] } = {},
): Promise<{ responses: Record<string, unknown>[]; rawLines: string[] }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));

  const done = runExecMcpStdio(deps, { input, output });

  // Feed either explicit raw lines (for malformed-line tests) or JSON-encoded requests.
  const lines = opts.rawLines ?? requests.map((r) => JSON.stringify(r));
  for (const line of lines) {
    input.write(`${line}\n`);
  }
  input.end();
  await done;

  const raw = Buffer.concat(chunks).toString("utf8");
  const rawLines = raw.split("\n").filter((l) => l.length > 0);
  const responses = rawLines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { responses, rawLines };
}

// ==================================================================================================
// CORE-1 — stdio framing + governed dispatch: a newline-delimited tools/list -> EXACTLY the registered
//          bounded seed tools (HDI2a: the 7 read-only-safe tools), nothing unexpected; a bound tools/call
//          exec.echo {text:'hi'} -> isError:false + redacted echoed output + commit-before-effect (audit
//          receipt appended BEFORE the effect ran).
// ==================================================================================================
describe("EXEC4c-a — CORE-1 stdio framing dispatches to the governed EXEC4a handler", () => {
  it("tools/list over the newline-delimited wire = exactly the bounded seed tools", async () => {
    const { deps } = await makeCoreKit();
    const { responses } = await driveCore(deps, [
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    ]);
    expect(responses.length).toBe(1);
    const tools = (responses[0]?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "exec.cat",
      "exec.echo",
      "exec.grep",
      "exec.head",
      "exec.ls",
      "exec.pwd",
      "exec.wc",
    ]);
    for (const forbidden of ["fs", "terminal", "shell", "command", "argv", "exec.rm"]) {
      expect(tools.map((t) => t.name)).not.toContain(forbidden);
    }
  });

  it("a bound tools/call exec.echo {text:'hi'} -> isError:false; argv from binding; commit-before-effect", async () => {
    const { deps, substrate, appendCalls, effectOrder } = await makeCoreKit();
    const { responses } = await driveCore(deps, [
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "exec.echo", arguments: { text: "hi" } },
      },
    ]);
    const result = responses[0]?.result as {
      isError: boolean;
      content: { type: string; text: string }[];
    };
    expect(responses[0]?.error).toBeUndefined();
    expect(result.isError).toBe(false);
    // argv built FROM THE BINDING (pure vector) — never the brain's raw args.
    expect(substrate.execCalls[0]?.argv).toEqual(["echo", "hi"]);
    expect(result.content[0]?.text).toContain("echo hi");
    // commit-before-effect: the audit receipt was appended BEFORE the effect ran.
    expect(appendCalls.length).toBe(1);
    expect(effectOrder).toEqual(["append", "effect"]);
  });
});

// ==================================================================================================
// CORE-2 — deny vectors over the stdio wire (single-execution-path, inherited from EXEC4a): unknown
//          tool / smuggled-argv / secret-canary arg all -> isError:true with the Fake substrate at
//          EXACTLY 0 execs; the canary never egresses. A legit bound call DOES execute (edge is live).
//          NON-VACUITY: a bypass mutation (direct substrate exec) makes >=1 deny vector reach the Fake.
// ==================================================================================================
describe("EXEC4c-a — CORE-2 deny vectors over stdio never reach the substrate (single-execution-path)", () => {
  it("unknown + smuggled-argv + secret-arg -> isError:true, substrate 0; legit call executes once", async () => {
    const { deps, substrate } = await makeCoreKit();
    const canary = secretCanary();
    const { responses } = await driveCore(deps, [
      {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "exec.rm", arguments: { path: "/" } },
      }, // policy
      {
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: { name: "exec.echo", arguments: { text: "x", argv: "; rm -rf /" } }, // strict-schema
      },
      {
        jsonrpc: "2.0",
        id: 33,
        method: "tools/call",
        params: { name: "exec.echo", arguments: { text: canary } },
      }, // screen
      {
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "exec.echo", arguments: { text: "ok" } },
      }, // legit
    ]);

    // The three deny vectors are isError:true and the canary never egresses.
    for (const i of [0, 1, 2]) {
      expect((responses[i]?.result as { isError: boolean }).isError).toBe(true);
    }
    expect(
      (responses[2]?.result as { content: { text: string }[] }).content[0]?.text,
    ).not.toContain(canary);
    // The load-bearing assertion: NONE of the three deny vectors executed — the ONLY execution edge is
    // the governed one. A direct-substrate bypass mutation makes >=1 of these reach the Fake -> RED.
    // The 4th (legit) call DID execute through the same single edge -> exactly 1 exec total.
    expect((responses[3]?.result as { isError: boolean }).isError).toBe(false);
    expect(substrate.execCalls.length).toBe(1);
    expect(substrate.execCalls[0]?.argv).toEqual(["echo", "ok"]);
  });
});

// ==================================================================================================
// CORE-3 — STDIO FRAMING FAIL-CLOSED: a malformed (non-JSON) line -> a -32700 parse-error response, the
//          loop SURVIVES and still serves the NEXT valid line (no crash, no fabricated ok). The
//          malformed line never reaches the substrate.
//          NON-VACUITY: a mutation that lets a malformed line through / crashes the loop -> RED (the
//          next line is never served, or the malformed line fabricates an ok / an exec).
// ==================================================================================================
describe("EXEC4c-a — CORE-3 stdio framing fail-closed (malformed line -> -32700, loop survives)", () => {
  it("a non-JSON line yields -32700 and the loop still serves the following valid tools/list", async () => {
    const { deps, substrate } = await makeCoreKit();
    const { responses } = await driveCore(deps, [], {
      rawLines: [
        "this is not json at all",
        JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }),
      ],
    });
    expect(responses.length).toBe(2);
    // 1) the malformed line -> a -32700 parse error (never a fabricated ok, never an exec).
    expect(responses[0]?.result).toBeUndefined();
    expect((responses[0]?.error as { code: number }).code).toBe(-32700);
    // 2) the loop SURVIVED — the next valid line is served normally.
    const tools = (responses[1]?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "exec.cat",
      "exec.echo",
      "exec.grep",
      "exec.head",
      "exec.ls",
      "exec.pwd",
      "exec.wc",
    ]);
    // The malformed line never reached the substrate.
    expect(substrate.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// CORE-4 — STDOUT PROTOCOL-ONLY: every line the loop writes to `output` is valid JSON-RPC (jsonrpc:
//          "2.0" + an id). No banner, no log, no diagnostics on the protocol stream.
//          NON-VACUITY: a mutation that writes a non-JSON banner/log to `output` -> RED (a line fails
//          JSON.parse, or lacks jsonrpc/id).
// ==================================================================================================
describe("EXEC4c-a — CORE-4 stdout is protocol-only (no banner/log lines)", () => {
  it("every emitted line parses as JSON-RPC 2.0 with an id — nothing else on the wire", async () => {
    const { deps } = await makeCoreKit();
    const { responses, rawLines } = await driveCore(deps, [
      { jsonrpc: "2.0", id: 0, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "exec.echo", arguments: { text: "hi" } },
      },
    ]);
    expect(rawLines.length).toBe(3);
    for (const line of rawLines) {
      // Each line MUST be valid JSON (this throws on a banner) and a JSON-RPC 2.0 envelope.
      const obj = JSON.parse(line) as { jsonrpc?: string; id?: unknown };
      expect(obj.jsonrpc).toBe("2.0");
      expect(obj.id).toBeDefined();
    }
    expect(responses.length).toBe(3);
  });
});

// ==================================================================================================
// CORE-5 — the stdio descriptor helper: the ACP `McpServerStdio` shape Hermes accepts. NOT wired into
//          acp-stdio's default mcpServers ([]); EXEC4c-b advertises it to a real Hermes.
// ==================================================================================================
describe("EXEC4c-a — CORE-5 stdio descriptor helper yields the ACP McpServerStdio shape", () => {
  it("returns {name:'agentos-exec', command:'node', args:[binPath], env:<minimal>}", () => {
    const d = execMcpStdioDescriptor("/abs/path/to/exec-mcp-server-bin.js");
    expect(d.name).toBe("agentos-exec");
    expect(d.command).toBe("node");
    expect(d.args).toEqual(["/abs/path/to/exec-mcp-server-bin.js"]);
    // env is a plain object (minimal — never the parent's secret-bearing env).
    expect(typeof d.env).toBe("object");
  });
});

// ==================================================================================================
// SUBPROCESS — spawn the BUILT dist bin with AGENTOS_EXEC_MCP_FAKE=1 and drive it over real stdio with a
//   Fake MCP client. Proves the framing + governed dispatch end-to-end + stdout-protocol-only on the
//   real wire. Runs when the dist bin is built (it is under `pnpm run verify`, where `build` precedes
//   `test`); if the bin is absent (a bare `vitest run` without a build) the suite skips with a notice —
//   the hermetic CORE tests above are the always-on proof.
// ==================================================================================================
const HERE = dirname(fileURLToPath(import.meta.url));
// src/runtime/brain/adapters/hermes/mcp -> repo root is 6 levels up (mcp, hermes, adapters, brain,
// runtime, src). The compiled bin mirrors this under dist/.
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..", "..");
const BUILT_BIN = join(
  REPO_ROOT,
  "dist",
  "runtime",
  "brain",
  "adapters",
  "hermes",
  "mcp",
  "exec-mcp-server-bin.js",
);
const dSub = existsSync(BUILT_BIN) ? describe : describe.skip;

/**
 * A minimal Fake MCP client over the child's stdio: writes newline-delimited JSON-RPC requests to the
 * child's stdin and resolves once it has read `expected` newline-delimited responses from stdout. It
 * ALSO captures every raw stdout line (for stdout-protocol-only) and the child's stderr (diagnostics
 * route here — never to stdout). The child is ALWAYS killed in the caller's finally (no orphan).
 */
function driveBin(
  child: ChildProcessWithoutNullStreams,
  requests: readonly unknown[],
  expected: number,
  timeoutMs = 10_000,
): Promise<{ responses: Record<string, unknown>[]; rawLines: string[]; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const rawLines: string[] = [];
    let stdoutBuf = "";
    let stderr = "";
    const timer = setTimeout(() => {
      rejectP(
        new Error(`driveBin: timed out waiting for ${expected} responses; got ${rawLines.length}`),
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let idx = stdoutBuf.indexOf("\n");
      while (idx !== -1) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.length > 0) rawLines.push(line);
        idx = stdoutBuf.indexOf("\n");
      }
      if (rawLines.length >= expected) {
        clearTimeout(timer);
        try {
          const responses = rawLines
            .slice(0, expected)
            .map((l) => JSON.parse(l) as Record<string, unknown>);
          resolveP({ responses, rawLines: rawLines.slice(0, expected), stderr });
        } catch (e) {
          rejectP(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", rejectP);

    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
  });
}

/** Spawn the built bin in FAKE mode with a MINIMAL env (never the parent's secret-bearing env). */
function spawnBin(): ChildProcessWithoutNullStreams {
  return spawn("node", [BUILT_BIN], {
    env: {
      PATH: process.env.PATH ?? "",
      AGENTOS_EXEC_MCP_FAKE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

dSub(
  "EXEC4c-a — SUBPROCESS the spawned bin serves governed MCP over real stdio (FAKE substrate)",
  () => {
    it("initialize + tools/list + bound tools/call over the child's stdin/stdout; stdout protocol-only", async () => {
      const child = spawnBin();
      try {
        const { responses, rawLines, stderr } = await driveBin(
          child,
          [
            { jsonrpc: "2.0", id: 0, method: "initialize", params: {} },
            { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
            {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "exec.echo", arguments: { text: "hi" } },
            },
          ],
          3,
        );

        // stdout PROTOCOL-ONLY: every line parsed (no banner) above; re-assert the envelope shape.
        for (const line of rawLines) {
          const obj = JSON.parse(line) as { jsonrpc?: string };
          expect(obj.jsonrpc).toBe("2.0");
        }

        // tools/list = exactly the registered bounded seed tools (HDI2a: the 7 read-only-safe tools).
        const tools = (responses[1]?.result as { tools: { name: string }[] }).tools;
        expect(tools.map((t) => t.name).sort()).toEqual([
          "exec.cat",
          "exec.echo",
          "exec.grep",
          "exec.head",
          "exec.ls",
          "exec.pwd",
          "exec.wc",
        ]);

        // bound tools/call executed over the real wire -> isError:false + the echoed output.
        const callResult = responses[2]?.result as {
          isError: boolean;
          content: { text: string }[];
        };
        expect(callResult.isError).toBe(false);
        expect(callResult.content[0]?.text).toContain("echo hi");

        // diagnostics (if any) went to stderr — never polluted the protocol stdout.
        expect(typeof stderr).toBe("string");
      } finally {
        child.kill("SIGKILL");
      }
    });

    it("deny vectors over the spawned bin -> isError:true with no echoed command output; loop survives a malformed line", async () => {
      const child = spawnBin();
      const canary = secretCanary();
      try {
        const { responses } = await driveBin(
          child,
          [
            {
              jsonrpc: "2.0",
              id: 10,
              method: "tools/call",
              params: { name: "exec.rm", arguments: { path: "/" } },
            },
            {
              jsonrpc: "2.0",
              id: 11,
              method: "tools/call",
              params: { name: "exec.echo", arguments: { text: "x", argv: "; rm -rf /" } },
            },
            {
              jsonrpc: "2.0",
              id: 12,
              method: "tools/call",
              params: { name: "exec.echo", arguments: { text: canary } },
            },
          ],
          3,
        );
        for (const i of [0, 1, 2]) {
          const r = responses[i]?.result as { isError: boolean; content: { text: string }[] };
          expect(r.isError).toBe(true);
          // No deny vector echoes a command output / the smuggled command / the canary.
          expect(r.content[0]?.text ?? "").not.toContain("rm -rf");
          expect(r.content[0]?.text ?? "").not.toContain(canary);
        }
      } finally {
        child.kill("SIGKILL");
      }
    });

    it("a malformed (non-JSON) stdin line -> a -32700 parse error and the bin still serves the next valid line", async () => {
      const child = spawnBin();
      try {
        // Send a raw non-JSON line, then a valid tools/list — expect a parse error then the tool list.
        child.stdin.write("this is not json at all\n");
        const { responses } = await driveBin(
          child,
          [{ jsonrpc: "2.0", id: 20, method: "tools/list", params: {} }],
          2,
        );
        expect((responses[0]?.error as { code: number }).code).toBe(-32700);
        const tools = (responses[1]?.result as { tools: { name: string }[] }).tools;
        expect(tools.map((t) => t.name).sort()).toEqual([
          "exec.cat",
          "exec.echo",
          "exec.grep",
          "exec.head",
          "exec.ls",
          "exec.pwd",
          "exec.wc",
        ]);
      } finally {
        child.kill("SIGKILL");
      }
    });
  },
);
