/**
 * NemoClawAgentHosting — OBSERVE mode contract (SLICE-AH-OBS-S1).
 *
 * The Hermes live finding (a4311a7): the real NemoClaw/Hermes gateway is launched by a ROOT
 * entrypoint that drops to a privileged `gateway` user — our adapter runs as a non-root `sandbox`
 * user and so CANNOT exec-launch that binary (Permission denied). The design response is an OBSERVE
 * mode: the substrate/entrypoint owns the gateway lifecycle; the adapter only PROBES (/health) and
 * health-reconciles — it NEVER launches via exec.
 *
 * THE key non-vacuity invariant proven here: in observe mode `hostAgent` issues ONLY the probe
 * command and NEVER a launch command (no `nohup`, no `gosu`-launch shape). If the implementation
 * regressed to still launching in observe mode, the "no launch command" assertion goes RED.
 *
 * The real ExecSandbox transport is replaced by an in-process RecordingSink that records every
 * dispatched command string, so the contract runs with no I/O.
 */
import { describe, expect, it } from "vitest";
import { type CommandSink, NemoClawAgentHosting } from "./index.js";

const ctxA = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

/** A scriptable in-process CommandSink double that records every dispatched command string. */
class RecordingSink implements CommandSink {
  readonly commands: string[] = [];
  constructor(private readonly stdoutFor: (command: string) => string = () => "GATEWAY_PID=4242") {}
  run(command: string): Promise<{ exitCode: number; stdout: string }> {
    this.commands.push(command);
    return Promise.resolve({ exitCode: 0, stdout: this.stdoutFor(command) });
  }
}

/** The observe-mode host spec: the substrate/entrypoint launches the gateway; we only observe it. */
const observeSpec = {
  sandboxId: "sbx-obs",
  agentName: "hermes",
  gatewayCommand: '"$OPENCLAW" gateway run',
  mode: "observe" as const,
};

/** True iff the command looks like an attempt to LAUNCH the gateway (nohup/gosu-launch shape). */
function looksLikeLaunch(command: string): boolean {
  return /\bnohup\b/.test(command) || /\bgosu\b/.test(command) || /GATEWAY_PID=\$!/.test(command);
}

describe("NemoClawAgentHosting — observe mode hostAgent (probes, never launches)", () => {
  it("observes a running gateway (probe 200): ok, sentinel agentProcessId, registered observe", async () => {
    // Probe returns 200 => running. (No GATEWAY_PID is ever produced in observe mode.)
    const sink = new RecordingSink((cmd) => (cmd.includes("http_code") ? "200" : "UNEXPECTED"));
    const h = new NemoClawAgentHosting(sink);

    const r = await h.hostAgent(ctxA, observeSpec);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      // Honest sentinel: we did NOT launch a process, we OBSERVED one — so this is not a PID.
      expect(r.agentProcessId).toBe("observed");
      expect(r.event.operation).toBe("host");
      expect(r.event.result).toBe("ok");
    }

    // THE non-vacuity: observe must dispatch ONLY the probe, NEVER a launch command.
    expect(sink.commands).toHaveLength(1);
    expect(sink.commands[0]).toContain("curl");
    expect(sink.commands[0]).toContain("%{http_code}");
    expect(sink.commands.some(looksLikeLaunch)).toBe(false);

    // The observed agent is registered (subsequent owned ops resolve) under THIS tenant.
    const status = await h.getAgentStatus(ctxA, observeSpec.sandboxId);
    expect(status.status).toBe("ok");
  });

  it("observes a running gateway (probe 401 = authed-but-up): ok + sentinel, still no launch", async () => {
    const sink = new RecordingSink((cmd) => (cmd.includes("http_code") ? "401" : "UNEXPECTED"));
    const h = new NemoClawAgentHosting(sink);

    const r = await h.hostAgent(ctxA, observeSpec);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.agentProcessId).toBe("observed");
    expect(sink.commands.some(looksLikeLaunch)).toBe(false);
  });

  it("fails closed when the gateway is NOT running (probe 000/500): denied, NOTHING registered", async () => {
    for (const code of ["000", "500"]) {
      const sink = new RecordingSink((cmd) => (cmd.includes("http_code") ? code : "UNEXPECTED"));
      const h = new NemoClawAgentHosting(sink);

      const r = await h.hostAgent(ctxA, observeSpec);
      expect(r.status).toBe("denied");
      if (r.status === "denied") {
        expect(r.reason.toLowerCase()).toContain("observe mode");
        expect(r.reason.toLowerCase()).toContain("not running");
      }
      // Probed once, never launched.
      expect(sink.commands.some(looksLikeLaunch)).toBe(false);

      // Fail-closed registration: a denied observe-host registers NO agent (status is then unknown).
      const status = await h.getAgentStatus(ctxA, observeSpec.sandboxId);
      expect(status.status).toBe("denied");
    }
  });

  it("a probe transport error denies (fail-closed), with no launch attempt", async () => {
    // exitCode!==0 => dispatch() yields the fail-closed marker.
    const sink: CommandSink = {
      run: (command: string) => {
        return Promise.resolve({ exitCode: 7, stdout: command });
      },
    };
    const recorded: string[] = [];
    const wrapped: CommandSink = {
      run: (command: string) => {
        recorded.push(command);
        return sink.run(command);
      },
    };
    const h = new NemoClawAgentHosting(wrapped);
    const r = await h.hostAgent(ctxA, observeSpec);
    expect(r.status).toBe("denied");
    expect(recorded.some(looksLikeLaunch)).toBe(false);
  });
});

describe("NemoClawAgentHosting — observe mode reconcile (restart fail-closed, health-probe ok)", () => {
  it("'restart' is DENIED in observe mode (gateway lifecycle owned by the substrate)", async () => {
    const sink = new RecordingSink((cmd) => (cmd.includes("http_code") ? "200" : "UNEXPECTED"));
    const h = new NemoClawAgentHosting(sink);
    await h.hostAgent(ctxA, observeSpec);
    const before = sink.commands.length;

    const r = await h.reconcileAgentProcess(ctxA, observeSpec.sandboxId, "restart");
    expect(r.status).toBe("denied");
    if (r.status === "denied") {
      expect(r.reason.toLowerCase()).toContain("observe mode");
      expect(r.reason.toLowerCase()).toContain("restart");
    }
    // Fail-closed: a denied observe-restart issues NO command (no exec, no relaunch/pkill).
    expect(sink.commands.length).toBe(before);
    expect(sink.commands.some(looksLikeLaunch)).toBe(false);
  });

  it("'health-probe' STILL probes in observe mode (same as launch mode)", async () => {
    const sink = new RecordingSink((cmd) => (cmd.includes("http_code") ? "200" : "UNEXPECTED"));
    const h = new NemoClawAgentHosting(sink);
    await h.hostAgent(ctxA, observeSpec);

    const r = await h.reconcileAgentProcess(ctxA, observeSpec.sandboxId, "health-probe");
    expect(r.status).toBe("ok");
    expect(sink.commands.at(-1) ?? "").toContain("curl");
    expect(sink.commands.some(looksLikeLaunch)).toBe(false);
  });
});
