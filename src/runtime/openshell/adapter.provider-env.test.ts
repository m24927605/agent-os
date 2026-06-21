/**
 * RED-first tests for SLICE-P2R-R1-S5 — OpenShellSandboxAdapter.getProviderEnvironment.
 *
 * These assert §5 of the slice spec
 * (docs/slices/phase-2-remaining/P2R-R1-S5-provider-env-placeholder-fail-closed.md) BEFORE the
 * adapter method exists. They MUST be SEEN to fail first (no `getProviderEnvironment` on the adapter,
 * no `getSandboxProviderEnvironment` on the transport seam).
 *
 * No live OpenShell server exists in this environment (design §7.4): every test drives the adapter
 * through an INJECTED transport double extending the S2 lifecycle seam with the S5
 * `getSandboxProviderEnvironment` unary primitive (openshell.proto:153; response at proto:1141-1152).
 *
 * Credential non-leak invariant (load-bearing security probe): when the gateway returns a raw-secret
 * value in `environment`, the placeholder-only shape guard throws and the adapter DENIES, returning an
 * object that carries NO env at all — the raw value must never appear in the result, the event, or any
 * RPC echo. The raw-secret canary is ASSEMBLED AT RUNTIME (no source literal) so secret-scan stays
 * clean. The adapter NEVER throws across the port boundary; a denied reason NEVER leaks
 * baseUrl/endpoint/credential.
 */
import { describe, expect, it } from "vitest";
import { OpenShellSandboxAdapter } from "./adapter.js";
import { PINNED_SANDBOX_IMAGE } from "./client.js";
import type {
  GetSandboxProviderEnvironmentRequest,
  GetSandboxProviderEnvironmentResponse,
  OpenShellProviderEnvTransport,
} from "./client.js";

const GOOD_CTX = {
  actorId: "actor-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  taskId: "task-1",
  requestId: "request-1",
};

const OS_NAME = "os-sbx-penv";
const OS_ID = "sbxid-penv-stable-gateway-id";

/** Build a raw-secret-shaped canary at runtime (NEVER a source literal) — see provider-env.test.ts. */
function rawSecretCanary(): string {
  return ["sk", "live", "x".repeat(24)].join("-");
}

interface ProviderEnvDoubleOpts {
  /** Response returned by `getSandboxProviderEnvironment`. */
  resp?: GetSandboxProviderEnvironmentResponse;
  /** When set, `getSandboxProviderEnvironment` rejects (transport refused / deadline / decode). */
  reject?: Error;
}

function providerEnvTransport(opts: ProviderEnvDoubleOpts): OpenShellProviderEnvTransport & {
  penvCalls: GetSandboxProviderEnvironmentRequest[];
} {
  const penvCalls: GetSandboxProviderEnvironmentRequest[] = [];
  return {
    penvCalls,
    health: () => Promise.resolve({ ok: true }),
    createSandbox: () => Promise.resolve({ sandbox: { metadata: { name: OS_NAME, id: OS_ID } } }),
    deleteSandbox: () => Promise.resolve({ deleted: true }),
    getSandboxProviderEnvironment(
      req: GetSandboxProviderEnvironmentRequest,
    ): Promise<GetSandboxProviderEnvironmentResponse> {
      penvCalls.push(req);
      if (opts.reject !== undefined) return Promise.reject(opts.reject);
      return Promise.resolve(opts.resp ?? { environment: {}, providerEnvRevision: 0n });
    },
  };
}

async function createMapped(adapter: OpenShellSandboxAdapter): Promise<string> {
  const res = await adapter.createSandbox(GOOD_CTX, { image: PINNED_SANDBOX_IMAGE });
  if (res.status !== "ok") throw new Error("setup: createSandbox should be ok");
  return res.sandboxId;
}

describe("OpenShellSandboxAdapter.getProviderEnvironment — fail-closed pre-RPC guards", () => {
  it("denies a malformed AgentContext BEFORE any RPC", async () => {
    const t = providerEnvTransport({});
    const adapter = new OpenShellSandboxAdapter(t);
    const res = await adapter.getProviderEnvironment({ actorId: "" } as unknown, "sbx-os-anything");
    expect(res.status).toBe("denied");
    expect(t.penvCalls).toHaveLength(0);
  });

  it("denies an unknown sandbox id (mapping missing) BEFORE any RPC", async () => {
    const t = providerEnvTransport({});
    const adapter = new OpenShellSandboxAdapter(t);
    const res = await adapter.getProviderEnvironment(
      GOOD_CTX,
      "sbx-os-00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe("denied");
    if (res.status !== "denied") throw new Error("unreachable");
    expect(res.reason.toLowerCase()).toContain("unknown");
    expect(t.penvCalls).toHaveLength(0);
  });
});

describe("OpenShellSandboxAdapter.getProviderEnvironment — happy path (placeholder-only)", () => {
  it("returns the placeholder env + revision for an all-placeholder response", async () => {
    const env = {
      TOKEN: "openshell:resolve:env:TOKEN",
      KEY: "openshell:resolve:env:v3_KEY",
    };
    const t = providerEnvTransport({ resp: { environment: env, providerEnvRevision: 3n } });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.getProviderEnvironment(GOOD_CTX, id);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.env).toEqual(env);
    // revision is a non-secret numeric string (never a credential).
    expect(res.revision).toBe("3");
    expect(t.penvCalls).toHaveLength(1);
    expect(t.penvCalls[0]?.name).toBe(OS_NAME);
  });
});

describe("OpenShellSandboxAdapter.getProviderEnvironment — credentials never leak", () => {
  it("DENIES (guard throws) when the gateway returns a raw-secret value, leaking no env", async () => {
    const secret = rawSecretCanary();
    const t = providerEnvTransport({
      resp: {
        environment: { TOKEN: "openshell:resolve:env:TOKEN", LEAK: secret },
        providerEnvRevision: 1n,
      },
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.getProviderEnvironment(GOOD_CTX, id);
    expect(res.status).toBe("denied");
    if (res.status !== "denied") throw new Error("unreachable");
    // The denied result carries NO env field at all (the raw value must never be carried).
    expect("env" in res).toBe(false);
    // The raw value must never appear in the reason or the auditable event.
    expect(res.reason).not.toContain(secret);
    expect(JSON.stringify(res.event)).not.toContain(secret);
  });

  it("denies (never throws) when the transport rejects, leaking no endpoint detail", async () => {
    const endpoint = "https://super-secret-gateway.internal:8443";
    const t = providerEnvTransport({ reject: new Error(`connect ECONNREFUSED ${endpoint}`) });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.getProviderEnvironment(GOOD_CTX, id);
    expect(res.status).toBe("denied");
    if (res.status !== "denied") throw new Error("unreachable");
    expect(res.reason).not.toContain(endpoint);
    expect(JSON.stringify(res.event)).not.toContain(endpoint);
  });
});
