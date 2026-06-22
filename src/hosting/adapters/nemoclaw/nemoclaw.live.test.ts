/**
 * NC-S11b GATED live e2e — the FULL NemoClaw hosting path against a RUNNING OpenShell gateway + sandbox.
 *
 * Proves a governance action flows: NemoClawAgentHosting -> S10 CommandSink -> the converged mTLS gRPC
 * exec transport -> a real OpenShell sandbox, hosting/probing/reconciling a trivial gateway process.
 * NO LLM key is required: the "gateway" is a one-line python3 HTTP server on the dashboard port that
 * returns 200 on any path (so the NemoClaw `curl .../health` probe sees `running`).
 *
 * SKIPPED unless `AGENTOS_LIVE_OPENSHELL=1` + `AGENTOS_LIVE_OPENSHELL_SANDBOX=<sandbox id>` are set, so
 * `pnpm run verify` stays hermetic. Run via the live harness: `pnpm run e2e:live-nemoclaw`.
 *
 * The mTLS materials are read from the OpenShell CLI's local store (never inlined, never committed).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NemoClawAgentHosting } from "../../../hosting/adapters/nemoclaw/index.js";
import { createNemoClawOpenShellExec } from "../../../runtime/nemoclaw/index.js";
import { createOpenShellExecCommandSink } from "../../../runtime/nemoclaw/index.js";
import {
  OpenShellSandboxAdapter,
  createOpenShellGrpcTransport,
} from "../../../runtime/openshell/index.js";

const ON = process.env.AGENTOS_LIVE_OPENSHELL === "1";
const SANDBOX_ID = process.env.AGENTOS_LIVE_OPENSHELL_SANDBOX ?? "";
const d = ON && SANDBOX_ID ? describe : describe.skip;

/** The dashboard port the trivial gateway serves /health on (matches NemoClawAgentHosting opts). */
const DASHBOARD_PORT = 18789;

/** A well-formed AgentContext for the live host action. */
const CTX = {
  actorId: "agent:live-probe",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live",
  requestId: "req-live-1",
};

/**
 * A trivial, backgroundable HTTP server: returns 200 on ANY path on 127.0.0.1:DASHBOARD_PORT. NemoclaW
 * curls `.../health` and treats 200|401 as `running`. NO secret — a stdlib python3 one-liner.
 */
const GATEWAY_COMMAND = `python3 -c "import http.server as h;h.HTTPServer(('127.0.0.1',${DASHBOARD_PORT}),type('H',(h.BaseHTTPRequestHandler,),{'do_GET':lambda s:(s.send_response(200),s.end_headers(),s.wfile.write(b'ok')),'log_message':lambda *a:None})).serve_forever()"`;

const mtls = join(homedir(), ".config/openshell/gateways/openshell/mtls");

function buildHost(): { host: NemoClawAgentHosting; adapter: OpenShellSandboxAdapter } {
  const transport = createOpenShellGrpcTransport({
    endpoint: "127.0.0.1:17670",
    caCertPath: join(mtls, "ca.crt"),
    clientCertPath: join(mtls, "tls.crt"),
    clientKeyPath: join(mtls, "tls.key"),
    deadlineMs: 15_000,
  });
  const adapter = new OpenShellSandboxAdapter(transport);
  // The sandbox was created out-of-band (the harness/CLI), so the adapter's `refById` (normally
  // populated by CreateSandbox — OS-S2) has no entry; exec would deny "unknown sandbox". Seed the
  // {name,id} ref a real CreateSandbox would have stored (test-only reflection). In production the
  // ExecutionSubstrate creates the sandbox via the adapter and this seam is unnecessary.
  (adapter as unknown as { refById: Map<string, { name: string; id: string }> }).refById.set(
    SANDBOX_ID,
    { name: SANDBOX_ID, id: SANDBOX_ID },
  );
  const sink = createOpenShellExecCommandSink({
    exec: createNemoClawOpenShellExec(adapter, CTX),
    sandboxId: SANDBOX_ID,
  });
  const host = new NemoClawAgentHosting(sink, { dashboardPort: DASHBOARD_PORT });
  return { host, adapter };
}

d("NC-S11b — NemoClaw hosting LIVE through OpenShell mTLS gRPC exec", () => {
  const { host, adapter } = buildHost();

  afterAll(async () => {
    // Kill the trivial gateway so re-runs are idempotent (the python server backgrounded by NemoClaw).
    try {
      await adapter.execSandbox(CTX, SANDBOX_ID, ["/bin/sh", "-c", "pkill -f http.server || true"]);
    } catch {
      // Best-effort cleanup; never fail the run on teardown.
    }
  });

  it("hosts a trivial gateway, sees it running, and reconciles a health-probe", async () => {
    const hosted = await host.hostAgent(CTX, {
      sandboxId: SANDBOX_ID,
      agentName: "probe",
      gatewayCommand: GATEWAY_COMMAND,
    });
    expect(hosted.status).toBe("ok");
    if (hosted.status !== "ok") return; // narrow for TS; the assert above already failed the test.
    expect(hosted.agentProcessId).toBeTruthy();

    const status = await host.getAgentStatus(CTX, SANDBOX_ID);
    expect(status.status).toBe("ok");
    if (status.status === "ok") expect(status.phase).toBe("running");

    const reconciled = await host.reconcileAgentProcess(CTX, SANDBOX_ID, "health-probe");
    expect(reconciled.status).toBe("ok");
  }, 60_000);
});
