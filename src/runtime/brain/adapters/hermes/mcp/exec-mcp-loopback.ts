/**
 * SLICE-EXEC4b — the IN-PROCESS, loopback HTTP transport that fronts the EXEC4a governed MCP server, so a
 * REAL Hermes can AUTONOMOUSLY discover (`tools/list`) + call (`tools/call`) our bounded exec tools and
 * land DIRECTLY in OUR governed pipeline.
 *
 * WHY HTTP/LOOPBACK (the WE-stay-executor argument — the decisive design choice of this slice): Agent OS
 * hosts a Node built-in `http` server bound to `127.0.0.1` on an EPHEMERAL port, IN THE SAME PROCESS that
 * holds the WORM appender + the policy/screen/cost gates. Each request body is a JSON-RPC message that is
 * dispatched to the VERBATIM EXEC4a `createExecMcpServer(deps).handle(...)`, whose `tools/call` routes
 * through the SINGLE execution edge `runGovernedToolCall`. The result returns over the same socket. So:
 *   - the brain (Hermes) is the MCP *client*; it NEVER self-executes — it asks OUR loopback server, and
 *     OUR in-process handler executes + returns;
 *   - the WORM / governance stay in ONE process (the alternative — a stdio bin spawned inside Hermes's
 *     process tree — would split the WORM into a child process; the loopback keeps it whole);
 *   - no new dependency (Node `http`), no egress (127.0.0.1 only), and the descriptor is a single
 *     `{ name, url }` Hermes can be handed in `session/new.mcpServers`.
 *
 * SECURITY POSTURE: loopback-only bind (`127.0.0.1`) — never `0.0.0.0`; POST-only (a GET/other method is
 * 405); a malformed body is a fail-closed JSON-RPC parse error (never a fabricated ok, never an exec); a
 * body size cap rejects an oversized request (deny-by-default). This transport adds NO governance and NO
 * second execution path — it is a thin byte-pipe to the EXEC4a handler, which is the sole authority.
 *
 * HONEST BOUNDARY: in-repo this is proven by a Fake MCP client (a raw HTTP POST of JSON-RPC) over the REAL
 * transport + a Fake substrate (the transport does NOT bypass governance). A REAL Hermes discovering +
 * calling over this descriptor + the EXACT ACP `mcpServers` descriptor shape it accepts = the gated live
 * test (`exec-mcp.live.test.ts`), user-initiated.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone (`adapters/hermes/mcp/`). Imports ONLY Node
 * built-ins + the sibling EXEC4a server module. No deep cross-module import, no vendor named in core.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import {
  type ExecMcpServer,
  type ExecMcpServerDeps,
  createExecMcpServer,
} from "./exec-mcp-server.js";

/**
 * The ACP `mcpServers` descriptor Agent OS advertises to Hermes (a single loopback HTTP endpoint).
 * Matches the ACP `McpServerHttp` schema (acp/schema.py:488) — `headers` is REQUIRED there (a missing
 * `headers` makes `session/new` fail with JSON-RPC -32602 Invalid params; pinned by the EXEC4b live run),
 * so it is always present (empty when we send no headers).
 */
export interface ExecMcpServerDescriptor {
  /** A stable name Hermes uses to reference this server (and to namespace its discovered tools). */
  readonly name: string;
  /** The loopback URL Hermes POSTs JSON-RPC to (always `http://127.0.0.1:<ephemeral-port>/<path>`). */
  readonly url: string;
  /** HTTP headers to set on requests to this server — REQUIRED by ACP McpServerHttp; we send none ([]). */
  readonly headers: readonly { readonly name: string; readonly value: string }[];
}

/** The running in-process loopback MCP server. `close()` tears the HTTP listener down (idempotent). */
export interface ExecMcpLoopbackServer {
  /** The descriptor to advertise in `session/new.mcpServers` (loopback URL + name). */
  readonly descriptor: ExecMcpServerDescriptor;
  /** Stop accepting connections and free the port. Safe to call more than once / in a `finally`. */
  close(): Promise<void>;
}

/** Options for {@link startExecMcpLoopbackServer}. */
export interface ExecMcpLoopbackOptions {
  /** The advertised server name (defaults to "agentos-exec"). */
  readonly name?: string;
  /** The request path (defaults to "/mcp"). The descriptor URL ends with this path. */
  readonly path?: string;
  /** Max request body bytes (deny-by-default cap; defaults to 64 KiB — a JSON-RPC call is tiny). */
  readonly maxBodyBytes?: number;
}

const DEFAULT_NAME = "agentos-exec";
const DEFAULT_PATH = "/mcp";
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const PARSE_ERROR = -32700;

/**
 * Start the in-process loopback MCP server fronting the EXEC4a governed handler. Binds `127.0.0.1` on an
 * EPHEMERAL port (so multiple tests/loops never collide), and resolves with the descriptor + a `close()`.
 *
 * Fail-closed: a non-POST method -> 405; a body over the cap -> 413 (deny-by-default); a malformed JSON
 * body -> a JSON-RPC parse error envelope (never a fabricated ok, never an exec). Every well-formed body
 * is dispatched to the EXEC4a handler, the SOLE governance authority — this layer governs nothing itself.
 */
export function startExecMcpLoopbackServer(
  deps: ExecMcpServerDeps,
  options: ExecMcpLoopbackOptions = {},
): Promise<ExecMcpLoopbackServer> {
  const name = options.name ?? DEFAULT_NAME;
  const path = options.path ?? DEFAULT_PATH;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  // Build the governed handler ONCE (descriptors are derived from the bindings at construction).
  const handler: ExecMcpServer = createExecMcpServer(deps);

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleHttp(req, res, handler, path, maxBodyBytes);
  });

  return new Promise<ExecMcpLoopbackServer>((resolve, reject) => {
    server.on("error", reject);
    // 0 => an ephemeral OS-assigned port; "127.0.0.1" => loopback ONLY (never 0.0.0.0 — no egress).
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("exec-mcp-loopback: failed to bind a loopback port"));
        return;
      }
      const url = `http://127.0.0.1:${address.port}${path}`;
      let closed = false;
      resolve({
        descriptor: { name, url, headers: [] },
        close: () =>
          new Promise<void>((resolveClose) => {
            if (closed) {
              resolveClose();
              return;
            }
            closed = true;
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

/** Handle one HTTP request: POST-only, size-capped, body -> EXEC4a handler -> JSON-RPC response. */
function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  handler: ExecMcpServer,
  path: string,
  maxBodyBytes: number,
): void {
  // POST-only (a JSON-RPC endpoint). Any other method is refused — deny-by-default for the transport.
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  // Path guard: only the advertised path serves the handler (a stray path is a 404, no governance reached).
  const reqPath = (req.url ?? "").split("?")[0];
  if (reqPath !== path) {
    res.writeHead(404).end();
    return;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let aborted = false;
  req.on("data", (chunk: Buffer) => {
    if (aborted) return;
    total += chunk.byteLength;
    if (total > maxBodyBytes) {
      // Deny-by-default: an oversized body is refused outright (never buffered/parsed/dispatched).
      aborted = true;
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("error", () => {
    if (!aborted) {
      aborted = true;
      if (!res.headersSent) res.writeHead(400).end();
    }
  });
  req.on("end", () => {
    if (aborted) return;
    const raw = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Fail-closed: a malformed body is a JSON-RPC parse error — NEVER a fabricated ok, NEVER an exec.
      writeJson(res, 200, {
        jsonrpc: "2.0",
        id: null,
        error: { code: PARSE_ERROR, message: "parse error" },
      });
      return;
    }
    // Dispatch to the EXEC4a handler — the SOLE governance authority. This layer governs nothing itself.
    void handler
      .handle(parsed as Parameters<ExecMcpServer["handle"]>[0])
      .then((response) => writeJson(res, 200, response))
      .catch(() => {
        // A handler that rejected (it should not — it returns error envelopes) is still fail-closed.
        writeJson(res, 200, {
          jsonrpc: "2.0",
          id: null,
          error: { code: PARSE_ERROR, message: "internal error" },
        });
      });
  });
}

/** Serialize a JSON-RPC response to the socket. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res
    .writeHead(status, {
      "content-type": "application/json",
      "content-length": payload.byteLength,
    })
    .end(payload);
}
