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

const ADAPTERS: { name: string; make: () => SandboxAdapter }[] = [
  { name: "NullSandboxAdapter", make: () => new NullSandboxAdapter() },
  { name: "FakeSandboxAdapter", make: () => new FakeSandboxAdapter() },
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
