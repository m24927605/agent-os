import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenShellSandboxAdapter, createOpenShellGrpcTransport } from "./index.js";

/**
 * OS-S2a GATED live test — the CONVERGED mTLS gRPC transport vs a RUNNING OpenShell gateway, now driving
 * the FULL lifecycle on ONE adapter: createSandbox (REAL CreateSandbox; populates refById) -> awaitReady
 * (getSandbox polling to READY) -> execSandbox (the adapter's accumulator consumes the real server-
 * stream) -> destroySandbox (DeleteSandbox). NO refById reflection seed — the create path is real now.
 *
 * SKIPPED unless `AGENTOS_LIVE_OPENSHELL=1` (it self-creates, so no AGENTOS_LIVE_OPENSHELL_SANDBOX is
 * needed), so `pnpm run verify` stays hermetic. Run via the live harness:
 *   AGENTOS_LIVE_OPENSHELL=1 pnpm run e2e:live-nemoclaw
 * The mTLS materials are read from the OpenShell CLI's local store (never inlined, never committed).
 */
const ON = process.env.AGENTOS_LIVE_OPENSHELL === "1";
const d = ON ? describe : describe.skip;

const CTX = {
  actorId: "agent:os-s2a-live",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live",
  requestId: "req-live-1",
};

/** The empirically-confirmed openclaw boot image (pinned @sha256 digest; passes assertPinnedImageDigest). */
const SANDBOX_IMAGE =
  "ghcr.io/nvidia/openshell-community/sandboxes/openclaw@sha256:c116946b3f9e84791630f21f115ac35c9c9f669af70ec0eef3035d79833a9550";

const mtls = join(homedir(), ".config/openshell/gateways/openshell/mtls");

d(
  "OS-S2a — mTLS gRPC lifecycle vs the real OpenShell gateway (create -> ready -> exec -> delete)",
  () => {
    let adapter: OpenShellSandboxAdapter;
    let sandboxId: string;

    beforeAll(async () => {
      const transport = createOpenShellGrpcTransport({
        endpoint: "127.0.0.1:17670",
        caCertPath: join(mtls, "ca.crt"),
        clientCertPath: join(mtls, "tls.crt"),
        clientKeyPath: join(mtls, "tls.key"),
        deadlineMs: 15_000,
      });
      adapter = new OpenShellSandboxAdapter(transport);
      // REAL CreateSandbox — no seed. The response populates refById; exec/delete resolve it.
      const created = await adapter.createSandbox(CTX, { image: SANDBOX_IMAGE });
      expect(created.status).toBe("ok");
      if (created.status !== "ok") throw new Error(`create denied: ${created.reason}`);
      sandboxId = created.sandboxId;
      // Poll readiness to READY via the adapter's getSandbox path (bounded; fail-closed on timeout).
      const deadline = Date.now() + 120_000;
      for (;;) {
        const verdict = await adapter.awaitReady(CTX, sandboxId, { deadlineMs: 2_000 });
        if (verdict.status === "ok") break;
        if (Date.now() >= deadline) throw new Error("sandbox did not reach READY (fail-closed)");
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }, 180_000);

    afterAll(async () => {
      if (sandboxId !== undefined) await adapter.destroySandbox(CTX, sandboxId).catch(() => {});
    }, 60_000);

    it("execs in the sandbox and converges stdout + a zero exit into an ok ExecOutcome", async () => {
      const r = await adapter.execSandbox(
        CTX,
        sandboxId,
        ["/bin/sh", "-c", "echo OS_S2A_LIVE; whoami"],
        {
          deadlineMs: 15_000,
        },
      );
      expect(r.status).toBe("ok");
      if (r.status === "ok") {
        expect(r.result.exitCode).toBe(0);
        expect(new TextDecoder().decode(r.result.stdout)).toContain("OS_S2A_LIVE");
      }
    }, 30_000);

    it("fail-closed: a command that runs past the deadline DENIES (never fabricates success)", async () => {
      const r = await adapter.execSandbox(CTX, sandboxId, ["/bin/sh", "-c", "sleep 30"], {
        deadlineMs: 1_500,
      });
      expect(r.status).toBe("denied");
    }, 30_000);
  },
);
