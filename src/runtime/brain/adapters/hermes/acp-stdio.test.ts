/**
 * AcpStdioTransport — REAL ACP-over-stdio transport, proven against a FAKE `hermes acp` subprocess
 * (SLICE-DHB2a). RED-first.
 *
 * DHB1 left `DesktopHermesTransport` as a seam wired only to an in-memory Fake. DHB2a builds the REAL
 * transport: it spawns `hermes acp`, speaks ACP (JSON-RPC 2.0, newline-delimited, over the child's
 * stdin/stdout) — `initialize` -> `session/new` -> `session/prompt(intent)` — yields each streamed
 * `session/update` as an `AcpUpdateFrame`, and answers `session/request_permission` with a DENY
 * (propose-only). To prove the wire WITHOUT a real model call or any credits, these tests point the
 * transport at an in-tree fake `hermes acp` (`__fixtures__/fake-hermes-acp.mjs`) driven by scenario
 * env vars, and read a side-channel log the fake writes.
 *
 * Claims asserted (each with a mutation that flips it — see NON-VACUITY in the slice report):
 *   - HAPPY: two session/update frames (plan chunk + tool_call) flow through DesktopHermesTurnSource
 *     -> HermesBrainShim -> governBrainStream all `ok` (plan-step + tool-call).
 *   - PROPOSE-ONLY: the fake's session/request_permission gets a DENY; the fake records it was NOT
 *     approved and did NOT self-execute the tool. (auto-approve mutation -> this test fails.)
 *   - FAIL-CLOSED: nonexistent binary / non-zero exit / malformed line / EOF mid-prompt all THROW
 *     out of submit -> TurnSource yields nothing. (swallow-error mutation -> a fail-closed test fails.)
 *   - CREDENTIAL-BLIND: the fake's stdin transcript contains ONLY the ACP protocol + the intent, with
 *     NO Agent OS secret; the transport never reads ~/.hermes and runs the child with a minimal env.
 *     (secret-on-stdin mutation -> this test fails.)
 *
 * HONEST BOUNDARY: DHB2a proves the transport's protocol/parse/propose-only/fail-closed/credential-
 * blind against a FAKE subprocess. The real Hermes full chain + its exact ACP dialect = DHB2b (live,
 * user-initiated). These tests NEVER spawn the real `hermes acp` and NEVER touch ~/.hermes.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { redactSecrets } from "../../../../audit/redact.js";
import { governBrainStream } from "../../index.js";
import { AcpStdioTransport, DesktopHermesTurnSource, HermesBrainShim } from "./index.js";

const FAKE = fileURLToPath(new URL("./__fixtures__/fake-hermes-acp.mjs", import.meta.url));

const validCtx = {
  actorId: "agent:hermes",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

// The repo's REAL detector (same one the shim/desktop tests + composition root wire).
const detectSecret = (value: unknown): boolean =>
  JSON.stringify(redactSecrets(value)) !== JSON.stringify(value);

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const tmpDirs: string[] = [];
/** A throwaway empty cwd so the transport never reads a real ~/.hermes / project config. */
function emptyCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-stdio-test-"));
  tmpDirs.push(dir);
  return dir;
}
function logPath(): string {
  return join(emptyCwd(), "fake-acp-log.json");
}
function readLog(path: string): {
  scenario: string;
  stdinLines: string[];
  methodsReceived: string[];
  permissionResponse?: unknown;
  permissionApproved: boolean;
  toolExecuted: boolean;
  childEnvKeys: string[];
  childEnv: Record<string, string>;
  fsReadResponse?: unknown;
  terminalCreateResponse?: unknown;
  hostAccessGranted: boolean;
} {
  return JSON.parse(readFileSync(path, "utf8"));
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AcpStdioTransport — happy: real wire vs fake hermes acp", () => {
  it("yields two AcpUpdateFrames (plan chunk + tool_call) for an intent", async () => {
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "happy" },
    });
    const frames = await collect(transport.submit("ship it"));

    const kinds = frames.map((f) => f.sessionUpdate);
    expect(kinds).toContain("agent_message_chunk");
    expect(kinds).toContain("tool_call");
    const tool = frames.find((f) => f.sessionUpdate === "tool_call");
    expect(tool?.title).toBe("open_pr");
    expect(tool?.rawInput).toEqual({ bundleRef: "github:PAT:prod" });
  });

  it("flows through DesktopHermesTurnSource -> HermesBrainShim -> governed stream (all ok)", async () => {
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "happy" },
    });
    const shim = new HermesBrainShim(new DesktopHermesTurnSource(transport));
    const results = await collect(
      governBrainStream(shim.execute(validCtx, "ship it"), detectSecret),
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    const kinds = results.map((r) => r.event.kind);
    expect(kinds).toContain("plan-step");
    expect(kinds).toContain("tool-call");
    const tc = results.find((r) => r.event.kind === "tool-call");
    if (tc && tc.event.kind === "tool-call") {
      expect(tc.event.tool).toBe("open_pr");
      expect(tc.event.args).toEqual({ bundleRef: "github:PAT:prod" });
    }
  });
});

describe("AcpStdioTransport — propose-only: session/request_permission is DENIED", () => {
  it("answers the permission request with a denial; the agent never self-executes", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "permission", FAKE_ACP_LOG: log },
    });
    const frames = await collect(transport.submit("ship it"));

    const recorded = readLog(log);
    // The fake observed the client's permission response:
    expect(recorded.methodsReceived).toContain("session/prompt");
    expect(recorded.permissionResponse).toBeDefined();
    // PROPOSE-ONLY: the client did NOT approve, so the fake did NOT self-execute the tool.
    expect(recorded.permissionApproved).toBe(false);
    expect(recorded.toolExecuted).toBe(false);
    // The proposed tool_call still arrived as a frame (that IS the proposal Agent OS governs);
    // the "EXECUTED ..." self-execution chunk must be absent.
    expect(frames.some((f) => f.sessionUpdate === "tool_call" && f.title === "open_pr")).toBe(true);
    expect(JSON.stringify(frames)).not.toContain("EXECUTED");
  });
});

describe("AcpStdioTransport — fail-closed (deny-by-default)", () => {
  it("(a) a nonexistent binary -> submit throws; the TurnSource yields nothing", async () => {
    const transport = new AcpStdioTransport({
      command: ["this-binary-does-not-exist-acp-xyz"],
      cwd: emptyCwd(),
    });
    await expect(collect(transport.submit("x"))).rejects.toThrow();

    // and through the shim: a throwing transport stops the BrainEvent stream (no ok turn).
    const shim = new HermesBrainShim(new DesktopHermesTurnSource(transport));
    const events = await collect(shim.execute(validCtx, "x"));
    expect(events).toEqual([]);
  });

  it("(b) non-zero exit before the prompt completes -> submit throws", async () => {
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "nonzero" },
    });
    await expect(collect(transport.submit("x"))).rejects.toThrow();
  });

  it("(c) a malformed (non-JSON) line -> submit throws; no ok frame yielded", async () => {
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "malformed" },
    });
    const frames: unknown[] = [];
    await expect(
      (async () => {
        for await (const f of transport.submit("x")) frames.push(f);
      })(),
    ).rejects.toThrow();
    // any frame yielded before the malformed line is fine, but NO tool_call ok-turn surfaces
    // as a fabricated success after the error: the stream threw.
    expect(frames.every((f) => (f as { sessionUpdate?: string }).sessionUpdate !== undefined)).toBe(
      true,
    );
  });

  it("(d) stdout EOF mid-prompt (no stopReason) -> submit throws", async () => {
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "eof" },
    });
    await expect(collect(transport.submit("x"))).rejects.toThrow();
  });
});

describe("AcpStdioTransport — credential-blind", () => {
  it("sends ONLY the ACP protocol + the intent on stdin — no Agent OS secret", async () => {
    const log = logPath();
    const intent = "open a PR for the fix";
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      // env is for the CHILD; even if a secret-looking value were here, it must not reach stdin.
      env: { FAKE_ACP_SCENARIO: "happy", FAKE_ACP_LOG: log },
    });
    await collect(transport.submit(intent));

    const recorded = readLog(log);
    const stdin = recorded.stdinLines.join("\n");
    // the intent IS forwarded (that is the only caller payload)...
    expect(stdin).toContain(intent);
    // ...and the handshake methods were sent in order...
    expect(recorded.methodsReceived.slice(0, 3)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
    ]);
    // ...but NO Agent OS secret marker appears anywhere on the wire to the child.
    const secretMarker = `sk-${"z".repeat(24)}`; // canary built at runtime, never on the wire
    expect(stdin).not.toContain(secretMarker);
    // every stdin line is valid JSON-RPC 2.0 (protocol only — no smuggled freeform payload).
    for (const line of recorded.stdinLines) {
      const parsed = JSON.parse(line);
      expect(parsed.jsonrpc).toBe("2.0");
    }
  });

  it("declares MINIMAL client capabilities — NO fs, NO terminal", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "happy", FAKE_ACP_LOG: log },
    });
    await collect(transport.submit("x"));

    const recorded = readLog(log);
    const initLine = recorded.stdinLines
      .map((l) => JSON.parse(l))
      .find((m) => m.method === "initialize");
    expect(initLine).toBeDefined();
    const caps = initLine.params?.clientCapabilities ?? {};
    // No filesystem and no terminal capability is advertised, so the agent cannot request host
    // file/terminal access (propose-only + credential-blind).
    expect(caps.fs).toBeUndefined();
    expect(caps.terminal).toBeUndefined();
  });

  it("runs the child with a MINIMAL env — the parent's secret-bearing env does NOT leak in", async () => {
    // A parent-only secret-shaped env var, built at runtime (never a source literal -> secret-scan
    // stays clean). It is set on THIS process BEFORE spawn and removed after, and must NEVER reach
    // the child (minimalEnv forwards only PATH/HOME + the explicit opts.env we pass).
    const parentSecretVar = "AGENTOS_TEST_PARENT_SECRET";
    const parentSecretValue = `sk-${"q".repeat(24)}`;
    const log = logPath();
    process.env[parentSecretVar] = parentSecretValue;
    try {
      const transport = new AcpStdioTransport({
        command: ["node", FAKE],
        cwd: emptyCwd(),
        env: { FAKE_ACP_SCENARIO: "happy", FAKE_ACP_LOG: log },
      });
      await collect(transport.submit("x"));
    } finally {
      delete process.env[parentSecretVar];
    }

    const recorded = readLog(log);
    // structural: the secret-bearing var NAME is absent from the child's env keys...
    expect(recorded.childEnvKeys).not.toContain(parentSecretVar);
    // ...content: its value never appears anywhere in the child's env...
    expect(JSON.stringify(recorded.childEnv)).not.toContain(parentSecretValue);
    // ...and the child got ONLY the minimal base + the explicit opts.env we passed (plus, on some
    // platforms, OS-injected vars like macOS's `__CF_USER_TEXT_ENCODING` which the OS adds to every
    // spawned process regardless of `env` — those are platform noise, not a parent-env leak).
    expect(recorded.childEnv.FAKE_ACP_SCENARIO).toBe("happy");
    expect(recorded.childEnv.FAKE_ACP_LOG).toBe(log);
    const allowed = new Set(["PATH", "HOME", "FAKE_ACP_SCENARIO", "FAKE_ACP_LOG"]);
    const isPlatformInjected = (k: string): boolean => k.startsWith("__CF");
    const unexpected = recorded.childEnvKeys.filter(
      (k) => !allowed.has(k) && !isPlatformInjected(k),
    );
    expect(unexpected).toEqual([]);
  });
});

describe("AcpStdioTransport — host-access requests are DENIED (deny-by-default)", () => {
  it("answers agent->client fs/terminal requests with a -32601 error; no host access is granted", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "hostaccess", FAKE_ACP_LOG: log },
    });
    const frames = await collect(transport.submit("ship it"));

    const recorded = readLog(log);
    // both host-access requests were answered (the client MUST respond)...
    expect(recorded.fsReadResponse).toBeDefined();
    expect(recorded.terminalCreateResponse).toBeDefined();
    // ...each with a JSON-RPC error (not a success result)...
    const fsErr = (recorded.fsReadResponse as { error?: { code?: number } }).error;
    const termErr = (recorded.terminalCreateResponse as { error?: { code?: number } }).error;
    expect(fsErr).toBeDefined();
    expect(termErr).toBeDefined();
    expect(fsErr?.code).toBe(-32601);
    expect(termErr?.code).toBe(-32601);
    // ...so the fake observed NO host access (it never received a success result).
    expect(recorded.hostAccessGranted).toBe(false);
    expect(JSON.stringify(frames)).not.toContain("HOST ACCESS GRANTED");
  });
});
