/**
 * RED-first tests for the composition-root binding (slice SLICE-NC-S11b §B).
 *
 * `createNemoClawOpenShellExec(adapter, ctx)` returns the `ExecLike` the S10 `CommandSink` consumes. It
 * is the ONLY place the string->argv wrap + the AgentContext closure live: a string `command` is
 * wrapped as `["/bin/sh","-c",command]` and dispatched through `adapter.execSandbox(ctx, sandboxId, …)`.
 * Mutation guard: if the binding does NOT wrap the command in `/bin/sh -c`, the argv assertion fails;
 * if it does not close over ctx, the ctx pass-through assertion fails.
 *
 * Runs against an IN-PROCESS FAKE adapter (NO OpenShell, NO docker) that captures its args and replays
 * a canned `ExecOutcome` — so the binding is exercised with zero I/O. The live e2e is gated
 * (nemoclaw.live.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { OpenShellSandboxAdapter } from "../openshell/index.js";
import type { ExecOutcome, ExecResult, ExecSandboxOpts } from "../openshell/index.js";
import { createOpenShellExecCommandSink } from "./index.js";
import { createNemoClawOpenShellExec } from "./index.js";

const CTX = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

const okEvent = { lifecycle: "start", result: "ok" } as const;
function okResult(exitCode: number, stdout: string): ExecResult {
  return { exitCode, stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(0) };
}
function execOk(exitCode: number, stdout: string): ExecOutcome {
  return { status: "ok", result: okResult(exitCode, stdout), event: okEvent };
}

/** A fake OpenShellSandboxAdapter that captures `execSandbox` args and replays a canned outcome. */
function fakeAdapter(outcome: ExecOutcome = execOk(0, "GATEWAY_PID=123")): {
  adapter: OpenShellSandboxAdapter;
  calls: Array<{
    ctx: unknown;
    sandboxId: string;
    cmd: readonly string[];
    opts?: ExecSandboxOpts;
  }>;
} {
  const calls: Array<{
    ctx: unknown;
    sandboxId: string;
    cmd: readonly string[];
    opts?: ExecSandboxOpts;
  }> = [];
  const adapter = {
    execSandbox(
      ctx: unknown,
      sandboxId: string,
      cmd: readonly string[],
      opts?: ExecSandboxOpts,
    ): Promise<ExecOutcome> {
      calls.push({ ctx, sandboxId, cmd, opts });
      return Promise.resolve(outcome);
    },
  } as unknown as OpenShellSandboxAdapter;
  return { adapter, calls };
}

describe("createNemoClawOpenShellExec — string->argv wrap + ctx closure", () => {
  it("wraps the string command as ['/bin/sh','-c',command]", async () => {
    const { adapter, calls } = fakeAdapter();
    const exec = createNemoClawOpenShellExec(adapter, CTX);
    await exec("sbx-1", 'echo "GATEWAY_PID=$GPID"');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toEqual(["/bin/sh", "-c", 'echo "GATEWAY_PID=$GPID"']);
  });

  it("closes over the AgentContext and passes the sandboxId through unchanged", async () => {
    const { adapter, calls } = fakeAdapter();
    const exec = createNemoClawOpenShellExec(adapter, CTX);
    await exec("sbx-42", "curl /health");
    expect(calls[0]?.ctx).toBe(CTX);
    expect(calls[0]?.sandboxId).toBe("sbx-42");
  });

  it("forwards optional ExecSandboxOpts through to the adapter", async () => {
    const { adapter, calls } = fakeAdapter();
    const exec = createNemoClawOpenShellExec(adapter, CTX);
    await exec("sbx-1", "curl /health", { timeoutSeconds: 3 });
    expect(calls[0]?.opts).toEqual({ timeoutSeconds: 3 });
  });

  it("returns the adapter's ExecOutcome unchanged (ok)", async () => {
    const out = execOk(0, "ok-stdout");
    const { adapter } = fakeAdapter(out);
    const exec = createNemoClawOpenShellExec(adapter, CTX);
    await expect(exec("sbx-1", "echo ok")).resolves.toBe(out);
  });

  it("returns the adapter's ExecOutcome unchanged (denied is NOT swallowed)", async () => {
    const denied: ExecOutcome = {
      status: "denied",
      reason: "unknown sandbox (fail-closed)",
      event: { lifecycle: "start", result: "denied" } as const,
    };
    const { adapter } = fakeAdapter(denied);
    const exec = createNemoClawOpenShellExec(adapter, CTX);
    await expect(exec("sbx-1", "echo ok")).resolves.toBe(denied);
  });
});

describe("createNemoClawOpenShellExec — plugs into the S10 CommandSink", () => {
  it("produces a CommandSink whose .run maps an ok outcome onto {exitCode, stdout}", async () => {
    const { adapter, calls } = fakeAdapter(execOk(0, "GATEWAY_PID=4242"));
    const sink = createOpenShellExecCommandSink({
      exec: createNemoClawOpenShellExec(adapter, CTX),
      sandboxId: "sbx-host",
    });
    await expect(sink.run('echo "GATEWAY_PID=$GPID"')).resolves.toEqual({
      exitCode: 0,
      stdout: "GATEWAY_PID=4242",
    });
    // The command reached the adapter wrapped as /bin/sh -c, scoped to the configured sandbox.
    expect(calls[0]?.sandboxId).toBe("sbx-host");
    expect(calls[0]?.cmd).toEqual(["/bin/sh", "-c", 'echo "GATEWAY_PID=$GPID"']);
  });

  it("the CommandSink REJECTS (fail-closed) when the bound exec denies — never fabricates {exitCode:0}", async () => {
    const denied: ExecOutcome = {
      status: "denied",
      reason: "exec deadline exceeded before exit (fail-closed)",
      event: { lifecycle: "start", result: "denied" } as const,
    };
    const { adapter } = fakeAdapter(denied);
    const sink = createOpenShellExecCommandSink({
      exec: createNemoClawOpenShellExec(adapter, CTX),
      sandboxId: "sbx-host",
    });
    await expect(sink.run("curl /health")).rejects.toThrow(/fail-closed/i);
  });
});
