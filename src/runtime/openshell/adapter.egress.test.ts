/**
 * SLICE-CAP5 (RED-first) — `SandboxSpec.egressAllow` is carried toward OpenShell `createSandbox` as
 * DOCUMENTED DEPLOY-INTENT.
 *
 * HONEST BOUNDARY: the pinned OpenShell `CreateSandboxRequest` proto subset (client.ts:84-89) types
 * ONLY `spec.template.image` + `labels` + an optional `name`. It carries NO egress / network-policy
 * field. So CAP5 does NOT fabricate a proto field: the adapter ACCEPTS `spec.egressAllow` (so a future
 * network tool can declare its allowlist on the spec), but the REAL no-egress enforcement is a DEPLOY
 * FACT (OpenShell network policy). `egressAllow` on the wire today is documented intent — it must NOT
 * change the emitted CreateSandboxRequest (no field to set), and it must NOT break create.
 *
 * This pins:
 *  - byte-identical: a spec WITHOUT egressAllow emits the SAME CreateSandboxRequest as before CAP5.
 *  - deploy-intent: a spec WITH egressAllow still creates (ok) AND the emitted CreateSandboxRequest is
 *    IDENTICAL to the no-egressAllow request (the proto subset has no field to carry it; honest).
 */
import { describe, expect, it } from "vitest";
import { OpenShellSandboxAdapter } from "./adapter.js";
import { PINNED_SANDBOX_IMAGE } from "./client.js";
import type {
  CreateSandboxRequest,
  DeleteSandboxRequest,
  DeleteSandboxResponse,
  OpenShellLifecycleTransport,
  SandboxResponse,
} from "./client.js";

const GOOD_CTX = {
  actorId: "actor-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  taskId: "task-1",
  requestId: "request-1",
};

function recordingTransport(): OpenShellLifecycleTransport & {
  createCalls: CreateSandboxRequest[];
} {
  const createCalls: CreateSandboxRequest[] = [];
  return {
    createCalls,
    health: () => Promise.resolve({ ok: true }),
    createSandbox(req: CreateSandboxRequest): Promise<SandboxResponse> {
      createCalls.push(req);
      return Promise.resolve({ sandbox: { metadata: { name: "os-sbx-egress-1" } } });
    },
    deleteSandbox(_req: DeleteSandboxRequest): Promise<DeleteSandboxResponse> {
      return Promise.resolve({ deleted: true });
    },
  };
}

describe("OpenShellSandboxAdapter.createSandbox — SandboxSpec.egressAllow (documented deploy-intent)", () => {
  it("byte-identical: a spec WITHOUT egressAllow emits the same CreateSandboxRequest", async () => {
    const t = recordingTransport();
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.createSandbox(GOOD_CTX, { image: PINNED_SANDBOX_IMAGE });

    expect(res.status).toBe("ok");
    expect(t.createCalls).toHaveLength(1);
    expect(t.createCalls[0]).toEqual({ spec: { template: { image: PINNED_SANDBOX_IMAGE } } });
  });

  it("deploy-intent: a spec WITH egressAllow still creates (ok) and the wire request is UNCHANGED (no proto field)", async () => {
    const t = recordingTransport();
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.createSandbox(GOOD_CTX, {
      image: PINNED_SANDBOX_IMAGE,
      egressAllow: ["api.allowed.example", "models.other.example"],
    });

    expect(res.status).toBe("ok");
    expect(t.createCalls).toHaveLength(1);
    // The proto subset carries NO egress field — egressAllow is documented deploy-intent only, so the
    // emitted request is IDENTICAL to the no-egressAllow request (honest: the wire is not fabricated).
    expect(t.createCalls[0]).toEqual({ spec: { template: { image: PINNED_SANDBOX_IMAGE } } });
  });
});
