/**
 * RED-first tests for SLICE-P2R-R1-S2 — createSandbox (+ destroySandbox via DeleteSandbox) +
 * name <-> SandboxId mapping.
 *
 * These assert the behaviours + security invariants of §5 of the slice spec
 * (docs/slices/phase-2-remaining/P2R-R1-S2-create-destroy-sandbox-id-mapping.md) BEFORE any
 * implementation exists. They MUST be SEEN to fail first (./adapter.js does not resolve).
 *
 * No live OpenShell server exists in this environment (design §7.4): every test drives the adapter
 * through an INJECTED transport double that mimics the S1 `OpenShellTransport` seam extended with the
 * S2 `createSandbox`/`deleteSandbox` unary primitives. The load-bearing security probe: a bad ctx, a
 * non-pinned image, an unknown id, OR a transport rejection ALL fail CLOSED (deny), the adapter NEVER
 * throws across the port boundary, and a denied reason NEVER leaks baseUrl / credential detail.
 */
import { describe, expect, it, vi } from "vitest";
import { OpenShellSandboxAdapter } from "./adapter.js";
import { PINNED_SANDBOX_IMAGE } from "./client.js";
import type {
  CreateSandboxRequest,
  DeleteSandboxRequest,
  DeleteSandboxResponse,
  OpenShellLifecycleTransport,
  SandboxResponse,
} from "./client.js";

/** A well-formed AgentContext (mirrors the iam/ids AgentContext schema). */
const GOOD_CTX = {
  actorId: "actor-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  taskId: "task-1",
  requestId: "request-1",
};

/** A transport double that records calls and resolves caller-supplied responses. */
function recordingTransport(opts: {
  createResponse?: SandboxResponse;
  createReject?: Error;
  deleteResponse?: DeleteSandboxResponse;
  deleteReject?: Error;
}): OpenShellLifecycleTransport & {
  createCalls: CreateSandboxRequest[];
  deleteCalls: DeleteSandboxRequest[];
} {
  const createCalls: CreateSandboxRequest[] = [];
  const deleteCalls: DeleteSandboxRequest[] = [];
  return {
    createCalls,
    deleteCalls,
    health: () => Promise.resolve({ ok: true }),
    createSandbox(req: CreateSandboxRequest): Promise<SandboxResponse> {
      createCalls.push(req);
      if (opts.createReject !== undefined) return Promise.reject(opts.createReject);
      return Promise.resolve(
        opts.createResponse ?? { sandbox: { metadata: { name: "os-sbx-1" } } },
      );
    },
    deleteSandbox(req: DeleteSandboxRequest): Promise<DeleteSandboxResponse> {
      deleteCalls.push(req);
      if (opts.deleteReject !== undefined) return Promise.reject(opts.deleteReject);
      return Promise.resolve(opts.deleteResponse ?? { deleted: true });
    },
  };
}

describe("OpenShellSandboxAdapter.createSandbox", () => {
  it("denies (fail-closed) a bad AgentContext and does NOT call CreateSandbox", async () => {
    const t = recordingTransport({});
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.createSandbox({ not: "a context" }, { image: PINNED_SANDBOX_IMAGE });

    expect(res.status).toBe("denied");
    expect(res.event.result).toBe("denied");
    expect(res.event.contextError).toBeDefined();
    expect(t.createCalls).toHaveLength(0);
  });

  it("denies a non-pinned (non sha256 digest) image and does NOT call CreateSandbox", async () => {
    const t = recordingTransport({});
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.createSandbox(GOOD_CTX, { image: "alpine:latest" });

    expect(res.status).toBe("denied");
    expect(t.createCalls).toHaveLength(0);
  });

  it("creates a sandbox with the PINNED image and returns a schema-valid SandboxId (ok)", async () => {
    const t = recordingTransport({
      createResponse: { sandbox: { metadata: { name: "os-sbx-42" } } },
    });
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.createSandbox(GOOD_CTX, { image: PINNED_SANDBOX_IMAGE });

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(typeof res.sandboxId).toBe("string");
    expect(res.sandboxId.length).toBeGreaterThan(0);
    expect(res.event.result).toBe("ok");
    // The pinned digest is sent to OpenShell at spec.template.image.
    expect(t.createCalls).toHaveLength(1);
    expect(t.createCalls[0]?.spec?.template?.image).toBe(PINNED_SANDBOX_IMAGE);
  });

  it("uses the spec image when it is itself a pinned digest, never a caller floating tag", async () => {
    const t = recordingTransport({});
    const adapter = new OpenShellSandboxAdapter(t);

    // An undefined spec.image must still create with the pinned default (deny-by-default never
    // produces a floating tag on the wire).
    const res = await adapter.createSandbox(GOOD_CTX, {});

    expect(res.status).toBe("ok");
    expect(t.createCalls[0]?.spec?.template?.image).toBe(PINNED_SANDBOX_IMAGE);
  });

  it("denies (fail-closed, does NOT throw) when CreateSandbox rejects, leaking no baseUrl", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = "https://super-secret-gateway.internal:8443";
    const t = recordingTransport({ createReject: new Error(`connect ECONNREFUSED ${secret}`) });
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.createSandbox(GOOD_CTX, { image: PINNED_SANDBOX_IMAGE });

    expect(res.status).toBe("denied");
    if (res.status !== "denied") throw new Error("unreachable");
    expect(res.reason).not.toContain(secret);
    expect(JSON.stringify(res.event)).not.toContain(secret);
    for (const spy of [errSpy, logSpy, warnSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(secret);
      }
    }
    errSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("denies an empty/malformed SandboxResponse (no metadata.name) and does not retain a mapping", async () => {
    const t = recordingTransport({ createResponse: { sandbox: {} } as SandboxResponse });
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.createSandbox(GOOD_CTX, { image: PINNED_SANDBOX_IMAGE });

    expect(res.status).toBe("denied");
  });
});

describe("OpenShellSandboxAdapter.destroySandbox", () => {
  it("denies a bad AgentContext and does NOT call DeleteSandbox", async () => {
    const t = recordingTransport({});
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.destroySandbox({ bad: true }, "sbx-anything");

    expect(res.status).toBe("denied");
    expect(t.deleteCalls).toHaveLength(0);
  });

  it("denies an unknown id (no mapping) and does NOT call DeleteSandbox (deny-by-default)", async () => {
    const t = recordingTransport({});
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.destroySandbox(GOOD_CTX, "sbx-never-created");

    expect(res.status).toBe("denied");
    expect(t.deleteCalls).toHaveLength(0);
  });

  it("destroys a previously-created sandbox using the mapped OpenShell name, then drops the mapping", async () => {
    const t = recordingTransport({
      createResponse: { sandbox: { metadata: { name: "os-sbx-99" } } },
    });
    const adapter = new OpenShellSandboxAdapter(t);

    const created = await adapter.createSandbox(GOOD_CTX, { image: PINNED_SANDBOX_IMAGE });
    expect(created.status).toBe("ok");
    if (created.status !== "ok") throw new Error("unreachable");
    const id = created.sandboxId;

    const destroyed = await adapter.destroySandbox(GOOD_CTX, id);
    expect(destroyed.status).toBe("ok");
    expect(t.deleteCalls).toHaveLength(1);
    expect(t.deleteCalls[0]?.name).toBe("os-sbx-99");

    // Mapping removed: a second destroy of the same id denies and issues no further RPC.
    const again = await adapter.destroySandbox(GOOD_CTX, id);
    expect(again.status).toBe("denied");
    expect(t.deleteCalls).toHaveLength(1);
  });

  it("denies (fail-closed, does NOT throw) when DeleteSandbox rejects and KEEPS the mapping", async () => {
    const t = recordingTransport({
      createResponse: { sandbox: { metadata: { name: "os-sbx-7" } } },
      deleteReject: new Error("DEADLINE_EXCEEDED"),
    });
    const adapter = new OpenShellSandboxAdapter(t);

    const created = await adapter.createSandbox(GOOD_CTX, { image: PINNED_SANDBOX_IMAGE });
    if (created.status !== "ok") throw new Error("unreachable");

    const res = await adapter.destroySandbox(GOOD_CTX, created.sandboxId);
    expect(res.status).toBe("denied");
    // The mapping is NOT dropped on a failed delete (so a forward-fix retry can find the name).
    expect(t.deleteCalls).toHaveLength(1);
  });
});
