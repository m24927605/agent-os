/**
 * SLICE-EXEC4c-a — the STDIO transport core that fronts the EXEC4a governed MCP server, so a REAL Hermes
 * that SPAWNS this as a subprocess can AUTONOMOUSLY discover (`tools/list`) + call (`tools/call`) our
 * bounded exec tools and land DIRECTLY in OUR governed pipeline.
 *
 * WHY STDIO (the live constraint — pinned by EXEC4b live): `hermes acp` only supports STDIO MCP servers
 * (its ACP AgentCapabilities advertise no http/sse MCP capability; "ACP is stdio-only, local-trust"). So
 * the autonomous path = Hermes SPAWNS an Agent OS stdio MCP server bin. This module is the testable loop
 * CORE of that bin: read newline-delimited JSON-RPC from an input stream, dispatch each line to the
 * VERBATIM EXEC4a `createExecMcpServer(deps).handle(...)`, and write the newline-delimited response to an
 * output stream. The bin entry (`exec-mcp-server-bin.ts`) runs this core over process.stdin/stdout.
 *
 * THE FRAMING (same as the in-tree `fake-hermes-acp.mjs`): MCP over stdio = ONE JSON object per line.
 * stdin is line-buffered; each complete line is parsed and dispatched; the response is serialized as
 * `JSON.stringify(res) + "\n"` to the output. The loop resolves when the input stream ends (EOF).
 *
 * FAIL-CLOSED, PER LINE (deny-by-default at the transport): a malformed (non-JSON) line is answered with
 * a JSON-RPC parse error (-32700) — NEVER a fabricated ok, NEVER an exec — and the loop SURVIVES to serve
 * the next valid line (one bad line never crashes the server). The EXEC4a handler itself is the SOLE
 * governance authority; this transport governs NOTHING and adds NO second execution path — it is a thin
 * byte-pipe to the single governed edge `runGovernedToolCall`.
 *
 * STDOUT PROTOCOL-ONLY: the ONLY thing written to `output` is protocol JSON-RPC (one envelope per line).
 * No banner, no log, no diagnostics — exactly the ACP stdio discipline (a real Hermes parses stdout as
 * the wire). The bin routes any diagnostics to stderr.
 *
 * HONEST BOUNDARY: in-repo this is proven by a Fake MCP client driving the REAL core over in-memory
 * streams (+ a Fake substrate); the spawned bin under FAKE mode proves the real wire. A REAL Hermes
 * SPAWNING the bin + autonomous discovery + REAL OpenShell exec + a shared-kernel WORM = EXEC4c-b (live).
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone (`adapters/hermes/mcp/`). Imports ONLY Node
 * built-ins + the sibling EXEC4a server module. No deep cross-module import, no vendor named in core.
 */
import type { Readable, Writable } from "node:stream";
import {
  type ExecMcpServer,
  type ExecMcpServerDeps,
  type JsonRpcResponse,
  createExecMcpServer,
} from "./exec-mcp-server.js";

/** JSON-RPC parse-error code (a malformed line). Mirrors the EXEC4a handler + the loopback transport. */
const PARSE_ERROR = -32700;

/** The in-memory streams the loop core reads from / writes to (process.stdin/stdout in the bin). */
export interface ExecMcpStdioIo {
  /** Newline-delimited JSON-RPC requests arrive here (one JSON object per line). */
  readonly input: Readable;
  /** Newline-delimited JSON-RPC responses are written here — PROTOCOL-ONLY (no banner/log). */
  readonly output: Writable;
}

/**
 * Run the stdio MCP loop CORE: read newline-delimited JSON-RPC lines from `io.input`, dispatch each to
 * the VERBATIM EXEC4a governed handler, and write each response as a newline-delimited JSON-RPC envelope
 * to `io.output`. Resolves when `io.input` ends (EOF). Fail-closed PER LINE: a malformed line -> a
 * -32700 parse-error response, the loop survives. Nothing but protocol JSON ever reaches `io.output`.
 *
 * Lines are dispatched SEQUENTIALLY (await each handler before the next) so a slow effect never reorders
 * responses on the wire — MCP request/response ordering is preserved. The handler returns error
 * envelopes (never throws); a defensive catch still maps any unexpected throw to a fail-closed parse
 * error rather than crashing the loop or fabricating an ok.
 */
export function runExecMcpStdio(deps: ExecMcpServerDeps, io: ExecMcpStdioIo): Promise<void> {
  // Build the governed handler ONCE (descriptors derive from the bindings at construction).
  const handler: ExecMcpServer = createExecMcpServer(deps);

  return new Promise<void>((resolve, reject) => {
    let buffer = "";
    // A single-threaded line queue: each line awaits the previous one so responses stay ordered and a
    // bad line cannot race ahead of a good one. `chain` is the tail of the work promise.
    let chain: Promise<void> = Promise.resolve();
    let ended = false;

    /** Serialize one response envelope as a newline-delimited line to the (protocol-only) output. */
    const writeResponse = (response: JsonRpcResponse): void => {
      io.output.write(`${JSON.stringify(response)}\n`);
    };

    /** Process ONE complete line: parse -> dispatch -> write. Fail-closed per line (never throws out). */
    const handleLine = async (line: string): Promise<void> => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Fail-closed: a malformed line is a JSON-RPC parse error — NEVER a fabricated ok, NEVER an
        // exec. The loop survives to serve the next line.
        writeResponse({
          jsonrpc: "2.0",
          id: null,
          error: { code: PARSE_ERROR, message: "parse error" },
        });
        return;
      }
      try {
        const response = await handler.handle(parsed as Parameters<ExecMcpServer["handle"]>[0]);
        writeResponse(response);
      } catch {
        // The handler returns error envelopes and should never throw; if it ever did, stay fail-closed
        // (a parse-error envelope, never a fabricated ok) and keep the loop alive.
        writeResponse({
          jsonrpc: "2.0",
          id: null,
          error: { code: PARSE_ERROR, message: "internal error" },
        });
      }
    };

    /** Enqueue a line onto the sequential work chain. */
    const enqueue = (line: string): void => {
      chain = chain.then(() => handleLine(line));
    };

    io.input.setEncoding("utf8");
    io.input.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) enqueue(line);
        idx = buffer.indexOf("\n");
      }
    });

    const finish = (): void => {
      if (ended) return;
      ended = true;
      // Drain a final un-terminated line (a producer that sent the last request without a trailing
      // newline before closing), then resolve once the work chain is flushed.
      const tail = buffer;
      buffer = "";
      if (tail.length > 0) enqueue(tail);
      chain.then(() => resolve()).catch(reject);
    };

    io.input.on("end", finish);
    io.input.on("close", finish);
    io.input.on("error", reject);
  });
}

// ------------------------------------------------------------------------------------------------
// The stdio descriptor helper — the ACP `McpServerStdio` shape a real Hermes accepts (EXEC4c-b
// advertises it; here it is NOT wired into acp-stdio's default mcpServers, which stays []).
// ------------------------------------------------------------------------------------------------

/**
 * The ACP `McpServerStdio` descriptor Agent OS advertises to Hermes so it SPAWNS our governed bin and
 * speaks MCP to it over the child's stdin/stdout. `command`+`args` are the spawn line (`node <bin>`);
 * `env` is the MINIMAL env the child runs under (NEVER the parent's secret-bearing env, NEVER `~/.hermes`).
 */
export interface ExecMcpStdioDescriptor {
  /** A stable name Hermes uses to reference this server (and to namespace its discovered tools). */
  readonly name: string;
  /** The executable to spawn — always `node` (the bin is a compiled Agent OS `.js`). */
  readonly command: string;
  /** The args — the absolute path to the built bin. */
  readonly args: readonly string[];
  /**
   * The MINIMAL env the spawned bin runs under (no Agent OS secret; placeholder-only). Matches the ACP
   * `McpServerStdio.env` schema (acp/schema.py: `List[EnvVariable]`) — a LIST of `{name, value}` objects,
   * NOT a dict (a dict-shaped env makes `session/new` fail with JSON-RPC -32602; pinned by the EXEC4c-b
   * live run).
   */
  readonly env: readonly { readonly name: string; readonly value: string }[];
}

const DEFAULT_NAME = "agentos-exec";

/**
 * Build the stdio descriptor for the governed exec MCP bin at `binPath`. The default env carries ONLY
 * the FAKE-mode flag is NOT set here (a real Hermes spawns the bin in REAL mode); pass `env` to add the
 * minimal vars the bin needs (still never a secret). The descriptor is the ACP `McpServerStdio` shape.
 *
 * Deliberately NOT wired into `acp-stdio.ts`'s default `mcpServers` ([]) — advertising this to a real
 * Hermes is EXEC4c-b (a posture decision), not EXEC4c-a.
 */
export function execMcpStdioDescriptor(
  binPath: string,
  env: Readonly<Record<string, string>> = {},
): ExecMcpStdioDescriptor {
  return {
    name: DEFAULT_NAME,
    command: "node",
    args: [binPath],
    // ACP McpServerStdio.env is List[EnvVariable] ({name, value}) — serialize the ergonomic Record to it.
    env: Object.entries(env).map(([name, value]) => ({ name, value })),
  };
}
