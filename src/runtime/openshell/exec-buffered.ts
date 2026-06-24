/**
 * SLICE-EXEC2 — `makeOpenShellExecCapable`: the THIN buffered wrapper that reconciles OpenShell's
 * existing STREAMING exec onto the substrate port's BUFFERED `ExecCapableSandboxAdapter` contract, so
 * the credential-blind `makeExecEffect` can drive a REAL OpenShell sandbox.
 *
 * The OpenShell adapter ALREADY owns the hard parts (it is NOT touched here): `execSandbox(...cmd, opts)`
 * drives the `ExecSandbox` server-stream, accumulates stdout/stderr, converges on the terminal exit, and
 * is already FAIL-CLOSED + capped — an 8 MiB byte-cap overflow DENIES (never OOM, never a truncated
 * success) and a wall-clock deadline that elapses before a terminal exit DENIES (never a fabricated exit
 * 0). This wrapper is a pure SHAPE adapter; it adds NO new fail-closed logic and removes none.
 *
 * The reconcile is two collisions:
 *   1. SHAPE — OpenShell exposes a `{status:"ok"|"denied"}` union (`OsExecOutcome`) carrying its OWN
 *      richer `ExecResult` (`Uint8Array` stdout/stderr); the port wants a `{ok:true|false}` union
 *      (`port.ExecResult`) carrying `string` stdout/stderr + a `truncated` flag.
 *   2. NAME — both unions name a type `ExecResult`. The OpenShell one is imported under an alias
 *      (`OsExecResult`) so the two never silently conflate.
 *
 * Mapping (the ONLY safety-relevant logic):
 *   • status "ok"     -> { ok:true, exitCode, stdout: decode(streams.stdout), stderr: decode, truncated:false }
 *   • status "denied" -> { ok:false, reason }   — a denied/failed outcome is NEVER mapped to ok and a
 *                                                 fabricated exit 0 is NEVER invented (byte-cap / deadline
 *                                                 deny propagate as { ok:false } verbatim).
 * `truncated` is always `false`: the OpenShell adapter NEVER returns a truncated SUCCESS — an overflow is
 * a deny, not a capped ok — so a buffered ok is always the full captured output. The port-level 64KB cap
 * lives in `makeExecEffect` (applied AFTER redaction), not here.
 *
 * Lifecycle (create/start/stop/destroy) is DELEGATED verbatim to the wrapped adapter, so the SAME
 * `refById` mapping backs both lifecycle and exec on one adapter instance.
 *
 * This file lives in the OpenShell vendor zone (`src/runtime/openshell/`) and reaches the substrate port
 * types ONLY through the substrate barrel (`../substrate/index.js`) — `no-vendor-in-core` and
 * `not-to-internal` both hold (a vendor adapter consuming a port barrel is exactly the allowed edge).
 */
import type {
  AdapterResult,
  ExecCapableSandboxAdapter,
  ExecCommandSpec,
  ExecResult as PortExecResult,
  SandboxSpec,
} from "../substrate/index.js";
import type {
  ExecSandboxOpts,
  OpenShellSandboxAdapter,
  ExecResult as OsExecResult,
} from "./adapter.js";

/** Decode an exec stream's `Uint8Array` bytes to a UTF-8 string (lossy on a malformed sequence). */
const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);

/**
 * Translate a port `ExecCommandSpec` into the OpenShell `ExecSandboxOpts`. Only the two fields the port
 * carries are mapped:
 *   • `spec.env`        -> `ExecSandboxOpts.env`         (placeholder-only — raw secrets are rejected
 *                                                         UPSTREAM by makeExecEffect; the OpenShell
 *                                                         adapter ALSO re-checks the credential marker).
 *   • `spec.timeoutMs`  -> `ExecSandboxOpts.deadlineMs`  (the wall-clock budget for consuming the whole
 *                                                         exec stream; expiry before a terminal exit =>
 *                                                         deny). `timeoutSeconds` (the in-sandbox command
 *                                                         timeout) is left unset.
 * The OpenShell adapter's own resource caps (the 8 MiB `maxOutputBytes` default, the deadline default)
 * are left at their defaults — the port-level 64KB cap is enforced separately in makeExecEffect.
 */
function optsFromSpec(spec: ExecCommandSpec): ExecSandboxOpts {
  return {
    ...(spec.env !== undefined ? { env: spec.env } : {}),
    ...(spec.timeoutMs !== undefined ? { deadlineMs: spec.timeoutMs } : {}),
  };
}

/**
 * Wrap a REAL `OpenShellSandboxAdapter` as an `ExecCapableSandboxAdapter` (the buffered substrate port).
 * Lifecycle is delegated verbatim; `execSandbox` reconciles the streaming `ExecOutcome` to the buffered
 * `ExecResult`. Fail-closed is inherited from the wrapped adapter — this wrapper neither relaxes nor adds
 * a fail-closed condition.
 */
export function makeOpenShellExecCapable(
  adapter: OpenShellSandboxAdapter,
): ExecCapableSandboxAdapter {
  return {
    // (a) DELEGATE the four frozen lifecycle methods verbatim — same adapter, same refById.
    createSandbox: (ctx: unknown, spec: SandboxSpec): Promise<AdapterResult> =>
      adapter.createSandbox(ctx, spec),
    startSandbox: (ctx: unknown, sandboxId: string): Promise<AdapterResult> =>
      adapter.startSandbox(ctx, sandboxId),
    stopSandbox: (ctx: unknown, sandboxId: string): Promise<AdapterResult> =>
      adapter.stopSandbox(ctx, sandboxId),
    destroySandbox: (ctx: unknown, sandboxId: string): Promise<AdapterResult> =>
      adapter.destroySandbox(ctx, sandboxId),

    // (b) RECONCILE the streaming ExecOutcome -> the buffered port ExecResult.
    async execSandbox(
      ctx: unknown,
      sandboxId: string,
      spec: ExecCommandSpec,
    ): Promise<PortExecResult> {
      const outcome = await adapter.execSandbox(ctx, sandboxId, spec.argv, optsFromSpec(spec));

      if (outcome.status === "denied") {
        // A denied/failed outcome (incl. byte-cap overflow / deadline deny) is NEVER mapped to ok and
        // NEVER carries a fabricated exit code — the failure arm is { ok:false, reason } only.
        return { ok: false, reason: outcome.reason };
      }

      // status === "ok": the adapter observed a terminal exit. Decode the byte streams to UTF-8 strings.
      // `truncated` is always false — the OpenShell adapter never returns a truncated SUCCESS (an
      // overflow is a deny, taken above), so a buffered ok is always the full captured output.
      const r: OsExecResult = outcome.result;
      return {
        ok: true,
        exitCode: r.exitCode,
        stdout: decode(r.stdout),
        stderr: decode(r.stderr),
        truncated: false,
      };
    },
  };
}
