import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenShellGrpcTransport } from "./index.js";

/**
 * OS-S1 GATED live test — proves the real mTLS gRPC ExecSandbox transport against a RUNNING OpenShell
 * gateway. SKIPPED unless `AGENTOS_LIVE_OPENSHELL=1` + `AGENTOS_LIVE_OPENSHELL_SANDBOX=<sandbox id>` are
 * set, so `pnpm run verify` stays hermetic. Run via the live harness, e.g.:
 *   AGENTOS_LIVE_OPENSHELL=1 AGENTOS_LIVE_OPENSHELL_SANDBOX=<id> vitest run src/runtime/openshell/grpc-transport.live.test.ts
 * The mTLS materials are read from the OpenShell CLI's local store (never inlined, never committed).
 */
const ON = process.env.AGENTOS_LIVE_OPENSHELL === "1";
const SANDBOX_ID = process.env.AGENTOS_LIVE_OPENSHELL_SANDBOX ?? "";
const d = ON && SANDBOX_ID ? describe : describe.skip;

const mtls = join(homedir(), ".config/openshell/gateways/openshell/mtls");
const transport = (deadlineMs: number) =>
  createOpenShellGrpcTransport({
    endpoint: "127.0.0.1:17670",
    caCertPath: join(mtls, "ca.crt"),
    clientCertPath: join(mtls, "tls.crt"),
    clientKeyPath: join(mtls, "tls.key"),
    deadlineMs,
  });

d("OS-S1 — mTLS gRPC ExecSandbox vs the real OpenShell gateway", () => {
  it("execs in the sandbox and streams stdout + a zero exit", async () => {
    const r = await transport(15_000).execSandbox(SANDBOX_ID, [
      "sh",
      "-c",
      "echo OS_S1_LIVE; whoami",
    ]);
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toContain("OS_S1_LIVE");
  }, 30_000);

  it("fail-closed: a command that runs past the deadline rejects (never fabricates success)", async () => {
    await expect(
      transport(1_500).execSandbox(SANDBOX_ID, ["sh", "-c", "sleep 30"]),
    ).rejects.toThrow();
  }, 30_000);
});
