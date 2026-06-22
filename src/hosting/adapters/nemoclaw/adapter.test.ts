/**
 * NemoClawAgentHosting adapter — behavioural + adversarial RED tests.
 *
 * Maps NemoClaw's real launch / health-probe / recovery command shapes (verified from
 * /tmp/nemoclaw/src/lib/agent/runtime.ts: nohup launch :143, gosu drop :147, curl '%{http_code}'
 * 200|401 probe :203/:272, recovery script :220-284, `echo "GATEWAY_PID=$GPID"` :211/:279) onto the
 * vendor-neutral AgentHosting port, while ADDING the tenant scoping NemoClaw deliberately omits.
 *
 * The real ExecSandbox transport (R1) is replaced by an injected in-process CommandSink that records
 * every dispatched command string, so the contract runs with no I/O. These tests assert: command
 * SHAPE, tenant isolation, fail-closed on bad ctx / sink throw, and credential-blindness of the
 * dispatched command string.
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
const ctxB = { ...ctxA, tenantId: "tenant-b", requestId: "req-2" };
const spec = { sandboxId: "sbx-1", agentName: "hermes", gatewayCommand: '"$OPENCLAW" gateway run' };

/** A scriptable in-process CommandSink double that records every dispatched command string. */
class RecordingSink implements CommandSink {
  readonly commands: string[] = [];
  constructor(private readonly stdoutFor: (command: string) => string = () => "GATEWAY_PID=4242") {}
  run(command: string): Promise<{ exitCode: number; stdout: string }> {
    this.commands.push(command);
    return Promise.resolve({ exitCode: 0, stdout: this.stdoutFor(command) });
  }
}

class ThrowingSink implements CommandSink {
  run(): Promise<{ exitCode: number; stdout: string }> {
    throw new Error("transport down");
  }
}

describe("NemoClawAgentHosting — hostAgent (launch command shape)", () => {
  it("hosts under the SAME tenant, returns the parsed GATEWAY_PID as agentProcessId", async () => {
    const sink = new RecordingSink();
    const h = new NemoClawAgentHosting(sink);
    const r = await h.hostAgent(ctxA, spec);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.agentProcessId).toBe("4242");
      expect(r.event.operation).toBe("host");
      expect(r.event.result).toBe("ok");
    }
    // NemoClaw launch shape: nohup ... & (with optional gosu drop).
    expect(sink.commands).toHaveLength(1);
    expect(sink.commands[0]).toContain("nohup");
    expect(sink.commands[0]).toContain("&");
    expect(sink.commands[0]).toContain("gosu");
    expect(sink.commands[0]).toContain(spec.gatewayCommand);
  });

  it("denies when the sink returns no GATEWAY_PID (fail-closed on launch failure)", async () => {
    const sink = new RecordingSink(() => "GATEWAY_FAILED");
    const r = await new NemoClawAgentHosting(sink).hostAgent(ctxA, spec);
    expect(r.status).toBe("denied");
  });
});

describe("NemoClawAgentHosting — getAgentStatus (health-probe shape)", () => {
  it("dispatches the curl '%{http_code}' probe; 200 => running", async () => {
    const sink = new RecordingSink((cmd) => (cmd.includes("http_code") ? "200" : "GATEWAY_PID=7"));
    const h = new NemoClawAgentHosting(sink);
    await h.hostAgent(ctxA, spec);
    const r = await h.getAgentStatus(ctxA, "sbx-1");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.phase).toBe("running");
    const probe = sink.commands.at(-1) ?? "";
    expect(probe).toContain("curl");
    expect(probe).toContain("%{http_code}");
    // The health endpoint is on the DASHBOARD_PORT (runtime.ts:51-57), NOT port 80. The default
    // injected dashboardPort is 18789 — probing :80 silently broke against real NemoClaw (the fake
    // sink never cared about the port). See "health-probe port" describe below.
    expect(probe).toContain("http://127.0.0.1:18789/health");
    expect(probe).not.toContain("http://127.0.0.1/health");
  });

  it("401 => running (authed-but-up), 000 => stopped", async () => {
    const codes = ["401", "000"];
    let i = 0;
    const sink = new RecordingSink((cmd) =>
      cmd.includes("http_code") ? (codes[i++] ?? "000") : "GATEWAY_PID=7",
    );
    const h = new NemoClawAgentHosting(sink);
    await h.hostAgent(ctxA, spec);
    expect(((await h.getAgentStatus(ctxA, "sbx-1")) as { phase: string }).phase).toBe("running");
    expect(((await h.getAgentStatus(ctxA, "sbx-1")) as { phase: string }).phase).toBe("stopped");
  });
});

describe("NemoClawAgentHosting — reconcileAgentProcess", () => {
  it("'health-probe' dispatches a probe command", async () => {
    const sink = new RecordingSink((cmd) => (cmd.includes("http_code") ? "200" : "GATEWAY_PID=7"));
    const h = new NemoClawAgentHosting(sink);
    await h.hostAgent(ctxA, spec);
    const r = await h.reconcileAgentProcess(ctxA, "sbx-1", "health-probe");
    expect(r.status).toBe("ok");
    expect(sink.commands.at(-1) ?? "").toContain("curl");
  });

  it("'restart' dispatches a recovery-script shaped command (pkill + relaunch)", async () => {
    const sink = new RecordingSink();
    const h = new NemoClawAgentHosting(sink);
    await h.hostAgent(ctxA, spec);
    const r = await h.reconcileAgentProcess(ctxA, "sbx-1", "restart");
    expect(r.status).toBe("ok");
    const recovery = sink.commands.at(-1) ?? "";
    expect(recovery).toContain("pkill");
    expect(recovery).toContain("nohup");
  });
});

describe("NemoClawAgentHosting — health-probe port (the fixed drift)", () => {
  /** Pull out the curl probe command from the most-recent dispatch (or "" if none). */
  function lastProbe(sink: RecordingSink): string {
    return sink.commands.at(-1) ?? "";
  }

  it("probes the DASHBOARD_PORT default 18789, NOT port 80 (runtime.ts:51-57)", async () => {
    const sink = new RecordingSink((cmd) => (cmd.includes("http_code") ? "200" : "GATEWAY_PID=7"));
    const h = new NemoClawAgentHosting(sink);
    await h.hostAgent(ctxA, spec);
    await h.getAgentStatus(ctxA, "sbx-1");
    expect(lastProbe(sink)).toContain("http://127.0.0.1:18789/health");
    expect(lastProbe(sink)).not.toContain("http://127.0.0.1/health");
  });

  it("threads a CUSTOM injected dashboardPort into the probe command", async () => {
    const sink = new RecordingSink((cmd) => (cmd.includes("http_code") ? "200" : "GATEWAY_PID=7"));
    const h = new NemoClawAgentHosting(sink, { dashboardPort: 19000 });
    await h.hostAgent(ctxA, spec);
    await h.getAgentStatus(ctxA, "sbx-1");
    expect(lastProbe(sink)).toContain("http://127.0.0.1:19000/health");
    expect(lastProbe(sink)).not.toContain("http://127.0.0.1:18789/health");
  });

  it("a 'health-probe' reconcile probes against the injected port too", async () => {
    const sink = new RecordingSink((cmd) => (cmd.includes("http_code") ? "200" : "GATEWAY_PID=7"));
    const h = new NemoClawAgentHosting(sink, { dashboardPort: 19500 });
    await h.hostAgent(ctxA, spec);
    // A 'health-probe' reconcile dispatches the probe command (not the recovery script).
    await h.reconcileAgentProcess(ctxA, "sbx-1", "health-probe");
    expect(lastProbe(sink)).toContain("http://127.0.0.1:19500/health");
  });
});

describe("NemoClawAgentHosting — tenant isolation (the NemoClaw gap, closed)", () => {
  it("tenant-B cannot status / reconcile / re-host tenant-A's agent", async () => {
    const sink = new RecordingSink();
    const h = new NemoClawAgentHosting(sink);
    expect((await h.hostAgent(ctxA, spec)).status).toBe("ok");
    for (const r of [
      await h.getAgentStatus(ctxB, "sbx-1"),
      await h.reconcileAgentProcess(ctxB, "sbx-1", "restart"),
      await h.hostAgent(ctxB, spec),
    ]) {
      expect(r.status).toBe("denied");
      if (r.status === "denied") expect(r.reason.toLowerCase()).toContain("cross-tenant");
    }
  });

  it("does NOT dispatch any command on a cross-tenant denial (fail-closed before transport)", async () => {
    const sink = new RecordingSink();
    const h = new NemoClawAgentHosting(sink);
    await h.hostAgent(ctxA, spec);
    const before = sink.commands.length;
    await h.getAgentStatus(ctxB, "sbx-1");
    await h.reconcileAgentProcess(ctxB, "sbx-1", "restart");
    expect(sink.commands.length).toBe(before);
  });

  it("unknown sandbox: status / reconcile are denied", async () => {
    const h = new NemoClawAgentHosting(new RecordingSink());
    expect((await h.getAgentStatus(ctxA, "sbx-nope")).status).toBe("denied");
    expect((await h.reconcileAgentProcess(ctxA, "sbx-nope", "restart")).status).toBe("denied");
  });
});

describe("NemoClawAgentHosting — fail-closed (deny-by-default, never throws)", () => {
  it("malformed ctx is denied with a contextError, no throw", async () => {
    const h = new NemoClawAgentHosting(new RecordingSink());
    for (const bad of [{}, null, { tenantId: "" }, { tenantId: "t" }]) {
      const r = await h.hostAgent(bad, spec);
      expect(r.status).toBe("denied");
      expect(r.event.contextError).toBeDefined();
    }
  });

  it("a malformed ctx never dispatches a command (no transport on a denied op)", async () => {
    const sink = new RecordingSink();
    const h = new NemoClawAgentHosting(sink);
    await h.hostAgent({}, spec);
    expect(sink.commands).toHaveLength(0);
  });

  it("a throwing CommandSink yields a denial, never an exception", async () => {
    const h = new NemoClawAgentHosting(new ThrowingSink());
    const r = await h.hostAgent(ctxA, spec);
    expect(r.status).toBe("denied");
    if (r.status === "denied") expect(r.reason).toBeTruthy();
  });

  it("every method resolves (never throws) on garbage input", async () => {
    const h = new NemoClawAgentHosting(new ThrowingSink());
    await expect(h.hostAgent({}, spec)).resolves.toBeDefined();
    await expect(h.getAgentStatus(undefined, "x")).resolves.toBeDefined();
    await expect(h.reconcileAgentProcess({}, "x", "restart")).resolves.toBeDefined();
  });
});

describe("NemoClawAgentHosting — credential-blind dispatched command", () => {
  it("the launch command carries only non-secret env (HERMES_HOME), no secret-shape token", async () => {
    const sink = new RecordingSink();
    const h = new NemoClawAgentHosting(sink);
    await h.hostAgent(ctxA, spec);
    const launch = sink.commands[0] ?? "";
    expect(launch).toContain("HERMES_HOME");
    expect(/credential|secret|password|bearer|apikey|api[_-]?key|sk-[a-z0-9]/i.test(launch)).toBe(
      false,
    );
  });
});
