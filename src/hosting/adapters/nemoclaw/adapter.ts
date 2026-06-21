/**
 * NemoClawAgentHosting — the real-vendor adapter for the AgentHosting port (R11-S1).
 *
 * It faithfully maps NemoClaw's launch / health-probe / recovery COMMAND SHAPES
 * (/tmp/nemoclaw/src/lib/agent/runtime.ts):
 *   - launch:   `nohup [gosu <user>] <gatewayCommand> &`               (:143 nohup, :147 gosu drop)
 *   - probe:    `curl -so /dev/null -w '%{http_code}' .../health`, 200|401 => running   (:203 / :272)
 *   - recovery: stale `pkill -TERM/-KILL` + relaunch + `kill -0 "$GPID"`                (:220-284)
 *   - GATEWAY_PID is echoed after liveness check (`echo "GATEWAY_PID=$GPID"`, :211 / :279) — the
 *     adapter parses it from the sink's stdout as the port's `agentProcessId`.
 *
 * It ADDS the tenant scoping NemoClaw deliberately omits (single-operator; runtime.ts:27-45 registry
 * has no tenant dimension): every lifecycle op is scoped against an in-adapter registry so an agent
 * hosted under tenant-A is invisible/untouchable to tenant-B (the Enterprise differentiation, and a
 * port-level invariant — see ../../port.ts).
 *
 * It is CREDENTIAL-BLIND: the dispatched launch command carries only non-secret env (HERMES_HOME,
 * runtime.ts:150-152); no key is ever assembled here. The real ExecSandbox transport (R1) is an
 * injected `CommandSink` seam, so this adapter is exercised fully in-process with no I/O, and the core
 * never imports a vendor SDK.
 *
 * Cohesion: imports ONLY the port's public/internal surface (no deep cross-module import, no vendor).
 */
import {
  type AgentHosting,
  type AgentPhase,
  type HostResult,
  type HostSpec,
  type HostingOperation,
  type ReconcileAction,
  type ReconcileResult,
  type StatusResult,
  contextOrError,
  denyEvent,
} from "../../port.js";

/**
 * Injected transport seam standing in for OpenShell's `ExecSandbox` (live wire lands in R1). It runs
 * a shell command inside the substrate and returns the exit code + stdout. NOT a credential channel.
 */
export interface CommandSink {
  run(command: string): Promise<{ exitCode: number; stdout: string }>;
}

interface HostedAgent {
  readonly tenantId: string;
  readonly agentName: string;
  readonly gatewayCommand: string;
}

/** Non-secret gateway env prefix, mirroring NemoClaw's hermesGatewayEnvPrefix (runtime.ts:150-152). */
const HERMES_ENV_PREFIX = "HERMES_HOME=/sandbox/.hermes";
/** The non-root user NemoClaw drops to via gosu when launching the gateway (runtime.ts:147). */
const GATEWAY_USER = "gateway";

export class NemoClawAgentHosting implements AgentHosting {
  private readonly agents = new Map<string, HostedAgent>();

  constructor(private readonly sink: CommandSink) {}

  async hostAgent(ctx: unknown, spec: HostSpec): Promise<HostResult> {
    const c = contextOrError(ctx);
    if ("contextError" in c)
      return this.denied("host", FAIL_CLOSED, spec.sandboxId, ctx) as HostResult;

    const existing = this.agents.get(spec.sandboxId);
    if (existing && existing.tenantId !== c.context.tenantId) {
      return this.denied("host", CROSS_TENANT, spec.sandboxId, ctx) as HostResult;
    }

    const command = launchCommand(spec.gatewayCommand);
    const out = await this.dispatch(command);
    if ("error" in out) return this.denied("host", out.error, spec.sandboxId, ctx) as HostResult;

    const agentProcessId = parseGatewayPid(out.stdout);
    if (agentProcessId === undefined) {
      return this.denied(
        "host",
        "gateway launch failed (no GATEWAY_PID)",
        spec.sandboxId,
        ctx,
      ) as HostResult;
    }

    this.agents.set(spec.sandboxId, {
      tenantId: c.context.tenantId,
      agentName: spec.agentName,
      gatewayCommand: spec.gatewayCommand ?? DEFAULT_GATEWAY_COMMAND,
    });
    return {
      status: "ok",
      agentProcessId,
      event: { operation: "host", result: "ok", context: c.context, sandboxId: spec.sandboxId },
    };
  }

  async getAgentStatus(ctx: unknown, sandboxId: string): Promise<StatusResult> {
    const owned = this.requireOwned(ctx, "status", sandboxId);
    if ("denied" in owned) return owned.denied as StatusResult;

    const out = await this.dispatch(probeCommand());
    if ("error" in out) return this.denied("status", out.error, sandboxId, ctx) as StatusResult;
    return {
      status: "ok",
      phase: phaseFromProbe(out.stdout),
      event: { operation: "status", result: "ok", context: owned.context, sandboxId },
    };
  }

  async reconcileAgentProcess(
    ctx: unknown,
    sandboxId: string,
    action: ReconcileAction,
  ): Promise<ReconcileResult> {
    const owned = this.requireOwned(ctx, "reconcile", sandboxId);
    if ("denied" in owned) return owned.denied as ReconcileResult;

    const command =
      action === "restart" ? recoveryCommand(owned.agent.gatewayCommand) : probeCommand();
    const out = await this.dispatch(command);
    if ("error" in out)
      return this.denied("reconcile", out.error, sandboxId, ctx) as ReconcileResult;
    return {
      status: "ok",
      event: { operation: "reconcile", result: "ok", context: owned.context, sandboxId },
    };
  }

  /** Run a command through the sink, converting any throw/non-zero exit into a fail-closed marker. */
  private async dispatch(command: string): Promise<{ stdout: string } | { error: string }> {
    try {
      const { exitCode, stdout } = await this.sink.run(command);
      if (exitCode !== 0) return { error: "command sink reported a non-zero exit (fail-closed)" };
      return { stdout };
    } catch {
      return { error: "command transport failed (deny-by-default)" };
    }
  }

  /** Resolve a sandbox the caller owns, or a denied result. Fail-closed; deny unknown / cross-tenant. */
  private requireOwned(ctx: unknown, operation: "status" | "reconcile", sandboxId: string) {
    const c = contextOrError(ctx);
    if ("contextError" in c) return { denied: this.denied(operation, FAIL_CLOSED, sandboxId, ctx) };
    const agent = this.agents.get(sandboxId);
    if (agent === undefined)
      return { denied: this.denied(operation, UNKNOWN_SANDBOX, sandboxId, ctx) };
    if (agent.tenantId !== c.context.tenantId) {
      return { denied: this.denied(operation, CROSS_TENANT, sandboxId, ctx) };
    }
    return { agent, context: c.context };
  }

  private denied(
    operation: HostingOperation,
    reason: string,
    sandboxId: string | undefined,
    ctx: unknown,
  ) {
    return {
      status: "denied" as const,
      reason,
      event: denyEvent(ctx, operation, reason, sandboxId),
    };
  }
}

const FAIL_CLOSED = "invalid agent context (fail-closed)";
const CROSS_TENANT = "cross-tenant: sandbox is hosted by another tenant (deny-by-default)";
const UNKNOWN_SANDBOX = "unknown sandbox (deny-by-default)";
const DEFAULT_GATEWAY_COMMAND = '"$OPENCLAW" gateway run';

/** NemoClaw launch shape: `nohup [gosu <user>] <command> &`, prefixed with non-secret env. */
function launchCommand(gatewayCommand: string | undefined): string {
  const cmd = gatewayCommand ?? DEFAULT_GATEWAY_COMMAND;
  return `${HERMES_ENV_PREFIX} if command -v gosu >/dev/null 2>&1; then nohup gosu ${GATEWAY_USER} ${cmd} & else nohup ${cmd} & fi; GPID=$!; sleep 2; if kill -0 "$GPID" 2>/dev/null; then echo "GATEWAY_PID=$GPID"; else echo GATEWAY_FAILED; fi`;
}

/** NemoClaw health-probe shape: `curl -w '%{http_code}' .../health` (runtime.ts:203/:272). */
function probeCommand(): string {
  return "curl -so /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1/health 2>/dev/null || echo 000";
}

/** NemoClaw recovery shape: stale `pkill` + relaunch + liveness echo (runtime.ts:220-284). */
function recoveryCommand(gatewayCommand: string): string {
  return `pkill -TERM -f openclaw 2>/dev/null || true; pkill -KILL -f openclaw 2>/dev/null || true; ${launchCommand(gatewayCommand)}`;
}

/** Parse `GATEWAY_PID=<n>` from sink stdout (runtime.ts:211/:279). Returns undefined if absent. */
function parseGatewayPid(stdout: string): string | undefined {
  const m = /GATEWAY_PID=(\d+)/.exec(stdout);
  return m ? m[1] : undefined;
}

/** Map a probe's HTTP-code stdout to a phase: 200|401 => running; numeric => stopped; else unknown. */
function phaseFromProbe(stdout: string): AgentPhase {
  const code = stdout.trim();
  if (code === "200" || code === "401") return "running";
  if (/^\d{3}$/.test(code)) return "stopped";
  return "unknown";
}
