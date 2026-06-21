/**
 * AgentHosting PORT CONTRACT — the shared suite EVERY AgentHosting implementation must pass, plus the
 * tenant-isolation invariant that NemoClaw explicitly does NOT provide (the Enterprise differentiation):
 * an agent hosted under tenant-A cannot be status'd / reconciled / re-hosted by tenant-B. >=2 impls
 * (NullAgentHosting fail-closed + InMemoryAgentHosting tenant-scoped) prove the slot is pluggable;
 * NemoClaw is the future real adapter. The port is credential-blind (the host spec carries no secret).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NemoClawAgentHosting } from "../hosting/adapters/nemoclaw/index.js";
import { type AgentHosting, InMemoryAgentHosting, NullAgentHosting } from "../hosting/index.js";

/** In-process CommandSink that always reports a healthy launch + running probe (contract harness). */
const okSink = {
  run: (command: string) =>
    Promise.resolve({
      exitCode: 0,
      stdout: command.includes("http_code") ? "200" : "GATEWAY_PID=4242",
    }),
};

const ctxA = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};
const ctxB = { ...ctxA, tenantId: "tenant-b", requestId: "req-2" };
const spec = { sandboxId: "sbx-1", agentName: "hermes" };

const ADAPTERS: { name: string; make: () => AgentHosting }[] = [
  { name: "NullAgentHosting", make: () => new NullAgentHosting() },
  { name: "InMemoryAgentHosting", make: () => new InMemoryAgentHosting() },
  { name: "NemoClawAgentHosting", make: () => new NemoClawAgentHosting(okSink) },
];

describe.each(ADAPTERS)("AgentHosting contract — $name", ({ make }) => {
  it("hostAgent returns a well-formed result whose status agrees with its event", async () => {
    const r = await make().hostAgent(ctxA, spec);
    expect(r.event.operation).toBe("host");
    expect(r.event.result).toBe(r.status === "ok" ? "ok" : "denied");
    if (r.status === "ok") expect(r.agentProcessId).toBeTruthy();
    else expect(r.reason).toBeTruthy();
  });

  it("is FAIL-CLOSED on a malformed AgentContext: denied, no throw", async () => {
    const r = await make().hostAgent({ tenantId: "" }, spec);
    expect(r.status).toBe("denied");
    expect(r.event.contextError).toBeDefined();
  });

  it("never throws on any method", async () => {
    const a = make();
    await expect(a.hostAgent({}, spec)).resolves.toBeDefined();
    await expect(a.getAgentStatus(undefined, "sbx-x")).resolves.toBeDefined();
    await expect(a.reconcileAgentProcess({}, "sbx-x", "restart")).resolves.toBeDefined();
  });
});

describe("NullAgentHosting — deny-all (fail-closed when no host backend is wired)", () => {
  it("denies hostAgent with a deny-by-default reason", async () => {
    const r = await new NullAgentHosting().hostAgent(ctxA, spec);
    expect(r.status).toBe("denied");
    if (r.status === "denied") expect(r.reason).toContain("deny-by-default");
  });
});

describe("InMemoryAgentHosting — tenant-scoped lifecycle (the NemoClaw gap, closed)", () => {
  it("hosts an agent, then status/reconcile succeed for the SAME tenant", async () => {
    const h = new InMemoryAgentHosting();
    expect((await h.hostAgent(ctxA, spec)).status).toBe("ok");
    expect((await h.getAgentStatus(ctxA, "sbx-1")).status).toBe("ok");
    expect((await h.reconcileAgentProcess(ctxA, "sbx-1", "health-probe")).status).toBe("ok");
    expect((await h.reconcileAgentProcess(ctxA, "sbx-1", "restart")).status).toBe("ok");
  });

  it("TENANT ISOLATION: tenant-B cannot status / reconcile / re-host tenant-A's agent", async () => {
    const h = new InMemoryAgentHosting();
    expect((await h.hostAgent(ctxA, spec)).status).toBe("ok");
    for (const r of [
      await h.getAgentStatus(ctxB, "sbx-1"),
      await h.reconcileAgentProcess(ctxB, "sbx-1", "restart"),
      await h.hostAgent(ctxB, spec), // re-host the same sandbox as another tenant
    ]) {
      expect(r.status).toBe("denied");
      if (r.status === "denied") expect(r.reason.toLowerCase()).toContain("cross-tenant");
    }
  });

  it("unknown sandbox: status/reconcile are denied", async () => {
    const h = new InMemoryAgentHosting();
    expect((await h.getAgentStatus(ctxA, "sbx-nope")).status).toBe("denied");
    expect((await h.reconcileAgentProcess(ctxA, "sbx-nope", "restart")).status).toBe("denied");
  });
});

describe("AgentHosting port is credential-blind by construction", () => {
  it("port.ts surface (excluding comments) names no credential/secret/authorization field", () => {
    const raw = readFileSync(new URL("../hosting/port.ts", import.meta.url), "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(/credential|secret|password|authorization|bearer|apikey|api[_-]?key/i.test(code)).toBe(
      false,
    );
  });
});
