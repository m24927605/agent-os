/**
 * In-memory substrate adapter — the mandatory 2nd implementation of the ExecutionSubstrate port.
 *
 * Its job is twofold: (1) prove the port is genuinely swappable (pluggability HARD CONSTRAINT needs
 * >=2 impls + a shared contract test, not a single vendor); (2) give the orchestration/integration
 * slices a deterministic substrate to test against without a live backend. It is STILL fail-closed on
 * a malformed AgentContext (invalid identity is never executed) — the contract that holds for every
 * adapter. It does NO real I/O: state is a Set in memory; it imports only the port + identity
 * primitives (no I/O-capable module — asserted by sandbox-adapter.test.ts).
 */
import { SandboxId, parseAgentContext } from "../../iam/ids.js";
import {
  type AdapterResult,
  type ExecCapableSandboxAdapter,
  type ExecCommandSpec,
  ExecCommandSpecSchema,
  type ExecResult,
  type SandboxSpec,
  deny,
  ok,
} from "./port.js";

/**
 * Deterministic, scriptable exec for the Fake. Receives the VALIDATED spec (argv/env/timeout) and the
 * resolved sandbox id, and returns a buffered `ExecResult`. The default (no script) is a deterministic
 * success that echoes the joined argv on stdout. Tests inject adversarial scripts: a stdout that echoes
 * a runtime-built secret canary; a HUGE stdout (> the output cap); a fail-closed `{ok:false}` (no
 * terminal exit / launch failure). NO real process is ever spawned — this is pure in-memory.
 */
export type FakeExecScript = (spec: ExecCommandSpec, sandboxId: string) => ExecResult;

export interface FakeSandboxAdapterOptions {
  readonly exec?: FakeExecScript;
}

export class FakeSandboxAdapter implements ExecCapableSandboxAdapter {
  private readonly live = new Set<string>();
  private counter = 0;
  private readonly execScript: FakeExecScript;

  constructor(options: FakeSandboxAdapterOptions = {}) {
    this.execScript =
      options.exec ??
      ((spec) => ({
        ok: true,
        exitCode: 0,
        stdout: spec.argv.join(" "),
        stderr: "",
        truncated: false,
      }));
  }

  createSandbox(ctx: unknown, _spec: SandboxSpec): Promise<AdapterResult> {
    let context: ReturnType<typeof parseAgentContext>;
    try {
      context = parseAgentContext(ctx);
    } catch {
      return Promise.resolve(deny(ctx, "create", "invalid agent context (fail-closed)"));
    }
    const id = SandboxId.parse(`sbx-fake-${++this.counter}`);
    this.live.add(id);
    return Promise.resolve(ok(context, "create", id));
  }

  startSandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult> {
    return this.transition(ctx, "start", sandboxId);
  }
  stopSandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult> {
    return this.transition(ctx, "stop", sandboxId);
  }
  destroySandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult> {
    const res = this.transition(ctx, "destroy", sandboxId);
    this.live.delete(sandboxId);
    return res;
  }

  /**
   * Run the scripted command. Fail-closed at every gate (invalid ctx / malformed spec / unknown
   * sandbox) — and even a script that throws is caught and surfaced as `{ok:false}`, never a thrown
   * error across the port boundary and never a fabricated success.
   */
  execSandbox(ctx: unknown, sandboxId: string, spec: ExecCommandSpec): Promise<ExecResult> {
    try {
      parseAgentContext(ctx);
    } catch {
      return Promise.resolve({ ok: false, reason: "invalid agent context (fail-closed)" });
    }
    let id: ReturnType<typeof SandboxId.parse>;
    try {
      id = SandboxId.parse(sandboxId);
    } catch {
      return Promise.resolve({ ok: false, reason: "invalid sandbox id (fail-closed)" });
    }
    if (!this.live.has(id)) {
      return Promise.resolve({ ok: false, reason: "unknown sandbox (fail-closed)" });
    }
    const parsed = ExecCommandSpecSchema.safeParse(spec);
    if (!parsed.success) {
      return Promise.resolve({ ok: false, reason: "malformed exec spec (fail-closed)" });
    }
    try {
      return Promise.resolve(this.execScript(parsed.data, id));
    } catch {
      return Promise.resolve({ ok: false, reason: "exec script error (fail-closed)" });
    }
  }

  private transition(
    ctx: unknown,
    lifecycle: "start" | "stop" | "destroy",
    sandboxId: string,
  ): Promise<AdapterResult> {
    let context: ReturnType<typeof parseAgentContext>;
    try {
      context = parseAgentContext(ctx);
    } catch {
      return Promise.resolve(deny(ctx, lifecycle, "invalid agent context (fail-closed)"));
    }
    let id: ReturnType<typeof SandboxId.parse>;
    try {
      id = SandboxId.parse(sandboxId);
    } catch {
      return Promise.resolve(deny(ctx, lifecycle, "invalid sandbox id (fail-closed)"));
    }
    if (!this.live.has(id)) {
      return Promise.resolve(deny(ctx, lifecycle, "unknown sandbox (fail-closed)"));
    }
    return Promise.resolve(ok(context, lifecycle, id));
  }
}
