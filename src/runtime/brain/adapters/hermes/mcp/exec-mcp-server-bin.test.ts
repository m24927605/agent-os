/**
 * SLICE-EXEC4c-b (in-repo half) — the bin's REAL-mode SHARED-KERNEL WORM wiring, proven against a FAKE
 * AppendTransport (no real kernel), + the stdio descriptor advertised to a real acp-stdio session/new.
 *
 * THE TOPOLOGY THIS PINS (the EXEC4c-b open decision = "unify into one real kernel chain"): in REAL mode
 * the bin's WORM appender is `createPartitionedIngestSink(<AppendTransport>, <binding>)` — the SAME
 * shared-kernel composition the Enterprise composition root wires — so every tools/call receipt is sent
 * OVER THE WIRE to the kernel's PARTITIONED AppendService bound to the bin's tenant. The bin's receipts
 * therefore land in the SAME independently-verifiable WORM chain as the rest of the system (unified
 * evidence), NOT a split in-memory log. We inject a FAKE transport here so the wiring is provable with
 * ZERO real kernel: the live path builds `createRpcAppendTransport(fromEnv)` (EXEC4c-b/live).
 *
 * COMMIT-BEFORE-EFFECT over the shared-kernel appender (the load-bearing invariant): a governed
 * tools/call drives the SAME single execution edge (`runExecMcpStdio` -> `createExecMcpServer.handle` ->
 * `runGovernedToolCall`), which `commitBeforeEffect`s — appends the AuditEvent, AWAITS the kernel receipt,
 * and ONLY THEN runs the effect. We observe the Fake transport's `append` is called BEFORE the substrate
 * effect runs. NON-VACUITY: a mutation that skips the kernel append (in-memory stub) OR appends AFTER the
 * effect makes the assertion RED.
 *
 * FAKE mode stays in-memory (the EXEC4c-a subprocess test's invariant): `buildAppender(true)` is the pure
 * monotonic-receipt stub — never the kernel transport — so a real Hermes spawning the bin in FAKE mode (the
 * subprocess test) is unchanged and never reaches for a kernel.
 *
 * HONEST BOUNDARY: in-repo this proves the shared-kernel WORM TOPOLOGY (the bin's receipts ship through
 * `createPartitionedIngestSink` over an injected transport, commit-before-effect) + the stdio descriptor
 * advertised in a real `session/new`. The receipts landing in the REAL shared kernel chain (a real
 * `createRpcAppendTransport` to a live kernel) + a real Hermes spawning the bin = EXEC4c-b (live).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AppendRequestShape,
  AppendResponseShape,
  AppendTransport,
} from "../../../../../audit/index.js";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
} from "../../../../substrate/index.js";
import { AcpStdioTransport } from "../index.js";
import { buildBinAppender, buildBinDeps } from "./exec-mcp-server-bin.js";
import { execMcpStdioDescriptor, runExecMcpStdio } from "./exec-mcp-stdio.js";

/** A spying Fake substrate: records exec calls (so the test can assert the binding-built argv). */
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

// ==================================================================================================
// A FAKE AppendTransport: records the order of (kernel append) vs (substrate effect), and returns a
// well-formed receipt so the commitgate treats each append as a durable commit. NO real kernel, NO
// network — this is the in-repo stand-in for the live `createRpcAppendTransport(fromEnv)`.
// ==================================================================================================
interface FakeKernelTransport extends AppendTransport {
  readonly requests: AppendRequestShape[];
}
function fakeKernelTransport(order: string[]): FakeKernelTransport {
  const requests: AppendRequestShape[] = [];
  let sequence = 0;
  return {
    requests,
    append(req: AppendRequestShape): Promise<AppendResponseShape> {
      requests.push(req);
      order.push("kernel-append");
      sequence += 1;
      // A well-formed receipt (the S1 parser treats a present receipt as a durable commit).
      return Promise.resolve({
        receipt: {
          sequence,
          contentHash: `content-${sequence}`,
          prevHash: sequence === 1 ? "GENESIS" : `content-${sequence - 1}`,
          entryHash: `entry-${sequence}`,
        },
      });
    },
  };
}

// ==================================================================================================
// WORM-WIRING-1 — REAL-mode shared-kernel WORM: a governed tools/call over the bin's REAL deps (with a
//   FAKE AppendTransport injected) appends to the kernel transport BEFORE the effect runs
//   (commit-before-effect over the shared-kernel appender). NON-VACUITY: an in-memory stub / an append
//   after the effect -> RED.
// ==================================================================================================
describe("EXEC4c-b — WORM-WIRING-1 the bin's REAL appender ships every receipt to the shared kernel BEFORE the effect", () => {
  it("a governed tools/call appends to the injected kernel transport, then runs the effect (commit-before-effect)", async () => {
    const order: string[] = [];
    const transport = fakeKernelTransport(order);
    const spy = new SpyFakeSandboxAdapter();

    // Build the bin's REAL deps with the FAKE kernel transport injected (so the appender is the SHARED-
    // KERNEL `createPartitionedIngestSink` over the wire, NOT the in-memory stub) + a FAKE substrate (so
    // this stays in-repo) + a hook that records when the substrate effect actually runs. This is the SAME
    // deps the live bin builds, minus the real kernel + the real OpenShell substrate.
    const { deps } = await buildBinDeps(false, {
      ingestTransport: transport,
      substrate: spy,
      onEffect: () => order.push("effect"),
    });

    // Drive ONE bound tools/call through the SINGLE execution edge over in-memory stdio streams.
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    const done = runExecMcpStdio(deps, { input, output });
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "exec.echo", arguments: { text: "hello" } },
      })}\n`,
    );
    input.end();
    await done;

    const responses = Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // The call executed (the single edge is live over the shared-kernel appender).
    const result = responses[0]?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("echo hello");

    // SHARED-KERNEL: the receipt was shipped OVER THE WIRE to the kernel transport (not an in-memory stub).
    expect(transport.requests.length).toBe(1);
    // Per-tenant routing rides on the request (partitioned shared chain) — non-secret routing metadata.
    expect(typeof transport.requests[0]?.sourceId).toBe("string");

    // COMMIT-BEFORE-EFFECT over the shared-kernel appender: the kernel append came BEFORE the effect.
    // NON-VACUITY: an in-memory stub (no kernel-append) OR an append-after-effect breaks this exact order.
    expect(order).toEqual(["kernel-append", "effect"]);

    // The argv that executed was built by OUR binding (a pure vector) — never the brain's raw args.
    expect(spy.execCalls[0]?.argv).toEqual(["echo", "hello"]);
  });
});

// ==================================================================================================
// WORM-WIRING-2 — FAKE mode stays IN-MEMORY (the EXEC4c-a subprocess invariant): `buildBinAppender(true)`
//   never reaches the kernel transport — it is the pure monotonic-receipt stub. (Even if a kernel
//   transport were available, FAKE must not use it.) NON-VACUITY: wiring FAKE to the kernel -> RED.
// ==================================================================================================
describe("EXEC4c-b — WORM-WIRING-2 FAKE mode is the in-memory stub (never the shared kernel)", () => {
  it("buildBinAppender(true) returns a monotonic in-memory appender that does NOT touch an injected transport", async () => {
    const order: string[] = [];
    const transport = fakeKernelTransport(order);
    // FAKE mode: even WITH a transport available, the appender must be the in-memory stub.
    const appender = buildBinAppender(true, { ingestTransport: transport });
    const r1 = (await appender.append({ kind: "x" })) as { id?: number; sequence?: number };
    const r2 = (await appender.append({ kind: "y" })) as { id?: number; sequence?: number };
    // A monotonic in-memory receipt — and NOTHING went over the (kernel) transport.
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(transport.requests.length).toBe(0);
    expect(order).toEqual([]);
  });
});

// ==================================================================================================
// DESCRIPTOR-ADVERTISE — the stdio descriptor is advertised in session/new (drive the REAL acp-stdio
//   transport vs the in-tree fake hermes acp; assert mcpServers carries the EXACT stdio descriptor —
//   {name, command:'node', args:[binPath], env}). Reuses the EXEC4b acp-stdio-mcpservers test pattern.
//   NON-VACUITY: a dropped option / an empty default -> the descriptor would be absent -> RED.
// ==================================================================================================
const FAKE = fileURLToPath(new URL("../__fixtures__/fake-hermes-acp.mjs", import.meta.url));

const tmpDirs: string[] = [];
function emptyCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "exec-mcp-stdio-descriptor-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Drain the frame stream to completion so the handshake (and the recorded session/new) finishes. */
async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) {
    // no-op: we only need the handshake to complete so the fake records session/new.
  }
}

/** Read the recorded stdin transcript and return the parsed `session/new` params (or undefined). */
function readSessionNewParams(log: string): Record<string, unknown> | undefined {
  const recorded = JSON.parse(readFileSync(log, "utf8")) as { stdinLines: string[] };
  for (const line of recorded.stdinLines) {
    let msg: { method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "session/new") return msg.params;
  }
  return undefined;
}

describe("EXEC4c-b — DESCRIPTOR-ADVERTISE the stdio descriptor is threaded into a real session/new.mcpServers", () => {
  it("the execMcpStdioDescriptor appears VERBATIM in session/new.mcpServers (a real Hermes would SPAWN our bin)", async () => {
    const cwd = emptyCwd();
    const log = join(cwd, "fake-acp-log.json");
    const descriptor = execMcpStdioDescriptor("/abs/path/to/exec-mcp-server-bin.js", {
      AGENTOS_OPENSHELL_ENDPOINT: "127.0.0.1:17670",
      AGENTOS_KERNEL_INGEST_ENDPOINT: "127.0.0.1:50051",
    });
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd,
      env: { FAKE_ACP_SCENARIO: "happy", FAKE_ACP_LOG: log },
      mcpServers: [descriptor],
    });
    await drain(transport.submit("use the available echo tool to print hello"));

    const params = readSessionNewParams(log);
    expect(params).toBeDefined();
    // The EXACT stdio descriptor (a real Hermes reads this to SPAWN `node <bin>` + speak MCP to it).
    expect(params?.mcpServers).toEqual([descriptor]);
    expect(descriptor.command).toBe("node");
    expect(descriptor.args).toEqual(["/abs/path/to/exec-mcp-server-bin.js"]);
    // env is the ACP McpServerStdio List[EnvVariable] shape ({name, value}), NOT a dict.
    expect(descriptor.env).toContainEqual({
      name: "AGENTOS_OPENSHELL_ENDPOINT",
      value: "127.0.0.1:17670",
    });
    // The kernel ingest endpoint rides as NON-secret env (never a credential).
    expect(descriptor.env.find((e) => e.name === "AGENTOS_KERNEL_INGEST_ENDPOINT")?.value).toBe(
      "127.0.0.1:50051",
    );
  });

  it("with NO mcpServers option the default stays [] (acp-stdio byte-unchanged — the descriptor is opt-in)", async () => {
    const cwd = emptyCwd();
    const log = join(cwd, "fake-acp-log.json");
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd,
      env: { FAKE_ACP_SCENARIO: "happy", FAKE_ACP_LOG: log },
    });
    await drain(transport.submit("ship it"));
    const params = readSessionNewParams(log);
    expect(params?.mcpServers).toEqual([]);
  });
});
