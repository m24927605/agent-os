/**
 * AcpStdioTransport — the REAL `DesktopHermesTransport` (SLICE-DHB2a).
 *
 * It spawns a local `hermes acp` subprocess and drives it over ACP (Agent Client Protocol): JSON-RPC
 * 2.0, newline-delimited (one JSON object per line) over the child's stdin/stdout. For each intent it
 * performs the handshake `initialize` -> `session/new` -> `session/prompt(intent)`, streams the
 * agent's `session/update` notifications back as `AcpUpdateFrame`s, and ends when the prompt resolves
 * with a `stopReason`. It is the live wire DHB1 left as an injected seam (the `FakeDesktopHermesTransport`
 * placeholder); DHB2a proves it against an in-tree FAKE `hermes acp` subprocess (no model call, no
 * credits). The real Hermes full chain + its exact ACP dialect = DHB2b (live, user-initiated).
 *
 * PROPOSE-ONLY: when the agent sends `session/request_permission` (asking to EXECUTE a tool), this
 * transport answers with a DENY (cancelled) outcome — Hermes therefore NEVER self-executes a tool.
 * The proposed `tool_call` still arrives as a `session/update`; that is the proposal Agent OS governs.
 * Any other agent->client request (fs/read_text_file, fs/write_text_file, terminal/*) is answered with
 * a JSON-RPC method-not-found error — we declared NO fs/terminal client capability (deny-by-default).
 *
 * CREDENTIAL-BLIND: the ONLY data written to the child's stdin is the JSON-RPC protocol + the intent
 * text. It NEVER reads `~/.hermes` (`.env`/`auth.json`), NEVER puts an Agent OS secret on stdin, and
 * runs the child with a MINIMAL env (it does NOT forward the parent's full secret-bearing env). Hermes
 * self-manages its own model key in its own config — not our concern, never touched.
 *
 * FAIL-CLOSED (deny-by-default): spawn failure (ENOENT), non-zero exit before the prompt completes, a
 * malformed JSON line, a JSON-RPC error response to initialize/session/new/session/prompt, or stdout
 * EOF mid-prompt all THROW out of `submit` (so `DesktopHermesTurnSource` stops and the brain stream is
 * denied-by-default). A fabricated/partial "ok" frame is NEVER yielded after an error.
 *
 * Child lifecycle: the child is killed and its streams torn down on completion, on error, AND if the
 * consumer stops iterating early (a `finally` in the async generator) — no orphaned subprocess.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone (no-vendor-in-core compliant), imports
 * ONLY Node built-ins + the in-module DHB1 transport types. Exported via the hermes barrel (index.ts).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type {
  AcpUpdateFrame,
  DesktopHermesTransport,
  DuplexDesktopHermesTransport,
  HermesLoopSession,
  HermesLoopTurn,
} from "./desktop.js";

/** Construction options for {@link AcpStdioTransport}. */
export interface AcpStdioTransportOptions {
  /** The command + args to spawn. Default: `["hermes", "acp"]`. */
  readonly command?: readonly string[];
  /** Working directory for the child. Default: the parent's cwd. */
  readonly cwd?: string;
  /**
   * Extra env for the child, merged over a MINIMAL base (PATH/HOME only). NEVER pass an Agent OS
   * secret here — and the parent's full secret-bearing env is deliberately NOT forwarded.
   */
  readonly env?: Record<string, string>;
  /** Max ms to wait for the spawned child to be usable before failing closed. Default: 10_000. */
  readonly startupTimeoutMs?: number;
  /** Max ms of stream inactivity (no line, no exit) before failing closed. Default: 30_000. */
  readonly idleTimeoutMs?: number;
}

/** Minimal ACP protocol version we negotiate. Kept conservative; the real dialect is pinned in DHB2b. */
const PROTOCOL_VERSION = 1;

/**
 * MINIMAL client capabilities — explicitly NO `fs` and NO `terminal`. This is part of propose-only +
 * credential-blind: with no such capability advertised, the agent cannot legitimately request host
 * file/terminal access, and any attempt is answered with a method-not-found error.
 */
const CLIENT_CAPABILITIES = Object.freeze({}) as Record<string, unknown>;

/** A parsed JSON-RPC 2.0 message (request | response | notification), modelled permissively. */
interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/** Resolve a minimal child env. NEVER inherit the parent's full (secret-bearing) env. */
function minimalEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  // PATH so the command (e.g. `node`, `hermes`) resolves; HOME because some runtimes require it.
  if (typeof process.env.PATH === "string") base.PATH = process.env.PATH;
  if (typeof process.env.HOME === "string") base.HOME = process.env.HOME;
  return { ...base, ...(extra ?? {}) };
}

/**
 * A small async queue: a producer pushes frames / errors / end; a consumer awaits them in order.
 * Used to bridge the event-driven child streams into the `submit` async generator.
 */
class FrameChannel {
  private readonly frames: AcpUpdateFrame[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;
  private failure: Error | null = null;

  push(frame: AcpUpdateFrame): void {
    if (this.ended || this.failure !== null) return;
    this.frames.push(frame);
    this.wake();
  }

  end(): void {
    if (this.ended || this.failure !== null) return;
    this.ended = true;
    this.wake();
  }

  fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    if (w !== null) w();
  }

  /** Pull the next frame, or null when the stream has ended. Throws if the stream failed. */
  async next(): Promise<AcpUpdateFrame | null> {
    for (;;) {
      if (this.frames.length > 0) return this.frames.shift() as AcpUpdateFrame;
      if (this.failure !== null) throw this.failure;
      if (this.ended) return null;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

export class AcpStdioTransport implements DuplexDesktopHermesTransport {
  private readonly command: readonly string[];
  private readonly cwd: string | undefined;
  private readonly env: Record<string, string> | undefined;
  private readonly startupTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(options: AcpStdioTransportOptions = {}) {
    this.command = options.command ?? ["hermes", "acp"];
    this.cwd = options.cwd;
    this.env = options.env;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
  }

  /**
   * Open a HELD duplex ACP session (SLICE-DHB3a). Spawns ONE `hermes acp` child, performs the
   * `initialize` -> `session/new` handshake, captures the sessionId, and keeps the child alive across
   * MULTIPLE `session/prompt` turns on that one sessionId — so the DRIVER can govern each turn's
   * proposals and feed the (redacted) outcome back as the next prompt. The propose-only deny
   * (`session/request_permission` -> cancelled) and the fs/terminal `-32601` deny are answered VERBATIM
   * on EVERY turn. Teardown (SIGKILL) happens on `close()`, on a terminal/error, or if the loop ends.
   * Fail-closed is unchanged: spawn / nonzero / malformed / EOF / JSON-RPC-error reject out of the
   * session's `nextTurn`/`feed` (deny-by-default). The one-shot `submit` above is untouched.
   */
  async openSession(intent: string): Promise<HermesLoopSession> {
    const session = new DuplexAcpSession({
      command: this.command,
      cwd: this.cwd,
      env: this.env,
      startupTimeoutMs: this.startupTimeoutMs,
      idleTimeoutMs: this.idleTimeoutMs,
      firstIntent: intent,
    });
    await session.start();
    return session;
  }

  async *submit(intent: string): AsyncIterable<AcpUpdateFrame> {
    const [cmd, ...args] = this.command;
    if (cmd === undefined) {
      throw new Error("AcpStdioTransport: empty command");
    }

    const channel = new FrameChannel();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(cmd, args, {
        cwd: this.cwd,
        env: minimalEnv(this.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      // Synchronous spawn throw -> fail-closed.
      throw error instanceof Error ? error : new Error(String(error));
    }

    // --- request-id correlation + prompt completion -------------------------------------------------
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve: (result: unknown) => void; reject: (error: Error) => void }
    >();
    let promptDone = false;
    let idleTimer: NodeJS.Timeout | null = null;

    const writeMessage = (message: Record<string, unknown>): void => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        writeMessage({ jsonrpc: "2.0", id, method, params });
      });
    };

    const failAll = (error: Error): void => {
      for (const [, p] of pending) p.reject(error);
      pending.clear();
      channel.fail(error);
    };

    const resetIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        failAll(new Error("AcpStdioTransport: idle timeout — no activity from `hermes acp`"));
      }, this.idleTimeoutMs);
      idleTimer.unref?.();
    };

    // --- agent->client request handling (propose-only + deny-by-default) ----------------------------
    const handleAgentRequest = (msg: JsonRpcMessage): void => {
      const id = msg.id as number | string;
      switch (msg.method) {
        case "session/request_permission":
          // PROPOSE-ONLY: deny execution. The tool_call already arrived as a session/update; Hermes
          // must NEVER self-execute it. We answer with a cancelled outcome so no option is selected.
          writeMessage({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
          return;
        default:
          // fs/read_text_file, fs/write_text_file, terminal/*, or anything else: we advertised NO such
          // capability -> method not found / not permitted (deny-by-default).
          writeMessage({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `not permitted: ${msg.method ?? "unknown"}` },
          });
          return;
      }
    };

    const handleMessage = (msg: JsonRpcMessage): void => {
      // A notification or request from the agent has a `method`.
      if (typeof msg.method === "string") {
        if (msg.method === "session/update") {
          const update = (msg.params as { update?: unknown } | undefined)?.update;
          if (update !== null && typeof update === "object") {
            channel.push(update as AcpUpdateFrame);
          }
          return;
        }
        if (msg.id !== undefined) {
          // An agent->client REQUEST (has an id) — e.g. session/request_permission.
          handleAgentRequest(msg);
        }
        // Other agent notifications (no id) are ignored.
        return;
      }
      // Otherwise it is a RESPONSE to one of our requests (correlate by id).
      if (msg.id !== undefined && (typeof msg.id === "number" || typeof msg.id === "string")) {
        const waiter = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
        if (waiter !== undefined) {
          pending.delete(msg.id as number);
          if (msg.error !== undefined) {
            waiter.reject(
              new Error(
                `AcpStdioTransport: JSON-RPC error ${msg.error.code ?? ""} ${msg.error.message ?? ""}`.trim(),
              ),
            );
          } else {
            waiter.resolve(msg.result);
          }
        }
      }
    };

    // --- stdout line buffering: parse newline-delimited JSON-RPC ------------------------------------
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      resetIdle();
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          let parsed: JsonRpcMessage;
          try {
            parsed = JSON.parse(line) as JsonRpcMessage;
          } catch {
            // A malformed (non-JSON) line -> fail-closed. Never yield a fabricated ok frame after.
            failAll(new Error("AcpStdioTransport: malformed JSON-RPC line from `hermes acp`"));
            return;
          }
          handleMessage(parsed);
        }
        idx = buffer.indexOf("\n");
      }
    });

    // Surface child stderr nowhere sensitive; ignore content (it may carry vendor noise).
    child.stderr.resume();

    child.on("error", (error: Error) => {
      // Spawn failure (ENOENT) or runtime stream error -> fail-closed.
      failAll(error);
    });

    child.on("exit", (code) => {
      if (!promptDone) {
        // Exit (zero OR non-zero) BEFORE the prompt resolved -> fail-closed (EOF / premature exit).
        failAll(
          new Error(
            `AcpStdioTransport: \`hermes acp\` exited (code ${code ?? "null"}) before the prompt completed`,
          ),
        );
      } else {
        channel.end();
      }
    });

    // --- drive the handshake + prompt; on success, end the channel after the last frame ------------
    const drive = async (): Promise<void> => {
      const startupGuard = setTimeout(() => {
        failAll(new Error("AcpStdioTransport: startup timeout"));
      }, this.startupTimeoutMs);
      startupGuard.unref?.();
      try {
        resetIdle();
        await request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: CLIENT_CAPABILITIES,
        });
        clearTimeout(startupGuard);
        const session = (await request("session/new", {
          cwd: this.cwd ?? process.cwd(),
          mcpServers: [],
        })) as {
          sessionId?: string;
        };
        const sessionId = session?.sessionId;
        await request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: intent }],
        });
        // The prompt resolved with a stopReason — the turn is complete.
        promptDone = true;
        channel.end();
      } catch (error) {
        clearTimeout(startupGuard);
        failAll(error instanceof Error ? error : new Error(String(error)));
      }
    };
    void drive();

    // --- yield frames as they arrive; guarantee child cleanup on done/error/early-return -----------
    try {
      for (;;) {
        const frame = await channel.next();
        if (frame === null) break;
        yield frame;
      }
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
      // End stdin (lets a well-behaved child exit) then hard-kill to guarantee no orphan.
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  }
}

interface DuplexAcpSessionOptions {
  readonly command: readonly string[];
  readonly cwd: string | undefined;
  readonly env: Record<string, string> | undefined;
  readonly startupTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly firstIntent: string;
}

/** A turn's accumulation: frames pushed while the prompt was in flight + a gate for its stopReason. */
interface TurnAccumulator {
  readonly frames: AcpUpdateFrame[];
  resolve: (turn: HermesLoopTurn) => void;
  reject: (error: Error) => void;
  readonly done: Promise<HermesLoopTurn>;
  settled: boolean;
}

/**
 * The held duplex ACP session backing {@link AcpStdioTransport.openSession}. Owns ONE child + ONE
 * sessionId across many prompt turns. It reuses the SAME wire conventions as the one-shot `submit`
 * (newline-delimited JSON-RPC, pending-id correlation, session/update -> frames) but does NOT tear the
 * child down after the first prompt — only on `close()` / fatal error. propose-only + fs/terminal deny
 * are answered VERBATIM (identical bytes to the one-shot path) on every turn.
 */
class DuplexAcpSession implements HermesLoopSession {
  private readonly opts: DuplexAcpSessionOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  private buffer = "";
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private fatal: Error | null = null;
  /** The in-flight prompt's accumulator (frames + stopReason gate), or null between turns. */
  private currentTurn: TurnAccumulator | null = null;
  private sessionId: string | undefined;

  constructor(opts: DuplexAcpSessionOptions) {
    this.opts = opts;
  }

  /** Spawn the child, do initialize -> session/new (capture sessionId), and arm the FIRST prompt turn. */
  async start(): Promise<void> {
    const [cmd, ...args] = this.opts.command;
    if (cmd === undefined) throw new Error("AcpStdioTransport: empty command");

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(cmd, args, {
        cwd: this.opts.cwd,
        env: minimalEnv(this.opts.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.resume();
    child.on("error", (error: Error) => this.failAll(error));
    child.on("exit", (code) => {
      // Fail-closed on a premature exit: an exit while a prompt is in flight (EOF) OR while a handshake
      // request is still pending (e.g. the bin/module is missing and node dies during `initialize`)
      // rejects immediately — no waiting for the startup/idle timeout. An exit AFTER the current turn
      // already resolved with nothing else pending (e.g. our own close() killed it) is benign.
      const turnInFlight = this.currentTurn !== null && !this.currentTurn.settled;
      if (!this.closed && (turnInFlight || this.pending.size > 0)) {
        this.failAll(
          new Error(
            `AcpStdioTransport: \`hermes acp\` exited (code ${code ?? "null"}) before the prompt completed`,
          ),
        );
      }
    });

    const startupGuard = setTimeout(() => {
      this.failAll(new Error("AcpStdioTransport: startup timeout"));
    }, this.opts.startupTimeoutMs);
    startupGuard.unref?.();
    try {
      this.resetIdle();
      await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
      });
      clearTimeout(startupGuard);
      const session = (await this.request("session/new", {
        cwd: this.opts.cwd ?? process.cwd(),
        mcpServers: [],
      })) as { sessionId?: string };
      this.sessionId = session?.sessionId;
    } catch (error) {
      clearTimeout(startupGuard);
      const err = error instanceof Error ? error : new Error(String(error));
      this.teardownChild();
      throw err;
    }
    // Arm + send the FIRST prompt (same content shape as the one-shot submit).
    this.sendPrompt(this.opts.firstIntent);
  }

  async nextTurn(): Promise<HermesLoopTurn | null> {
    if (this.fatal !== null) throw this.fatal;
    if (this.currentTurn === null) return null; // no prompt in flight (closed / not fed) -> finished.
    try {
      return await this.currentTurn.done;
    } finally {
      this.currentTurn = null;
    }
  }

  async feed(text: string): Promise<void> {
    if (this.fatal !== null) throw this.fatal;
    if (this.closed) throw new Error("AcpStdioTransport: feed on a closed session");
    // Send the governed result back as the NEXT prompt on the SAME sessionId.
    this.sendPrompt(text);
  }

  close(): Promise<void> {
    this.closed = true;
    this.teardownChild();
    return Promise.resolve();
  }

  // --- internals --------------------------------------------------------------------------------

  /** Arm a fresh turn accumulator and write the session/prompt (one-shot content shape, same bytes). */
  private sendPrompt(text: string): void {
    let resolve!: (turn: HermesLoopTurn) => void;
    let reject!: (error: Error) => void;
    const done = new Promise<HermesLoopTurn>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const acc: TurnAccumulator = { frames: [], resolve, reject, done, settled: false };
    this.currentTurn = acc;
    const id = this.nextId++;
    // The prompt RESPONSE (carrying stopReason) is correlated by id; on it, this turn resolves.
    this.pending.set(id, {
      resolve: (result) => {
        if (acc.settled) return;
        acc.settled = true;
        const stopReason =
          result !== null && typeof result === "object" && "stopReason" in result
            ? String((result as { stopReason?: unknown }).stopReason)
            : "end_turn";
        acc.resolve({ frames: acc.frames.slice(), stopReason });
      },
      reject: (error) => {
        if (acc.settled) return;
        acc.settled = true;
        acc.reject(error);
      },
    });
    this.resetIdle();
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { sessionId: this.sessionId, prompt: [{ type: "text", text }] },
    });
  }

  private writeMessage(message: Record<string, unknown>): void {
    if (this.child?.stdin.writable === true) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  private failAll(error: Error): void {
    if (this.fatal !== null) return;
    this.fatal = error;
    for (const [, p] of this.pending) p.reject(error);
    this.pending.clear();
    if (this.currentTurn !== null && !this.currentTurn.settled) {
      this.currentTurn.settled = true;
      this.currentTurn.reject(error);
    }
    this.teardownChild();
  }

  private resetIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.failAll(new Error("AcpStdioTransport: idle timeout — no activity from `hermes acp`"));
    }, this.opts.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private teardownChild(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    if (child === null) return;
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }

  private onStdout(chunk: string): void {
    this.resetIdle();
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) {
        let parsed: JsonRpcMessage;
        try {
          parsed = JSON.parse(line) as JsonRpcMessage;
        } catch {
          // Malformed (non-JSON) line -> fail-closed. Never fabricate an ok turn after.
          this.failAll(new Error("AcpStdioTransport: malformed JSON-RPC line from `hermes acp`"));
          return;
        }
        this.handleMessage(parsed);
      }
      idx = this.buffer.indexOf("\n");
    }
  }

  /** Answer an agent->client REQUEST. propose-only + fs/terminal deny — VERBATIM, identical to submit. */
  private handleAgentRequest(msg: JsonRpcMessage): void {
    const id = msg.id as number | string;
    switch (msg.method) {
      case "session/request_permission":
        // PROPOSE-ONLY: deny execution on EVERY turn. (Identical bytes to the one-shot path.)
        this.writeMessage({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        return;
      default:
        // fs/read_text_file, fs/write_text_file, terminal/*, anything else -> method-not-found.
        this.writeMessage({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `not permitted: ${msg.method ?? "unknown"}` },
        });
        return;
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (typeof msg.method === "string") {
      if (msg.method === "session/update") {
        const update = (msg.params as { update?: unknown } | undefined)?.update;
        if (update !== null && typeof update === "object" && this.currentTurn !== null) {
          this.currentTurn.frames.push(update as AcpUpdateFrame);
        }
        return;
      }
      if (msg.id !== undefined) this.handleAgentRequest(msg);
      return;
    }
    // A RESPONSE to one of our requests (correlate by id).
    if (msg.id !== undefined && (typeof msg.id === "number" || typeof msg.id === "string")) {
      const waiter = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (waiter !== undefined) {
        this.pending.delete(msg.id as number);
        if (msg.error !== undefined) {
          waiter.reject(
            new Error(
              `AcpStdioTransport: JSON-RPC error ${msg.error.code ?? ""} ${msg.error.message ?? ""}`.trim(),
            ),
          );
        } else {
          waiter.resolve(msg.result);
        }
      }
    }
  }
}
