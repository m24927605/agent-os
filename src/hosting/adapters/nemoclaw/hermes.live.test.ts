/**
 * SLICE-HERMES-S1 GATED live e2e — our `NemoClawAgentHosting` adapter governs the REAL Hermes gateway
 * inside a USER-PROVISIONED Hermes sandbox (created externally via `nemohermes onboard`).
 *
 * Proves a governance action flows end-to-end on ONE adapter instance against a REAL vendor agent:
 *   adapter.adoptSandbox(CTX, <user sandbox name>)  -> REAL GetSandbox; populates refById {name,id} ->
 *   NemoClawAgentHosting (bound to the SAME adapter via the S10 CommandSink + the /bin/sh -c exec) ->
 *   getAgentStatus -> phase "running" (the REAL onboarded Hermes gateway serves /health:18789=200) ->
 *   reconcileAgentProcess("health-probe") -> ok.
 * There is NO refById reflection seed anywhere — adopt is the production-real "use an existing sandbox"
 * entry, so exec/status resolve the {name,id} ref the REAL GetSandbox returned.
 *
 * CREDENTIAL-BLIND: the LLM key stays entirely on the user side (onboard writes it into the sandbox's
 * /sandbox/.hermes); nothing here reads or carries a secret. The mTLS materials are read from the
 * OpenShell CLI's local store (never inlined).
 *
 * SKIPPED unless `AGENTOS_LIVE_HERMES_SANDBOX` names the user's Hermes sandbox, so `pnpm run verify`
 * stays hermetic. Run via the live harness: `AGENTOS_LIVE_HERMES_SANDBOX=<name> pnpm run e2e:live-hermes`.
 *
 * It does NOT create or DELETE the sandbox — the sandbox is the USER's asset (managed by their
 * `nemohermes onboard`); we only adopt + observe + reconcile, and afterAll never destroys it.
 *
 * LAUNCH PATH (NOT exercised here): proving launch would stop the user's REAL Hermes gateway and
 * relaunch it via the real `gatewayCommand`. That command shape (`nemoclaw-start`, or
 * `"$AGENT_BIN" dashboard --port 18789` with AGENT_BIN=/usr/local/bin/hermes) will be observed +
 * wired by the main loop LIVE against the user's sandbox — see the slice spec §3. We deliberately do
 * NOT relaunch the user's gateway in this slice (observe-only against the user's asset).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CommandSink,
  NemoClawAgentHosting,
} from "../../../hosting/adapters/nemoclaw/index.js";
import {
  createNemoClawOpenShellExec,
  createOpenShellExecCommandSink,
} from "../../../runtime/nemoclaw/index.js";
import {
  OpenShellSandboxAdapter,
  createOpenShellGrpcTransport,
} from "../../../runtime/openshell/index.js";

/** Gate: the NAME of the user's Hermes sandbox (created externally by `nemohermes onboard`). */
const HERMES_SANDBOX = process.env.AGENTOS_LIVE_HERMES_SANDBOX;
const d = HERMES_SANDBOX !== undefined && HERMES_SANDBOX.length > 0 ? describe : describe.skip;

/** The dashboard port the REAL Hermes gateway serves /health on (matches NemoClawAgentHosting opts). */
const DASHBOARD_PORT = 18789;

/** A well-formed AgentContext for the live governance action. */
const CTX = {
  actorId: "agent:live-hermes-probe",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live",
  requestId: "req-live-hermes-1",
};

const mtls = join(homedir(), ".config/openshell/gateways/openshell/mtls");

d(
  "HERMES-S1 — NemoClaw hosting GOVERNS the REAL Hermes gateway in a user-provisioned sandbox (adopt-only)",
  () => {
    it("adopts the user's Hermes sandbox, sees the gateway running, and reconciles a health-probe", async () => {
      const sandboxName = HERMES_SANDBOX;
      expect(sandboxName).toBeDefined();
      if (sandboxName === undefined) return; // narrow for TS; the gate already skips when unset.

      // The REAL mTLS gRPC transport (create/get/delete/watch/exec) against the running gateway.
      const transport = createOpenShellGrpcTransport({
        endpoint: "127.0.0.1:17670",
        caCertPath: join(mtls, "ca.crt"),
        clientCertPath: join(mtls, "tls.crt"),
        clientKeyPath: join(mtls, "tls.key"),
        deadlineMs: 15_000,
      });
      const adapter = new OpenShellSandboxAdapter(transport);

      // (1) ADOPT the EXTERNALLY-created sandbox — REAL GetSandbox(name) populates the {name,id} ref.
      // NO reflection seed: exec/status below resolve the ref this adopt returns.
      const adopted = await adapter.adoptSandbox(CTX, sandboxName);
      expect(adopted.status).toBe("ok");
      if (adopted.status !== "ok") return; // narrow for TS; the assert above already failed the test.
      expect(adopted.sandboxId).toBeTruthy();
      const sandboxId = adopted.sandboxId;

      // (2) Build the NemoClaw host on the SAME adapter (bound exec + the /bin/sh -c wrap), scoped to
      // the adopted sandboxId. The probe targets the REAL Hermes gateway's /health:18789.
      const sink: CommandSink = createOpenShellExecCommandSink({
        exec: createNemoClawOpenShellExec(adapter, CTX),
        sandboxId,
      });
      const host = new NemoClawAgentHosting(sink, { dashboardPort: DASHBOARD_PORT });

      // (3) getAgentStatus -> the REAL onboarded Hermes gateway serves /health:18789=200 => running.
      const status = await host.getAgentStatus(CTX, sandboxId);
      expect(status.status).toBe("ok");
      if (status.status === "ok") expect(status.phase).toBe("running");

      // (4) reconcile a health-probe (NOT a restart — observe-only; never relaunch the user's gateway).
      const reconciled = await host.reconcileAgentProcess(CTX, sandboxId, "health-probe");
      expect(reconciled.status).toBe("ok");
    }, 60_000);
  },
);
