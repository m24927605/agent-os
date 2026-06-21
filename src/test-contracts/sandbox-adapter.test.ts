/**
 * ExecutionSubstrate PORT CONTRACT — the shared, factory-parameterized suite EVERY SandboxAdapter
 * implementation must pass. Pluggability HARD CONSTRAINT: a port is real flexibility only when >=2
 * implementations satisfy one contract. Here that is NullSandboxAdapter (fail-closed deny-all) and
 * FakeSandboxAdapter (in-memory). A future real OpenShell adapter (P2) MUST be added to ADAPTERS and
 * pass unchanged — that is the mechanical proof the substrate is swappable, not vendor-locked.
 *
 * The contract captures invariants true for ALL adapters; vendor-/impl-specific behaviour (Null
 * always denies; Fake's ok path) is asserted in the per-impl blocks below.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type CreateSandboxRequest,
  type DeleteSandboxRequest,
  type DeleteSandboxResponse,
  type OpenShellLifecycleTransport,
  OpenShellSandboxAdapter,
  PINNED_SANDBOX_IMAGE,
  type SandboxResponse,
} from "../runtime/openshell/index.js";
import {
  FakeSandboxAdapter,
  NullSandboxAdapter,
  type SandboxAdapter,
  SandboxLifecycleEvent,
} from "../runtime/substrate/index.js";

const validCtx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

/**
 * Happy-path OpenShell transport double (NO live gateway in this env — design §7.4). It satisfies the
 * S2 lifecycle seam the adapter is constructed with: create returns a named sandbox, delete succeeds.
 * The contract harness never reaches across the network — it injects this in-process double, mirroring
 * adapter.create.test.ts. start/stop are noop shims (no RPC) so this double needs no readiness/exec.
 */
function happyPathOpenShellTransport(): OpenShellLifecycleTransport {
  let n = 0;
  return {
    health: () => Promise.resolve({ ok: true }),
    createSandbox(_req: CreateSandboxRequest): Promise<SandboxResponse> {
      n += 1;
      return Promise.resolve({ sandbox: { metadata: { name: `os-sbx-${n}`, id: `os-id-${n}` } } });
    },
    deleteSandbox(_req: DeleteSandboxRequest): Promise<DeleteSandboxResponse> {
      return Promise.resolve({ deleted: true });
    },
  };
}

const ADAPTERS: { name: string; make: () => SandboxAdapter }[] = [
  { name: "NullSandboxAdapter", make: () => new NullSandboxAdapter() },
  { name: "FakeSandboxAdapter", make: () => new FakeSandboxAdapter() },
  // The THIRD impl: the real OpenShell adapter, driven by an injected happy-path transport double.
  // Passing the SAME contract unchanged is the mechanical proof the substrate is swappable, not
  // vendor-locked (HARD CONSTRAINT: >=3 impls past one contract).
  {
    name: "OpenShellSandboxAdapter",
    make: () => new OpenShellSandboxAdapter(happyPathOpenShellTransport()),
  },
];

describe.each(ADAPTERS)("SandboxAdapter contract — $name", ({ make }) => {
  it("every lifecycle method returns a well-formed, schema-valid AdapterResult + event", async () => {
    const a = make();
    const created = await a.createSandbox(validCtx, { image: "x" });
    const id = created.status === "ok" ? created.sandboxId : "sbx-probe";
    const results = {
      create: created,
      start: await a.startSandbox(validCtx, id),
      stop: await a.stopSandbox(validCtx, id),
      destroy: await a.destroySandbox(validCtx, id),
    };
    for (const [lifecycle, r] of Object.entries(results)) {
      const event = SandboxLifecycleEvent.parse(r.event); // throws if malformed
      expect(event.lifecycle).toBe(lifecycle);
      expect(event.result).toBe(r.status);
      if (r.status === "ok") {
        expect(r.sandboxId).toBeTruthy();
        expect(event.sandboxId).toBe(r.sandboxId);
      } else {
        expect(r.reason).toBeTruthy();
      }
    }
  });

  it("is FAIL-CLOSED on a malformed AgentContext: denied, never executed, no throw", async () => {
    const a = make();
    const res = await a.createSandbox({ tenantId: "" }, {});
    expect(res.status).toBe("denied");
    expect(res.event.context).toBeUndefined();
    expect(res.event.contextError).toBeDefined();
  });

  it("never throws on any lifecycle call (errors surface as denied results)", async () => {
    const a = make();
    await expect(a.startSandbox({}, "sbx-x")).resolves.toBeDefined();
    await expect(a.destroySandbox(undefined, "")).resolves.toBeDefined();
  });
});

describe("NullSandboxAdapter — deny-by-default specialization", () => {
  it("denies every lifecycle method with a deny-by-default reason + auditable event", async () => {
    const a = new NullSandboxAdapter();
    for (const r of [
      await a.createSandbox(validCtx, {}),
      await a.startSandbox(validCtx, "sbx-1"),
      await a.stopSandbox(validCtx, "sbx-1"),
      await a.destroySandbox(validCtx, "sbx-1"),
    ]) {
      expect(r.status).toBe("denied");
      if (r.status === "denied") expect(r.reason).toContain("deny-by-default");
      expect(`${r.event.context?.tenantId}`).toBe("tenant-a");
    }
  });
});

describe("FakeSandboxAdapter — ok-path specialization (the mandatory 2nd impl)", () => {
  it("creates then operates a sandbox, and rejects an unknown id fail-closed", async () => {
    const a = new FakeSandboxAdapter();
    const created = await a.createSandbox(validCtx, { image: "x" });
    expect(created.status).toBe("ok");
    if (created.status !== "ok") return;
    expect((await a.startSandbox(validCtx, created.sandboxId)).status).toBe("ok");
    expect((await a.destroySandbox(validCtx, created.sandboxId)).status).toBe("ok");
    expect((await a.startSandbox(validCtx, created.sandboxId)).status).toBe("denied");
    expect((await a.startSandbox(validCtx, "sbx-never")).status).toBe("denied");
  });
});

describe("OpenShellSandboxAdapter — start/stop are an HONEST noop shim (OpenShell has no Start/Stop RPC)", () => {
  it("start/stop on a KNOWN id => ok WITHOUT issuing any RPC, event reason marks the noop shim", async () => {
    // A transport that throws on EVERY lifecycle RPC except the create/delete the test sets up — so if
    // start/stop ever touched the wire the test would surface a thrown/denied result, not an ok.
    let createCalls = 0;
    let deleteCalls = 0;
    const t: OpenShellLifecycleTransport = {
      health: () => Promise.resolve({ ok: true }),
      createSandbox: () => {
        createCalls += 1;
        return Promise.resolve({ sandbox: { metadata: { name: "os-sbx-k", id: "os-id-k" } } });
      },
      deleteSandbox: () => {
        deleteCalls += 1;
        return Promise.resolve({ deleted: true });
      },
    };
    const a = new OpenShellSandboxAdapter(t);
    const created = await a.createSandbox(validCtx, { image: PINNED_SANDBOX_IMAGE });
    expect(created.status).toBe("ok");
    if (created.status !== "ok") throw new Error("unreachable");
    const id = created.sandboxId;
    expect(createCalls).toBe(1);

    const started = await a.startSandbox(validCtx, id);
    expect(started.status).toBe("ok");
    if (started.status === "ok") expect(started.sandboxId).toBe(id);
    expect(started.event.reason ?? "").toContain("noop shim");

    const stopped = await a.stopSandbox(validCtx, id);
    expect(stopped.status).toBe("ok");
    expect(stopped.event.reason ?? "").toContain("noop shim");

    // The HARD honesty invariant: a noop shim issues NO RPC at all (no create/delete beyond the setup).
    expect(createCalls).toBe(1);
    expect(deleteCalls).toBe(0);
  });

  it("start/stop on an UNKNOWN id => denied (fail-closed), never claims a phantom success", async () => {
    const a = new OpenShellSandboxAdapter(happyPathOpenShellTransport());
    const started = await a.startSandbox(validCtx, "sbx-os-never-created");
    expect(started.status).toBe("denied");
    const stopped = await a.stopSandbox(validCtx, "sbx-os-never-created");
    expect(stopped.status).toBe("denied");
  });

  it("start/stop on a malformed id / bad ctx => denied, never throws (deny-by-default)", async () => {
    const a = new OpenShellSandboxAdapter(happyPathOpenShellTransport());
    await expect(a.startSandbox(validCtx, "")).resolves.toMatchObject({ status: "denied" });
    await expect(a.stopSandbox({ tenantId: "" }, "sbx-os-1")).resolves.toMatchObject({
      status: "denied",
    });
  });
});

describe("substrate adapters reach NO egress (cohesion chokepoint)", () => {
  // POSITIVE allowlist (strictly stronger than a negative regex: it catches bare-specifier builtins
  // like `import fs from "fs"` / third-party HTTP clients, not just `node:`-prefixed ones). Any import
  // outside this set fails the test — adding a dependency to a substrate adapter is a visible decision.
  const ALLOWED_SPECIFIERS = new Set(["zod", "./port.js", "../../iam/ids.js"]);
  const ioCall = /\bfetch\s*\(|\bimport\s*\(|\brequire\s*\(/;

  for (const f of ["port.ts", "null.ts", "fake.ts"]) {
    it(`${f} imports only from the allowlist (port/iam/zod) and uses no call-style I/O`, () => {
      const src = readFileSync(new URL(`../runtime/substrate/${f}`, import.meta.url), "utf8");
      const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
      for (const spec of specifiers) {
        expect(ALLOWED_SPECIFIERS.has(spec), `${f} imports disallowed module: ${spec}`).toBe(true);
      }
      expect(ioCall.test(src), `${f} must not call fetch/import()/require()`).toBe(false);
    });
  }
});
