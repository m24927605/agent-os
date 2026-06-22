/**
 * OS-S2a GATED live e2e — the FULL NemoClaw hosting path through the PRODUCTION composition root
 * against a RUNNING OpenShell gateway. SELF-CREATES + self-deletes its sandbox via the adapter.
 *
 * Proves a governance action flows end-to-end on ONE adapter instance:
 *   createNemoClawOnOpenShell -> adapter.createSandbox (REAL CreateSandbox; populates refById) ->
 *   wait READY (getSandbox polling) -> NemoClawAgentHosting -> S10 CommandSink -> the mTLS gRPC exec
 *   transport -> a real OpenShell sandbox -> reconcile -> dispose (DeleteSandbox).
 * There is NO refById reflection seed anywhere (this closes NC-S11b's same-instance tracking).
 *
 * NO LLM key is required: the "gateway" is a one-line python3 HTTP server on the dashboard port that
 * returns 200 on any path (so the NemoClaw `curl .../health` probe sees `running`).
 *
 * SKIPPED unless `AGENTOS_LIVE_OPENSHELL=1` (it self-creates, so AGENTOS_LIVE_OPENSHELL_SANDBOX is no
 * longer needed), so `pnpm run verify` stays hermetic. Run via the live harness: `pnpm run
 * e2e:live-nemoclaw`. The mTLS materials are read from the OpenShell CLI's local store (never inlined).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNemoClawOnOpenShell } from "../../../runtime/nemoclaw/index.js";
import {
  OpenShellSandboxAdapter,
  createOpenShellGrpcTransport,
} from "../../../runtime/openshell/index.js";

const ON = process.env.AGENTOS_LIVE_OPENSHELL === "1";
const d = ON ? describe : describe.skip;

/** The dashboard port the trivial gateway serves /health on (matches NemoClawAgentHosting opts). */
const DASHBOARD_PORT = 18789;

/**
 * The empirically-confirmed openclaw boot image — a pinned `@sha256:` digest that passes
 * `assertPinnedImageDigest`. A minimal CreateSandbox `{spec:{template:{image}}}` (no policy) succeeds
 * against the running gateway and the sandbox reaches READY.
 */
const SANDBOX_IMAGE =
  "ghcr.io/nvidia/openshell-community/sandboxes/openclaw@sha256:c116946b3f9e84791630f21f115ac35c9c9f669af70ec0eef3035d79833a9550";

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

d(
  "OS-S2a — NemoClaw hosting LIVE through the production composition root (self-create/delete)",
  () => {
    let wired: Awaited<ReturnType<typeof createNemoClawOnOpenShell>> | undefined;
    let adapter: OpenShellSandboxAdapter;

    beforeAll(async () => {
      const transport = createOpenShellGrpcTransport({
        endpoint: "127.0.0.1:17670",
        caCertPath: join(mtls, "ca.crt"),
        clientCertPath: join(mtls, "tls.crt"),
        clientKeyPath: join(mtls, "tls.key"),
        deadlineMs: 15_000,
      });
      adapter = new OpenShellSandboxAdapter(transport);
      // NO refById seed: the composition root creates the sandbox via the SAME adapter, so the real
      // CreateSandbox response populates the {name,id} ref — exec/dispose resolve it with no reflection.
      wired = await createNemoClawOnOpenShell({
        adapter,
        ctx: CTX,
        sandboxImage: SANDBOX_IMAGE,
        dashboardPort: DASHBOARD_PORT,
        readinessTimeoutMs: 120_000,
        readinessIntervalMs: 2_000,
      });
    }, 180_000);

    afterAll(async () => {
      if (wired === undefined) return;
      // Kill the trivial gateway (best-effort) then delete the sandbox we created (via the adapter).
      try {
        await adapter.execSandbox(CTX, wired.sandboxId, [
          "/bin/sh",
          "-c",
          "pkill -f http.server || true",
        ]);
      } catch {
        // Best-effort cleanup; never fail the run on teardown.
      }
      await wired.dispose().catch(() => {});
    }, 60_000);

    it("hosts a trivial gateway, sees it running, and reconciles a health-probe", async () => {
      expect(wired).toBeDefined();
      if (wired === undefined) return;
      const { host, sandboxId } = wired;

      const hosted = await host.hostAgent(CTX, {
        sandboxId,
        agentName: "probe",
        gatewayCommand: GATEWAY_COMMAND,
      });
      expect(hosted.status).toBe("ok");
      if (hosted.status !== "ok") return; // narrow for TS; the assert above already failed the test.
      expect(hosted.agentProcessId).toBeTruthy();

      const status = await host.getAgentStatus(CTX, sandboxId);
      expect(status.status).toBe("ok");
      if (status.status === "ok") expect(status.phase).toBe("running");

      const reconciled = await host.reconcileAgentProcess(CTX, sandboxId, "health-probe");
      expect(reconciled.status).toBe("ok");
    }, 60_000);
  },
);
