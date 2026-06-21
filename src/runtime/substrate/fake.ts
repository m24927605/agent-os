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
import { type AdapterResult, type SandboxAdapter, type SandboxSpec, deny, ok } from "./port.js";

export class FakeSandboxAdapter implements SandboxAdapter {
  private readonly live = new Set<string>();
  private counter = 0;

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
