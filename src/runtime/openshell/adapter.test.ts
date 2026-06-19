import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NullSandboxAdapter, SandboxLifecycleEvent } from "./adapter.js";

const validCtx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

describe("NullSandboxAdapter — deny-by-default, fail-closed", () => {
  it("denies createSandbox with a deny-by-default reason", async () => {
    const res = await new NullSandboxAdapter().createSandbox(validCtx, { image: "x" });
    expect(res.status).toBe("denied");
    if (res.status === "denied") {
      expect(res.reason).toContain("deny-by-default");
    }
  });

  it("denies every lifecycle method with an auditable lifecycle event", async () => {
    const a = new NullSandboxAdapter();
    const res = {
      create: await a.createSandbox(validCtx, {}),
      start: await a.startSandbox(validCtx, "sbx-1"),
      stop: await a.stopSandbox(validCtx, "sbx-1"),
      destroy: await a.destroySandbox(validCtx, "sbx-1"),
    };
    for (const [lifecycle, r] of Object.entries(res)) {
      expect(r.status).toBe("denied");
      const event = SandboxLifecycleEvent.parse(r.event);
      expect(event.lifecycle).toBe(lifecycle);
      expect(event.result).toBe("denied");
      expect(`${event.context?.tenantId}`).toBe("tenant-a");
    }
  });

  it("still denies (does not throw, does not allow) on a malformed agent context", async () => {
    const res = await new NullSandboxAdapter().createSandbox({ tenantId: "" }, {});
    expect(res.status).toBe("denied");
    expect(res.event.context).toBeUndefined();
    expect(res.event.contextError).toBeDefined();
  });

  it("structurally cannot reach egress: imports only the iam barrel + zod, no I/O modules", () => {
    const src = readFileSync(new URL("./adapter.ts", import.meta.url), "utf8");
    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(specifiers).toEqual(["../../iam/ids.js", "zod"]);
    const ioCapable =
      /node:(http|https|net|dns|child_process|fs|worker_threads|dgram|tls|cluster)|\bfetch\s*\(|\bimport\s*\(|\brequire\s*\(/;
    expect(ioCapable.test(src)).toBe(false);
  });
});
