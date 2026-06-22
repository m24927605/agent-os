/**
 * Production composition root for the NemoClaw hosting path on OpenShell (slice SLICE-OS-S2a).
 *
 * This is the SINGLE place that wires a FULL lifecycle on ONE `OpenShellSandboxAdapter` instance:
 *   1. `adapter.createSandbox(ctx, { image: sandboxImage })` — the REAL CreateSandbox RPC populates the
 *      adapter's `refById` ({name,id}) from the gateway response. NO test reflection seed is needed
 *      anywhere (this closes NC-S11b's same-instance tracking gap).
 *   2. poll readiness to READY via the adapter's `awaitReady` (getSandbox path) until `phase===READY`,
 *      bounded by `readinessTimeoutMs` — FAIL-CLOSED on timeout / ERROR (never proceed on an unknown
 *      or PROVISIONING phase past the deadline).
 *   3. build the NemoClaw host via the SAME adapter: `createOpenShellExecCommandSink({ exec:
 *      createNemoClawOpenShellExec(adapter, ctx), sandboxId })` -> `new NemoClawAgentHosting(sink, …)`.
 * It returns `{ host, sandboxId, dispose }` where `dispose()` deletes the sandbox via the same adapter.
 *
 * Because create + ready + exec + delete all run through the SAME adapter, the in-adapter `refById`
 * mapping is consistent end-to-end with NO out-of-band seed — exactly the property NC-S11b's live test
 * had to fake with reflection.
 *
 * CREDENTIAL-BLIND: only the (non-secret) pinned image, the dashboard port, and the AgentContext cross
 * the seams; no credential is assembled here. The image MUST be a pinned `sha256:` digest — the adapter
 * fails closed (deny) on a floating tag, so a denied create here throws before any host is built.
 */
import { type CommandSink, NemoClawAgentHosting } from "../../hosting/adapters/nemoclaw/index.js";
import type { OpenShellSandboxAdapter } from "../openshell/index.js";
import type { AdapterResult } from "../substrate/index.js";
import { createOpenShellExecCommandSink } from "./exec-command-sink.js";
import { createNemoClawOpenShellExec } from "./openshell-exec.js";

/** Options for {@link createNemoClawOnOpenShell}. */
export interface CreateNemoClawOnOpenShellOpts {
  /** The concrete OpenShell adapter — the SAME instance is used to create, ready, exec, and delete. */
  readonly adapter: OpenShellSandboxAdapter;
  /** Caller identity; bound into the exec seam + every lifecycle op (carries no secret). */
  readonly ctx: unknown;
  /** The pinned sandbox boot image — MUST be a `sha256:` digest (the adapter denies a floating tag). */
  readonly sandboxImage: string;
  /** Port the agent's gateway dashboard serves /health on (forwarded to NemoClawAgentHosting). */
  readonly dashboardPort?: number;
  /** Wall-clock budget for the whole readiness wait. Expiry => fail-closed (deny). Default 120s. */
  readonly readinessTimeoutMs?: number;
  /** Delay between readiness polls. Default 1s. */
  readonly readinessIntervalMs?: number;
}

/** Result of {@link createNemoClawOnOpenShell}: the wired host + the created sandbox id + a disposer. */
export interface NemoClawOnOpenShell {
  /** The NemoClaw hosting adapter, wired to exec inside the created sandbox via the SAME adapter. */
  readonly host: NemoClawAgentHosting;
  /** The adapter's branded SandboxId for the created sandbox (the host/exec/dispose lookup key). */
  readonly sandboxId: string;
  /** Delete the created sandbox via the SAME adapter (keyed by name internally). */
  readonly dispose: () => Promise<AdapterResult>;
}

/** Default wall-clock budget for the whole readiness wait (a fresh sandbox provisions in seconds). */
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
/** Default delay between readiness polls. */
const DEFAULT_READINESS_INTERVAL_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a sandbox on OpenShell, wait until it is READY, and return a NemoClaw host bound to it — all on
 * ONE adapter instance (no refById seed). Fail-closed on EVERY non-happy path: a denied create (bad
 * ctx / unpinned image / transport refused) and a readiness timeout / ERROR phase BOTH throw, so no
 * host is ever built against a sandbox that is not provably READY.
 */
export async function createNemoClawOnOpenShell(
  opts: CreateNemoClawOnOpenShellOpts,
): Promise<NemoClawOnOpenShell> {
  const { adapter, ctx, sandboxImage } = opts;
  const timeoutMs = opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const intervalMs = opts.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS;

  // (1) Create via the SAME adapter — the REAL CreateSandbox response populates refById. A denied
  // create (invalid ctx / unpinned image / transport refused) NEVER proceeds to host (fail-closed).
  const created = await adapter.createSandbox(ctx, { image: sandboxImage });
  if (created.status !== "ok") {
    throw new Error(`openshell create denied (fail-closed): ${created.reason}`);
  }
  const sandboxId = created.sandboxId;

  // (2) Poll readiness to READY via the adapter's getSandbox path. `awaitReady` returns `ok` ONLY when
  // GetSandbox reports phase===READY; every other phase (PROVISIONING / ERROR / unknown), an RPC
  // rejection, or the OS-S2b watch stub failing closed yields a `denied` — so we retry until READY or
  // the overall deadline elapses. A never-ready sandbox (incl. a terminal ERROR phase) therefore times
  // out and FAILS CLOSED rather than ever being treated as ready.
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // Bound each probe so the adapter's internal watch fallback (OS-S2b stub => deny) cannot hang; the
    // adapter races GetSandbox against this per-probe budget.
    const probeBudget = Math.min(remaining, Math.max(intervalMs, 1));
    const verdict = await adapter.awaitReady(ctx, sandboxId, { deadlineMs: probeBudget });
    if (verdict.status === "ok") {
      ready = true;
      break;
    }
    // Not ready yet (pending / error / watch-stub deny): wait, then re-probe until the overall deadline.
    if (Date.now() + intervalMs >= deadline) break;
    await sleep(intervalMs);
  }
  if (!ready) {
    // Best-effort cleanup of the sandbox we created but could not ready (never leak a sandbox), then
    // fail closed. The delete result is intentionally ignored — readiness already failed.
    await adapter.destroySandbox(ctx, sandboxId).catch(() => {});
    throw new Error("openshell sandbox did not reach READY before the deadline (fail-closed)");
  }

  // (3) Build the NemoClaw host through the SAME adapter — exec keys on the refById CreateSandbox
  // populated, so NO seed is needed. The exec seam wraps each command as `/bin/sh -c <cmd>`.
  const sink: CommandSink = createOpenShellExecCommandSink({
    exec: createNemoClawOpenShellExec(adapter, ctx),
    sandboxId,
  });
  const host = new NemoClawAgentHosting(sink, {
    ...(opts.dashboardPort !== undefined ? { dashboardPort: opts.dashboardPort } : {}),
  });

  return {
    host,
    sandboxId,
    dispose: () => adapter.destroySandbox(ctx, sandboxId),
  };
}
