/**
 * SLICE-EXEC4b (in-repo half) — the BACKWARD-COMPATIBLE `mcpServers` injection into `session/new`.
 *
 * The ONLY change to acp-stdio.ts is a new `mcpServers?: readonly unknown[]` option threaded to BOTH
 * `session/new` call sites (the one-shot `submit` and the duplex session) — DEFAULTING to `[]` when not
 * provided. This file pins the two halves of that contract by driving the REAL transport against the
 * in-tree FAKE `hermes acp` and reading the `session/new` line out of the fake's recorded stdin transcript:
 *
 *   (a) BACKWARD-COMPAT — with NO mcpServers option, `session/new.mcpServers === []` (byte-unchanged from
 *       every existing DHB/EXEC3b path, so the frozen-empty advertisement holds). `clientCapabilities`
 *       stays frozen-empty too (no fs/terminal added — orthogonal to mcpServers).
 *   (b) INJECTION — with a descriptor, that EXACT descriptor appears in `session/new.mcpServers` (this is
 *       what makes a real Hermes able to discover our governed tools in EXEC4b/live).
 *
 * NON-VACUITY: (a) would catch a mutation that started sending a non-empty default (it asserts `[]`); (b)
 * would catch a mutation that dropped/ignored the option (it asserts the descriptor is present). The fake
 * NEVER calls a model + NEVER touches credits.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcpStdioTransport } from "./index.js";

const FAKE = fileURLToPath(new URL("./__fixtures__/fake-hermes-acp.mjs", import.meta.url));

const tmpDirs: string[] = [];
function emptyCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-mcpservers-test-"));
  tmpDirs.push(dir);
  return dir;
}
function logPath(): string {
  return join(emptyCwd(), "fake-acp-log.json");
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

describe("AcpStdioTransport — mcpServers injection: backward-compat default []", () => {
  it("submit (one-shot): with NO mcpServers option, session/new.mcpServers === [] (byte-unchanged)", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "happy", FAKE_ACP_LOG: log },
    });
    await drain(transport.submit("ship it"));

    const params = readSessionNewParams(log);
    expect(params).toBeDefined();
    expect(params?.mcpServers).toEqual([]);
    // clientCapabilities stays frozen-empty (no fs/terminal) — orthogonal to mcpServers (EXEC4 invariant).
    const init = (() => {
      const recorded = JSON.parse(readFileSync(log, "utf8")) as { stdinLines: string[] };
      for (const line of recorded.stdinLines) {
        const msg = JSON.parse(line) as { method?: string; params?: Record<string, unknown> };
        if (msg.method === "initialize") return msg.params;
      }
      return undefined;
    })();
    expect(init?.clientCapabilities).toEqual({});
  });

  it("openSession (duplex): with NO mcpServers option, session/new.mcpServers === []", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "happy", FAKE_ACP_LOG: log },
    });
    const session = await transport.openSession("ship it");
    await session.nextTurn();
    await session.close();

    const params = readSessionNewParams(log);
    expect(params).toBeDefined();
    expect(params?.mcpServers).toEqual([]);
  });
});

describe("AcpStdioTransport — mcpServers injection: a descriptor is threaded to session/new", () => {
  const descriptor = { name: "agentos-exec", url: "http://127.0.0.1:65535/mcp" };

  it("submit (one-shot): the provided descriptor appears in session/new.mcpServers", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "happy", FAKE_ACP_LOG: log },
      mcpServers: [descriptor],
    });
    await drain(transport.submit("ship it"));

    const params = readSessionNewParams(log);
    expect(params?.mcpServers).toEqual([descriptor]);
  });

  it("openSession (duplex): the provided descriptor appears in session/new.mcpServers", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "happy", FAKE_ACP_LOG: log },
      mcpServers: [descriptor],
    });
    const session = await transport.openSession("ship it");
    await session.nextTurn();
    await session.close();

    const params = readSessionNewParams(log);
    expect(params?.mcpServers).toEqual([descriptor]);
  });
});
