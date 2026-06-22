import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenShellSandboxAdapter, createOpenShellGrpcTransport } from "./index.js";

/**
 * OS-S1 GATED live test — proves the CONVERGED mTLS gRPC ExecSandbox transport against a RUNNING
 * OpenShell gateway, driving the FULL path now (NC-S11b §A收斂): the grpc transport implements the
 * adapter's seam, so the adapter's SINGLE accumulator (`streamExec`) consumes the real server-stream
 * and converges it into an `ExecOutcome`. The transport is no longer driven directly.
 *
 * SKIPPED unless `AGENTOS_LIVE_OPENSHELL=1` + `AGENTOS_LIVE_OPENSHELL_SANDBOX=<sandbox id>` are set, so
 * `pnpm run verify` stays hermetic. Run via the live harness, e.g.:
 *   AGENTOS_LIVE_OPENSHELL=1 AGENTOS_LIVE_OPENSHELL_SANDBOX=<id> vitest run src/runtime/openshell/grpc-transport.live.test.ts
 * The mTLS materials are read from the OpenShell CLI's local store (never inlined, never committed).
 */
const ON = process.env.AGENTOS_LIVE_OPENSHELL === "1";
const SANDBOX_ID = process.env.AGENTOS_LIVE_OPENSHELL_SANDBOX ?? "";
const d = ON && SANDBOX_ID ? describe : describe.skip;

const CTX = {
  actorId: "agent:os-s1-live",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live",
  requestId: "req-live-1",
};

const mtls = join(homedir(), ".config/openshell/gateways/openshell/mtls");

/**
 * Build an adapter over the converged grpc transport, then create the in-adapter mapping for the live
 * sandbox id so `execSandbox(ctx, mappedId, …)` reaches the real gateway. The adapter keys exec on its
 * own branded SandboxId -> the gateway's stable `id`; we wire that ref directly to the live sandbox id.
 */
function adapterFor(deadlineMs: number): {
  adapter: OpenShellSandboxAdapter;
  exec: (cmd: readonly string[]) => ReturnType<OpenShellSandboxAdapter["execSandbox"]>;
} {
  const transport = createOpenShellGrpcTransport({
    endpoint: "127.0.0.1:17670",
    caCertPath: join(mtls, "ca.crt"),
    clientCertPath: join(mtls, "tls.crt"),
    clientKeyPath: join(mtls, "tls.key"),
    deadlineMs,
  });
  const adapter = new OpenShellSandboxAdapter(transport);
  // Register the live sandbox id into the adapter's private mapping (test-only reflection: the
  // create path is OS-S2, so we seed the {name,id} ref a real CreateSandbox would have stored).
  const id = `sbx-os-live-${SANDBOX_ID}`;
  (adapter as unknown as { refById: Map<string, { name: string; id: string }> }).refById.set(id, {
    name: SANDBOX_ID,
    id: SANDBOX_ID,
  });
  return {
    adapter,
    exec: (cmd) => adapter.execSandbox(CTX, id, cmd, { deadlineMs }),
  };
}

d(
  "OS-S1 — mTLS gRPC ExecSandbox vs the real OpenShell gateway (via the adapter accumulator)",
  () => {
    it("execs in the sandbox and converges stdout + a zero exit into an ok ExecOutcome", async () => {
      const { exec } = adapterFor(15_000);
      const r = await exec(["/bin/sh", "-c", "echo OS_S1_LIVE; whoami"]);
      expect(r.status).toBe("ok");
      if (r.status === "ok") {
        expect(r.result.exitCode).toBe(0);
        expect(new TextDecoder().decode(r.result.stdout)).toContain("OS_S1_LIVE");
      }
    }, 30_000);

    it("fail-closed: a command that runs past the deadline DENIES (never fabricates success)", async () => {
      const { exec } = adapterFor(1_500);
      const r = await exec(["/bin/sh", "-c", "sleep 30"]);
      expect(r.status).toBe("denied");
    }, 30_000);
  },
);
