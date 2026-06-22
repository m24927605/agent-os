/**
 * Unit tests for the OS-S2a production composition root `createNemoClawOnOpenShell` (no live gateway).
 *
 * This is the slice's CORE claim: the SAME `OpenShellSandboxAdapter` instance creates the sandbox (so
 * its `refById` is populated by the REAL CreateSandbox response), polls readiness to READY via
 * getSandbox, then hosts the NemoClaw agent through `createNemoClawOpenShellExec` + the S10 CommandSink
 * — all WITHOUT any test reflection seed of `refById`. NC-S11b's same-instance tracking is closed.
 *
 * Every test injects a FAKE `OpenShellReadinessTransport` (no socket, no codec, no mTLS). The adapter
 * is the REAL `OpenShellSandboxAdapter` — so a create that fails to populate `refById` would surface as
 * an exec "unknown sandbox" deny (the mutation the adversarial review demands stays red).
 */
import { describe, expect, it, vi } from "vitest";
import type {
  CreateSandboxRequest,
  DeleteSandboxRequest,
  DeleteSandboxResponse,
  GetSandboxRequest,
  OpenShellReadinessTransport,
  SandboxResponse,
  SandboxStreamEvent,
  WatchSandboxRequest,
} from "../openshell/index.js";
import { OpenShellSandboxAdapter } from "../openshell/index.js";
import { createNemoClawOnOpenShell } from "./openshell-host.js";

const CTX = {
  actorId: "agent:host",
  tenantId: "tenant-1",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

const DIGEST = "sha256:c116946b3f9e84791630f21f115ac35c9c9f669af70ec0eef3035d79833a9550";

/** Phases this fake replays to getSandbox, one per call (last value repeats once exhausted). */
interface FakeOpts {
  /** Sequence of phases GetSandbox returns (1=PROVISIONING, 2=READY, 3=ERROR). */
  phases: number[];
  /** When set, createSandbox returns this response (override the default ok). */
  createResponse?: SandboxResponse;
  /** When true, createSandbox rejects (transport refused). */
  createRejects?: boolean;
}

interface FakeTransport extends OpenShellReadinessTransport {
  createCalls: CreateSandboxRequest[];
  getCalls: GetSandboxRequest[];
  deleteCalls: DeleteSandboxRequest[];
}

function fakeTransport(opts: FakeOpts): FakeTransport {
  let phaseIdx = 0;
  const createCalls: CreateSandboxRequest[] = [];
  const getCalls: GetSandboxRequest[] = [];
  const deleteCalls: DeleteSandboxRequest[] = [];

  const transport: FakeTransport = {
    createCalls,
    getCalls,
    deleteCalls,
    health: () => Promise.resolve({ ok: true }),
    createSandbox(req: CreateSandboxRequest): Promise<SandboxResponse> {
      createCalls.push(req);
      if (opts.createRejects === true) return Promise.reject(new Error("UNAVAILABLE"));
      return Promise.resolve(
        opts.createResponse ?? {
          sandbox: { metadata: { name: "sbx-name", id: "sbx-gw-id" }, status: { phase: 1 } },
        },
      );
    },
    getSandbox(req: GetSandboxRequest): Promise<SandboxResponse> {
      getCalls.push(req);
      const phase = opts.phases[Math.min(phaseIdx, opts.phases.length - 1)] ?? 1;
      phaseIdx += 1;
      return Promise.resolve({
        sandbox: { metadata: { name: "sbx-name", id: "sbx-gw-id" }, status: { phase } },
      });
    },
    deleteSandbox(req: DeleteSandboxRequest): Promise<DeleteSandboxResponse> {
      deleteCalls.push(req);
      return Promise.resolve({ deleted: true });
    },
    // This fake's watch ALWAYS fail-closed throws: these composition-root tests reach READY via the
    // getSandbox fast-path (phases include READY=2), so readiness must NOT depend on the watch stream.
    // A throwing watch proves the host wires readiness correctly even when WatchSandbox is unavailable
    // (the real OS-S2b watch stream itself is covered in grpc-transport.watch.test.ts).
    // biome-ignore lint/correctness/useYield: this fail-closed double never yields.
    async *watchSandbox(_req: WatchSandboxRequest): AsyncIterable<SandboxStreamEvent> {
      throw new Error("watch unavailable in this composition-root test (fail-closed)");
    },
  };
  return transport;
}

describe("createNemoClawOnOpenShell — create populates refById on the SAME adapter (no seed)", () => {
  it("creates the sandbox, reaches READY, and returns a host bound to the created sandbox id", async () => {
    const transport = fakeTransport({ phases: [1, 2] }); // PROVISIONING then READY
    const adapter = new OpenShellSandboxAdapter(transport);

    const { host, sandboxId } = await createNemoClawOnOpenShell({
      adapter,
      ctx: CTX,
      sandboxImage: DIGEST,
      readinessTimeoutMs: 5_000,
      readinessIntervalMs: 1,
    });

    // create was issued with the pinned digest as spec.template.image, no test seed touched refById.
    expect(transport.createCalls).toHaveLength(1);
    expect(transport.createCalls[0]?.spec.template.image).toBe(DIGEST);
    // The returned sandboxId is the adapter's branded id (sbx-os-…), NOT the raw gateway name/id.
    expect(sandboxId).toMatch(/^sbx-os-/);
    expect(host).toBeDefined();
    // readiness polled getSandbox until READY (>=1 call) keyed by the canonical name.
    expect(transport.getCalls.length).toBeGreaterThanOrEqual(1);
    expect(transport.getCalls[0]?.name).toBe("sbx-name");
  });

  it("the SAME-adapter exec resolves the created sandbox WITHOUT any reflection seed", async () => {
    const transport = fakeTransport({ phases: [2] }); // READY immediately
    const adapter = new OpenShellSandboxAdapter(transport);

    const { sandboxId } = await createNemoClawOnOpenShell({
      adapter,
      ctx: CTX,
      sandboxImage: DIGEST,
      readinessTimeoutMs: 5_000,
      readinessIntervalMs: 1,
    });

    // The adapter's exec keys on its own refById, which CreateSandbox populated — so exec does NOT
    // deny "unknown sandbox". We stub execSandbox on the transport to assert it is reached with the
    // mapped gateway id (sbx-gw-id), proving the create populated the {name,id} ref.
    let execReachedWithId: string | undefined;
    (transport as unknown as { execSandbox: unknown }).execSandbox = (req: {
      sandboxId: string;
    }) => {
      execReachedWithId = req.sandboxId;
      // Yield a terminal exit(0) so the adapter converges ok.
      return (async function* () {
        yield { exit: { exitCode: 0 } };
      })();
    };

    const outcome = await adapter.execSandbox(CTX, sandboxId, ["/bin/sh", "-c", "true"], {
      deadlineMs: 5_000,
    });
    expect(outcome.status).toBe("ok");
    expect(execReachedWithId).toBe("sbx-gw-id");
  });
});

describe("createNemoClawOnOpenShell — readiness is fail-closed", () => {
  it("times out (deny) when the sandbox never reaches READY, never proceeds on PROVISIONING", async () => {
    const transport = fakeTransport({ phases: [1] }); // stuck PROVISIONING forever
    const adapter = new OpenShellSandboxAdapter(transport);

    await expect(
      createNemoClawOnOpenShell({
        adapter,
        ctx: CTX,
        sandboxImage: DIGEST,
        readinessTimeoutMs: 30,
        readinessIntervalMs: 5,
      }),
    ).rejects.toThrow(/ready|fail-closed/i);
  });

  it("rejects on an ERROR phase (terminal, never ready)", async () => {
    const transport = fakeTransport({ phases: [3] }); // ERROR — never reaches READY => fail-closed
    const adapter = new OpenShellSandboxAdapter(transport);

    await expect(
      createNemoClawOnOpenShell({
        adapter,
        ctx: CTX,
        sandboxImage: DIGEST,
        readinessTimeoutMs: 30,
        readinessIntervalMs: 5,
      }),
    ).rejects.toThrow();
  });

  it("rejects when CreateSandbox is denied (transport refused) — no host is built", async () => {
    const transport = fakeTransport({ phases: [2], createRejects: true });
    const adapter = new OpenShellSandboxAdapter(transport);

    await expect(
      createNemoClawOnOpenShell({ adapter, ctx: CTX, sandboxImage: DIGEST }),
    ).rejects.toThrow();
    // No readiness poll happens once create was denied.
    expect(transport.getCalls).toHaveLength(0);
  });

  it("rejects when the image is not a pinned sha256 digest (adapter denies create)", async () => {
    const transport = fakeTransport({ phases: [2] });
    const adapter = new OpenShellSandboxAdapter(transport);

    await expect(
      createNemoClawOnOpenShell({ adapter, ctx: CTX, sandboxImage: "ghcr.io/x/y:latest" }),
    ).rejects.toThrow();
  });
});

describe("createNemoClawOnOpenShell — dispose deletes via the SAME adapter", () => {
  it("dispose() calls deleteSandbox keyed by the created sandbox name", async () => {
    const transport = fakeTransport({ phases: [2] });
    const adapter = new OpenShellSandboxAdapter(transport);

    const { dispose } = await createNemoClawOnOpenShell({
      adapter,
      ctx: CTX,
      sandboxImage: DIGEST,
      readinessTimeoutMs: 5_000,
      readinessIntervalMs: 1,
    });

    const result = await dispose();
    expect(result.status).toBe("ok");
    expect(transport.deleteCalls).toHaveLength(1);
    expect(transport.deleteCalls[0]?.name).toBe("sbx-name");
  });
});

describe("createNemoClawOnOpenShell — dashboardPort threads to the host", () => {
  it("forwards dashboardPort to NemoClawAgentHosting (the probe targets the right port)", async () => {
    const transport = fakeTransport({ phases: [2] });
    const adapter = new OpenShellSandboxAdapter(transport);
    // Spy on execSandbox to capture the probe command (the host probes the dashboard port).
    const exec = vi.fn((req: { command: readonly string[] }) =>
      (async function* () {
        // The launch command echoes a GATEWAY_PID; reply with that on stdout then exit 0.
        yield { stdout: { data: new TextEncoder().encode("GATEWAY_PID=4242\n") } };
        yield { exit: { exitCode: 0 } };
      })(),
    );
    (transport as unknown as { execSandbox: unknown }).execSandbox = exec;

    const { host, sandboxId } = await createNemoClawOnOpenShell({
      adapter,
      ctx: CTX,
      sandboxImage: DIGEST,
      dashboardPort: 19999,
      readinessTimeoutMs: 5_000,
      readinessIntervalMs: 1,
    });

    // Host the agent (registers it), then getAgentStatus issues the health PROBE, which targets the
    // injected dashboard port. Both go through the SAME-adapter exec (no seed).
    const hosted = await host.hostAgent(CTX, {
      sandboxId,
      agentName: "probe",
      gatewayCommand: "sleep 1",
    });
    expect(hosted.status).toBe("ok");
    await host.getAgentStatus(CTX, sandboxId);
    const probed = exec.mock.calls.map((c) => c[0].command.join(" ")).join("\n");
    expect(probed).toContain("19999"); // dashboardPort wired through to the host's probe
  });
});
