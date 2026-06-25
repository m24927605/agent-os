/**
 * SLICE-EXEC2 — in-repo RECONCILE tests for `makeOpenShellExecCapable` (RED-first).
 *
 * Proves the THIN buffered wrapper that reconciles OpenShell's existing STREAMING exec
 * (`OpenShellSandboxAdapter.execSandbox(...cmd, opts) -> ExecOutcome`, a `{status:"ok"|"denied"}` union
 * carrying `Uint8Array` stdout/stderr) onto the port's BUFFERED contract
 * (`ExecCapableSandboxAdapter.execSandbox(spec) -> ExecResult`, a `{ok:true|false}` union carrying
 * `string` stdout/stderr) — so `makeExecEffect` can drive a REAL OpenShell adapter.
 *
 * These drive the REAL `OpenShellSandboxAdapter` over the SAME in-memory transport double the existing
 * adapter exec tests use (adapter.exec.test.ts) — NO real gateway. The wrapper does not exist yet, so
 * these MUST be SEEN to fail first.
 *
 * Mapping invariants asserted (non-vacuity below):
 *   • status "ok"     -> { ok:true, exitCode, stdout: decode(Uint8Array), stderr: decode, truncated:false }
 *   • status "denied" -> { ok:false, reason }  (NEVER mapped to ok, NEVER a fabricated exit 0)
 *   • byte-cap / deadline deny (already fail-closed in the streaming adapter) -> { ok:false }
 *   • through makeExecEffect: credential-blind (a stdout-echoed runtime-built canary is redacted) +
 *     the port-level 64KB output cap still hold.
 *
 * HONEST BOUNDARY: EXEC2 = reconcile + gated live harness; the live PASS is the main loop's run;
 * DHB3 closed-loop real-output feedback = EXEC3.
 */
import { describe, expect, it, vi } from "vitest";
import { redactSecrets } from "../../audit/index.js";
import type { EffectResult } from "../../orchestration/index.js";
import { type ExecCommandSpec, makeExecEffect } from "../substrate/index.js";
import { OpenShellSandboxAdapter } from "./adapter.js";
import {
  type ExecSandboxEvent,
  type ExecSandboxRequest,
  type OpenShellExecTransport,
  PINNED_SANDBOX_IMAGE,
} from "./client.js";
import { makeOpenShellExecCapable } from "./exec-buffered.js";

/** A well-formed AgentContext (mirrors the iam/ids AgentContext schema; same as adapter.exec.test.ts). */
const CTX = {
  actorId: "actor-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  taskId: "task-1",
  requestId: "request-1",
};

const OS_NAME = "os-sbx-exec";
const OS_ID = "sbxid-exec-stable-gateway-id";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const stdoutEvent = (data: string): ExecSandboxEvent => ({ stdout: { data: enc(data) } });
const stderrEvent = (data: string): ExecSandboxEvent => ({ stderr: { data: enc(data) } });
const exitEvent = (code: number): ExecSandboxEvent => ({ exit: { exitCode: code } });

interface ExecDoubleOpts {
  /** ExecSandbox events streamed in order; an Error throws from the iterator (stream error). */
  execEvents?: Array<ExecSandboxEvent | Error>;
  /** When set, `execSandbox` throws synchronously (transport refused). */
  execReject?: Error;
}

/**
 * The SAME in-memory transport double the existing OpenShell adapter exec tests use: it records exec
 * calls + AbortSignals and replays a scripted exec stream. NO real gateway.
 */
function execTransport(opts: ExecDoubleOpts): OpenShellExecTransport & {
  execCalls: ExecSandboxRequest[];
} {
  const execCalls: ExecSandboxRequest[] = [];
  return {
    execCalls,
    health: () => Promise.resolve({ ok: true }),
    createSandbox: () => Promise.resolve({ sandbox: { metadata: { name: OS_NAME, id: OS_ID } } }),
    deleteSandbox: () => Promise.resolve({ deleted: true }),
    execSandbox(req: ExecSandboxRequest): AsyncIterable<ExecSandboxEvent> {
      execCalls.push(req);
      if (opts.execReject !== undefined) throw opts.execReject;
      const events = opts.execEvents ?? [];
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ExecSandboxEvent> {
          for (const ev of events) {
            if (ev instanceof Error) throw ev;
            yield ev;
          }
        },
      };
    },
  };
}

/** Create a sandbox through the REAL adapter and return its mapped SandboxId (populates refById). */
async function createMapped(adapter: OpenShellSandboxAdapter): Promise<string> {
  const res = await adapter.createSandbox(CTX, { image: PINNED_SANDBOX_IMAGE });
  if (res.status !== "ok") throw new Error("setup: createSandbox should be ok");
  return res.sandboxId;
}

/** The repo's real detector (same construction as every bootstrap): secret-shaped iff redact changes it. */
const detectSecret = (v: unknown): boolean =>
  JSON.stringify(redactSecrets(v)) !== JSON.stringify(v);

/** Runtime-built secret canary that matches audit/redact's `sk-...` SECRET_VALUE shape (never literal). */
function secretCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`; // 24 alnum chars after sk- => matches /sk-[A-Za-z0-9]{16,}/
}

describe("makeOpenShellExecCapable — ExecOutcome ok -> buffered ExecResult ok (Uint8Array -> string)", () => {
  it("(a) maps an ok ExecOutcome (stdout 'hello', exit 0) to { ok:true, exitCode:0, stdout:'hello' }", async () => {
    const t = execTransport({
      execEvents: [stdoutEvent("hel"), stdoutEvent("lo"), stderrEvent("warn"), exitEvent(0)],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const wrapper = makeOpenShellExecCapable(adapter);
    const id = await createMapped(adapter);

    const spec: ExecCommandSpec = { argv: ["echo", "hello"] };
    const res = await wrapper.execSandbox(CTX, id, spec);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hello"); // Uint8Array chunks decoded + joined to a UTF-8 string
    expect(res.stderr).toBe("warn");
    expect(res.truncated).toBe(false);
    // The argv flows through to the underlying streaming exec verbatim.
    expect(t.execCalls).toHaveLength(1);
    expect(t.execCalls[0]?.command).toEqual(["echo", "hello"]);
  });

  it("reports a NON-ZERO exit as ok with the faithful exit code (not a deny / not exit 0)", async () => {
    const t = execTransport({ execEvents: [stdoutEvent("out"), exitEvent(7)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const wrapper = makeOpenShellExecCapable(adapter);
    const id = await createMapped(adapter);

    const res = await wrapper.execSandbox(CTX, id, { argv: ["false"] });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.exitCode).toBe(7);
  });

  it("maps spec.env -> the OpenShell env field and spec.timeoutMs -> the wall-clock budget", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const wrapper = makeOpenShellExecCapable(adapter);
    const id = await createMapped(adapter);

    // env is placeholder-only here (makeExecEffect rejects raw secrets upstream; the wrapper forwards).
    await wrapper.execSandbox(CTX, id, {
      argv: ["printenv"],
      env: { TOKEN: "openshell:resolve:env:v3_TOKEN" },
      timeoutMs: 5_000,
    });

    expect(t.execCalls).toHaveLength(1);
    expect(t.execCalls[0]?.environment).toEqual({ TOKEN: "openshell:resolve:env:v3_TOKEN" });
  });

  // SLICE-CAP1 — the END-TO-END stdin link. `exec.write_file` delivers file content as stdin BYTES
  // (`tee -- <path>`). The wrapper's `optsFromSpec` MUST forward `spec.stdin` -> ExecSandboxOpts.stdin ->
  // (ExecOptsSchema accepts + 8 MiB caps) -> the underlying adapter -> the recorded ExecSandboxRequest.stdin.
  // NON-VACUITY: without the one-line forward in optsFromSpec, spec.stdin is DROPPED and the recorded RPC
  // carries NO stdin -> `tee` would write an EMPTY file -> this assertion flips RED.
  it("forwards spec.stdin -> the OpenShell ExecSandboxRequest.stdin bytes (write_file's content path)", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const wrapper = makeOpenShellExecCapable(adapter);
    const id = await createMapped(adapter);

    const content = "file body line 1\nline 2\n";
    const stdin = enc(content);
    await wrapper.execSandbox(CTX, id, { argv: ["tee", "--", "/tmp/out.txt"], stdin });

    expect(t.execCalls).toHaveLength(1);
    // The stdin bytes reached the RPC request VERBATIM (not dropped by the wrapper).
    expect(t.execCalls[0]?.stdin).toEqual(stdin);
    // argv carries the program/path; the content is NOT in argv (it travels as stdin bytes).
    expect(t.execCalls[0]?.command).toEqual(["tee", "--", "/tmp/out.txt"]);
  });
});

describe("makeOpenShellExecCapable — fail-closed mapping (denied -> { ok:false }, NEVER ok / exit 0)", () => {
  it("(b) maps a denied ExecOutcome (unknown sandbox) to { ok:false, reason }", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const wrapper = makeOpenShellExecCapable(adapter);

    // Never created => the streaming adapter denies (unknown sandbox) BEFORE any RPC.
    const res = await wrapper.execSandbox(CTX, "sbx-os-never-created", { argv: ["ls"] });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("a denied outcome must NEVER be mapped to ok");
    expect(typeof res.reason).toBe("string");
    expect(res.reason.length).toBeGreaterThan(0);
    expect(t.execCalls).toHaveLength(0); // deny was before any RPC
  });

  it("(c) maps a stream that closes WITHOUT a terminal exit to { ok:false } — never a fabricated exit 0", async () => {
    // stdout arrived but the stream closed before the terminal exit -> the streaming adapter DENIES.
    const t = execTransport({ execEvents: [stdoutEvent("partial output")] });
    const adapter = new OpenShellSandboxAdapter(t);
    const wrapper = makeOpenShellExecCapable(adapter);
    const id = await createMapped(adapter);

    const res = await wrapper.execSandbox(CTX, id, { argv: ["sleep"] });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("a no-terminal-exit deny must NEVER be mapped to ok");
    // honesty: the buffered result carries NO exitCode at all on the failure arm.
    expect((res as { exitCode?: number }).exitCode).toBeUndefined();
  });

  it("(c) maps a deadline deny (wall-clock budget elapses before exit) to { ok:false } — never a fabricated exit 0", async () => {
    vi.useFakeTimers();
    try {
      // A stream that never settles: the streaming adapter's wall-clock deadline must fire and DENY.
      const t: OpenShellExecTransport = {
        health: () => Promise.resolve({ ok: true }),
        createSandbox: () =>
          Promise.resolve({ sandbox: { metadata: { name: OS_NAME, id: OS_ID } } }),
        deleteSandbox: () => Promise.resolve({ deleted: true }),
        execSandbox(): AsyncIterable<ExecSandboxEvent> {
          return {
            [Symbol.asyncIterator](): AsyncIterator<ExecSandboxEvent> {
              // Never resolves a `next()` -> only the deadline race can settle the outcome.
              return { next: () => new Promise<never>(() => {}) };
            },
          };
        },
      };
      const adapter = new OpenShellSandboxAdapter(t);
      const wrapper = makeOpenShellExecCapable(adapter);
      const id = await createMapped(adapter);

      // spec.timeoutMs -> the OpenShell wall-clock budget; advance fake time past it.
      const pending = wrapper.execSandbox(CTX, id, { argv: ["sleep"], timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_200);
      const res = await pending;

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("a deadline deny must NEVER be mapped to ok");
      expect((res as { exitCode?: number }).exitCode).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps a transport refusal (synchronous throw) to { ok:false } — wrapper never throws across the port", async () => {
    const t = execTransport({ execReject: new Error("UNAVAILABLE") });
    const adapter = new OpenShellSandboxAdapter(t);
    const wrapper = makeOpenShellExecCapable(adapter);
    const id = await createMapped(adapter);

    const res = await wrapper.execSandbox(CTX, id, { argv: ["cmd"] });

    expect(res.ok).toBe(false);
  });
});

describe("makeOpenShellExecCapable — lifecycle delegation (the 4 frozen methods pass through)", () => {
  it("delegates create/start/stop/destroy to the underlying OpenShell adapter", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const wrapper = makeOpenShellExecCapable(adapter);

    const created = await wrapper.createSandbox(CTX, { image: PINNED_SANDBOX_IMAGE });
    expect(created.status).toBe("ok");
    if (created.status !== "ok") throw new Error("unreachable");
    const id = created.sandboxId;

    // start/stop are honest noop shims for a KNOWN id; both must succeed through the wrapper.
    expect((await wrapper.startSandbox(CTX, id)).status).toBe("ok");
    expect((await wrapper.stopSandbox(CTX, id)).status).toBe("ok");
    expect((await wrapper.destroySandbox(CTX, id)).status).toBe("ok");
    // After destroy the mapping is gone => a second destroy fails closed (proves the SAME adapter state).
    expect((await wrapper.destroySandbox(CTX, id)).status).toBe("denied");
  });
});

describe("makeOpenShellExecCapable — through makeExecEffect (credential-blind + 64KB cap still hold)", () => {
  it("(d) drives the wrapper through makeExecEffect: ok exec -> EffectResult{ok:true} carrying exit + output", async () => {
    const t = execTransport({ execEvents: [stdoutEvent("hello"), exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const wrapper = makeOpenShellExecCapable(adapter);
    const id = await createMapped(adapter);

    const effect = makeExecEffect(wrapper, id, { detectSecret });
    const res: EffectResult = await effect({ context: CTX, args: { argv: ["echo", "hello"] } });

    expect(res.ok).toBe(true);
    expect(res.detail).toContain("exit=0");
    expect(res.detail).toContain("hello");
  });

  it("(d) credential-blind OUTPUT: a stdout-echoed runtime-built canary is redacted out of the EffectResult", async () => {
    const canary = secretCanary();
    const t = execTransport({
      execEvents: [
        stdoutEvent(`leaked: ${canary}\n`),
        stderrEvent(`also: ${canary}`),
        exitEvent(0),
      ],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const wrapper = makeOpenShellExecCapable(adapter);
    const id = await createMapped(adapter);

    const effect = makeExecEffect(wrapper, id, { detectSecret });
    const res = await effect({ context: CTX, args: { argv: ["cat", "secret.txt"] } });

    expect(res.ok).toBe(true);
    expect(res.detail).toBeDefined();
    expect(res.detail).not.toContain(canary);
    expect(res.detail).toContain("[REDACTED]");
  });

  it("(d) credential-blind INPUT: a raw secret in env is rejected upstream — execSandbox is NEVER called", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const wrapper = makeOpenShellExecCapable(adapter);
    const id = await createMapped(adapter);

    const effect = makeExecEffect(wrapper, id, { detectSecret });
    const res = await effect({
      context: CTX,
      args: { argv: ["printenv"], env: { TOKEN: secretCanary() } },
    });

    expect(res.ok).toBe(false);
    expect(res.detail).toContain("credential-blind");
    expect(t.execCalls).toHaveLength(0); // raw secret NEVER reached the OpenShell streaming exec / RPC
  });

  it("(d) the port-level 64KB output cap still holds through the wrapper", async () => {
    const huge = "x".repeat(200_000); // > 64KB once decoded
    const t = execTransport({ execEvents: [stdoutEvent(huge), exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const wrapper = makeOpenShellExecCapable(adapter);
    const id = await createMapped(adapter);

    const cap = 65_536;
    const effect = makeExecEffect(wrapper, id, { detectSecret, maxOutputBytes: cap });
    const res = await effect({ context: CTX, args: { argv: ["dump"] } });

    expect(res.ok).toBe(true);
    expect(res.detail).toBeDefined();
    expect(Buffer.byteLength(res.detail ?? "", "utf8")).toBeLessThanOrEqual(cap);
    expect(res.detail).toContain("[truncated]");
  });
});
