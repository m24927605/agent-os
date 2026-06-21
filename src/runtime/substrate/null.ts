/**
 * Fail-closed substrate adapter used when no real backend is wired: every operation is DENIED by
 * construction ("managed-path-is-only-path": unconfigured = nothing runs). Performs NO I/O / network /
 * process work — it imports only the port (which imports only identity primitives + zod).
 */
import { type AdapterResult, type SandboxAdapter, type SandboxSpec, deny } from "./port.js";

const DENY_REASON = "no substrate adapter configured (deny-by-default, fail-closed)";

export class NullSandboxAdapter implements SandboxAdapter {
  createSandbox(ctx: unknown, _spec: SandboxSpec): Promise<AdapterResult> {
    return Promise.resolve(deny(ctx, "create", DENY_REASON));
  }
  startSandbox(ctx: unknown, _sandboxId: string): Promise<AdapterResult> {
    return Promise.resolve(deny(ctx, "start", DENY_REASON));
  }
  stopSandbox(ctx: unknown, _sandboxId: string): Promise<AdapterResult> {
    return Promise.resolve(deny(ctx, "stop", DENY_REASON));
  }
  destroySandbox(ctx: unknown, _sandboxId: string): Promise<AdapterResult> {
    return Promise.resolve(deny(ctx, "destroy", DENY_REASON));
  }
}
