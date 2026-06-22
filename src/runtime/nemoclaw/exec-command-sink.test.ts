/**
 * RED-first tests for the real OpenShell-exec `CommandSink` transport (slice R11-NC-S10).
 *
 * R11-NC ground truth (docs/slices/nemoclaw-live/INDEX.md §0): NemoClaw is an OpenClaw plugin inside an
 * OpenShell sandbox with NO daemon of its own — the only reachable surface is the OpenShell sandbox
 * lifecycle (Create/Get/Exec/Delete). So NemoClaw live == OpenShell live: the `CommandSink` seam the
 * NemoClawAgentHosting adapter injects (src/hosting/adapters/nemoclaw/adapter.ts:41) is wired onto the
 * REAL `OpenShellSandboxAdapter.execSandbox` (src/runtime/openshell/adapter.ts:445).
 *
 * This transport adapts a string `command` onto an `execSandbox`-like fn `(sandboxId, command, opts)`:
 *   - exec status:"ok"     -> {exitCode: result.exitCode, stdout: <utf8-decode result.stdout>}
 *   - exec status:"denied" -> REJECT (fail-closed; NEVER fabricate {exitCode:0})
 *   - exec throws / rejects -> REJECT (the adapter's dispatch catch turns it into a deny-by-default)
 *
 * These run against an IN-PROCESS fake exec (NO OpenShell, NO Docker). The live e2e against a real
 * OpenShell sandbox is R11-NC-S11 (gated until the user provides an OpenShell daemon).
 */
import { describe, expect, it } from "vitest";
import type { ExecOutcome, ExecResult } from "../openshell/index.js";
import { createOpenShellExecCommandSink } from "./index.js";

/** A minimal auditable event for the fake — `sandboxId` (a branded id) is optional, so we omit it. */
const okEvent = { lifecycle: "start", result: "ok" } as const;
const deniedEvent = { lifecycle: "start", result: "denied" } as const;

function okResult(exitCode: number, stdout: string): ExecResult {
  return { exitCode, stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(0) };
}

function execOk(exitCode: number, stdout: string): ExecOutcome {
  return { status: "ok", result: okResult(exitCode, stdout), event: okEvent };
}

function execDenied(reason: string): ExecOutcome {
  return { status: "denied", reason, event: deniedEvent };
}

describe("createOpenShellExecCommandSink — ok path maps exec.result onto {exitCode, stdout}", () => {
  it("decodes the stdout bytes to a utf-8 string and reports the exit code as-is", async () => {
    const sink = createOpenShellExecCommandSink({
      sandboxId: "sbx-1",
      exec: () => Promise.resolve(execOk(0, "GATEWAY_PID=123")),
    });
    await expect(sink.run('echo "GATEWAY_PID=$GPID"')).resolves.toEqual({
      exitCode: 0,
      stdout: "GATEWAY_PID=123",
    });
  });

  it("forwards a NON-ZERO exit code faithfully (a command failure is not a transport deny)", async () => {
    const sink = createOpenShellExecCommandSink({
      sandboxId: "sbx-1",
      exec: () => Promise.resolve(execOk(7, "boom")),
    });
    await expect(sink.run("false")).resolves.toEqual({ exitCode: 7, stdout: "boom" });
  });
});

describe("createOpenShellExecCommandSink — fail-closed (deny-by-default)", () => {
  it("REJECTS on status:denied and NEVER fabricates {exitCode:0}", async () => {
    const sink = createOpenShellExecCommandSink({
      sandboxId: "sbx-1",
      exec: () => Promise.resolve(execDenied("exec denied (fail-closed)")),
    });
    await expect(sink.run("curl /health")).rejects.toThrow(/fail-closed/i);
  });

  it("surfaces the denied reason on the rejection (the Error carries the reason)", async () => {
    const sink = createOpenShellExecCommandSink({
      sandboxId: "sbx-1",
      exec: () => Promise.resolve(execDenied("unknown sandbox (fail-closed)")),
    });
    await expect(sink.run("curl /health")).rejects.toThrow(/unknown sandbox/);
  });

  it("REJECTS when exec throws synchronously (never resolves a falsy success)", async () => {
    const sink = createOpenShellExecCommandSink({
      sandboxId: "sbx-1",
      exec: (): Promise<ExecOutcome> => {
        throw new Error("transport down");
      },
    });
    await expect(sink.run("curl /health")).rejects.toThrow(/transport down/);
  });

  it("REJECTS when exec rejects (async transport failure)", async () => {
    const sink = createOpenShellExecCommandSink({
      sandboxId: "sbx-1",
      exec: () => Promise.reject(new Error("deadline exceeded")),
    });
    await expect(sink.run("curl /health")).rejects.toThrow(/deadline exceeded/);
  });
});

describe("createOpenShellExecCommandSink — command + sandboxId pass-through", () => {
  it("passes the EXACT command string .run received into exec, scoped to the configured sandboxId", async () => {
    const calls: Array<{ sandboxId: string; command: string }> = [];
    const sink = createOpenShellExecCommandSink({
      sandboxId: "sbx-42",
      exec: (sandboxId, command) => {
        calls.push({ sandboxId, command });
        return Promise.resolve(execOk(0, ""));
      },
    });
    const cmd = 'nohup gosu gateway "$OPENCLAW" gateway run & GPID=$!';
    await sink.run(cmd);
    expect(calls).toEqual([{ sandboxId: "sbx-42", command: cmd }]);
  });

  it("forwards the optional ExecSandboxOpts into exec (e.g. a per-command timeout)", async () => {
    let seenOpts: unknown;
    const sink = createOpenShellExecCommandSink({
      sandboxId: "sbx-1",
      opts: { timeoutSeconds: 3 },
      exec: (_sandboxId, _command, opts) => {
        seenOpts = opts;
        return Promise.resolve(execOk(0, ""));
      },
    });
    await sink.run("curl /health");
    expect(seenOpts).toEqual({ timeoutSeconds: 3 });
  });
});
