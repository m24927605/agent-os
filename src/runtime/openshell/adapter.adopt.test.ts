/**
 * RED-first tests for SLICE-HERMES-S1 — adoptSandbox (GetSandbox -> refById; adopt an EXTERNALLY
 * created sandbox so the SAME adapter can then status/exec it with NO out-of-band seed).
 *
 * These assert the behaviours + security invariants of the slice spec
 * (docs/slices/hermes-live/HERMES-S1-adopt-and-host-real-gateway.md) BEFORE `adoptSandbox` exists.
 * They MUST be SEEN to fail first (the adapter has no `adoptSandbox`).
 *
 * No live OpenShell server exists in this environment: every test drives the adapter through an
 * INJECTED transport double that mimics the readiness/lifecycle seam's `getSandbox` unary primitive
 * (openshell.proto:436; SandboxResponse at proto:488-490). The Hermes sandbox is created EXTERNALLY by
 * the user (`nemohermes onboard`), so `adoptSandbox` is the production-real "use an existing sandbox"
 * entry — it resolves the {name,id} ref via the REAL GetSandbox path (NOT a test reflection seed).
 *
 * Load-bearing security probe (deny-by-default / fail-closed): a bad ctx, a transport with NO
 * getSandbox, a getSandbox that throws, OR a SandboxResponse with no name ALL fail CLOSED (denied),
 * the adapter NEVER throws across the port boundary, and a denied reason NEVER leaks baseUrl /
 * endpoint / credential detail. The MUTATION probe: if adopt does NOT populate refById, a follow-up
 * status/exec on the returned sandboxId denies "unknown sandbox" (proving adopt is what wires the ref).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OpenShellSandboxAdapter } from "./adapter.js";
import type {
  ExecSandboxEvent,
  ExecSandboxRequest,
  GetSandboxRequest,
  OpenShellExecTransport,
  OpenShellReadinessTransport,
  SandboxResponse,
  SandboxStreamEvent,
  WatchSandboxRequest,
} from "./client.js";

/** A well-formed AgentContext (mirrors the iam/ids AgentContext schema). */
const GOOD_CTX = {
  actorId: "actor-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  taskId: "task-1",
  requestId: "request-1",
};

/** The user-provisioned Hermes sandbox name + the gateway-assigned stable id. */
const HERMES_NAME = "agentos-hermes";
const HERMES_ID = randomUUID();

interface AdoptDoubleOpts {
  /** The SandboxResponse `getSandbox` resolves; defaults to a full {name,id} ref. */
  getResponse?: SandboxResponse;
  /** When set, `getSandbox` rejects with this error (transport refused / deadline / decode). */
  getReject?: Error;
  /** Exec events streamed in order on a follow-up exec (proves status/exec work post-adopt). */
  execEvents?: Array<ExecSandboxEvent | Error>;
}

/**
 * A transport double exposing the readiness `getSandbox` (the adopt path) AND the exec stream (the
 * follow-up status/exec proof). It records getSandbox calls so we can assert adopt keys on `name`.
 */
function adoptTransport(opts: AdoptDoubleOpts): OpenShellReadinessTransport &
  OpenShellExecTransport & {
    getCalls: GetSandboxRequest[];
    execCalls: ExecSandboxRequest[];
  } {
  const getCalls: GetSandboxRequest[] = [];
  const execCalls: ExecSandboxRequest[] = [];
  return {
    getCalls,
    execCalls,
    health: () => Promise.resolve({ ok: true }),
    createSandbox: () =>
      Promise.resolve({ sandbox: { metadata: { name: HERMES_NAME, id: HERMES_ID } } }),
    deleteSandbox: () => Promise.resolve({ deleted: true }),
    getSandbox(req: GetSandboxRequest): Promise<SandboxResponse> {
      getCalls.push(req);
      if (opts.getReject !== undefined) return Promise.reject(opts.getReject);
      return Promise.resolve(
        opts.getResponse ?? { sandbox: { metadata: { name: HERMES_NAME, id: HERMES_ID } } },
      );
    },
    watchSandbox(_req: WatchSandboxRequest): AsyncIterable<SandboxStreamEvent> {
      return {
        // biome-ignore lint/correctness/useYield: an empty watch stream (no readiness events).
        async *[Symbol.asyncIterator](): AsyncIterator<SandboxStreamEvent> {
          return;
        },
      };
    },
    execSandbox(req: ExecSandboxRequest): AsyncIterable<ExecSandboxEvent> {
      execCalls.push(req);
      const events = opts.execEvents ?? [];
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ExecSandboxEvent> {
          for (const ev of events) {
            if (ev instanceof Error) throw ev;
            yield ev;
          }
        },
      };
    },
  };
}

describe("OpenShellSandboxAdapter.adoptSandbox", () => {
  it("adopts an externally-created sandbox via GetSandbox(name) and returns a schema-valid SandboxId (ok)", async () => {
    const t = adoptTransport({});
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.adoptSandbox(GOOD_CTX, HERMES_NAME);

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(typeof res.sandboxId).toBe("string");
    expect(res.sandboxId.length).toBeGreaterThan(0);
    expect(res.event.result).toBe("ok");
    // GetSandbox is keyed on the canonical `name` (server: get_message_by_name).
    expect(t.getCalls).toHaveLength(1);
    expect(t.getCalls[0]?.name).toBe(HERMES_NAME);
  });

  it("populates refById so the SAME adapter's exec resolves the ref with NO seed (post-adopt)", async () => {
    // A faithful exec stream proves the adopted ref keys exec on the gateway-assigned stable id.
    const t = adoptTransport({
      execEvents: [{ stdout: { data: new TextEncoder().encode("ok") } }, { exit: { exitCode: 0 } }],
    });
    const adapter = new OpenShellSandboxAdapter(t);

    const adopted = await adapter.adoptSandbox(GOOD_CTX, HERMES_NAME);
    expect(adopted.status).toBe("ok");
    if (adopted.status !== "ok") throw new Error("unreachable");

    // No createSandbox, no reflection seed — exec MUST resolve the ref adopt populated.
    const exec = await adapter.execSandbox(GOOD_CTX, adopted.sandboxId, ["/bin/sh", "-c", "true"]);
    expect(exec.status).toBe("ok");
    if (exec.status !== "ok") throw new Error("unreachable");
    expect(exec.result.exitCode).toBe(0);
    // Exec keys on the gateway-assigned stable `id` (proto:647), which adopt captured from GetSandbox.
    expect(t.execCalls).toHaveLength(1);
    expect(t.execCalls[0]?.sandboxId).toBe(HERMES_ID);
  });

  it("denies (fail-closed) a bad AgentContext and does NOT call GetSandbox", async () => {
    const t = adoptTransport({});
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.adoptSandbox({ not: "a context" }, HERMES_NAME);

    expect(res.status).toBe("denied");
    expect(res.event.result).toBe("denied");
    expect(res.event.contextError).toBeDefined();
    expect(t.getCalls).toHaveLength(0);
  });

  it("denies (fail-closed) when the transport cannot GetSandbox (no readiness primitive)", async () => {
    // A pure lifecycle transport (no getSandbox) cannot adopt — fail closed, never silently proceed.
    const lifecycleOnly = {
      health: () => Promise.resolve({ ok: true }),
      createSandbox: () => Promise.resolve({ sandbox: { metadata: { name: HERMES_NAME } } }),
      deleteSandbox: () => Promise.resolve({ deleted: true }),
    };
    const adapter = new OpenShellSandboxAdapter(lifecycleOnly);

    const res = await adapter.adoptSandbox(GOOD_CTX, HERMES_NAME);

    expect(res.status).toBe("denied");
  });

  it("denies an empty/malformed SandboxResponse (no metadata.name) and retains NO mapping", async () => {
    const t = adoptTransport({ getResponse: {} as SandboxResponse });
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.adoptSandbox(GOOD_CTX, HERMES_NAME);

    expect(res.status).toBe("denied");
    expect(t.getCalls).toHaveLength(1);
  });

  it("denies a SandboxResponse with a sandbox but no name (fail-closed)", async () => {
    const t = adoptTransport({ getResponse: { sandbox: { metadata: { id: HERMES_ID } } } });
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.adoptSandbox(GOOD_CTX, HERMES_NAME);

    expect(res.status).toBe("denied");
  });

  it("denies (fail-closed, does NOT throw) when GetSandbox rejects, leaking no baseUrl", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = "https://super-secret-gateway.internal:8443";
    const t = adoptTransport({ getReject: new Error(`connect ECONNREFUSED ${secret}`) });
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.adoptSandbox(GOOD_CTX, HERMES_NAME);

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

  it("MUTATION: if adopt does NOT populate refById, a follow-up status/exec denies 'unknown sandbox'", async () => {
    // This is the adversarial mutation guard: it documents that the ok+sandboxId from adopt is only
    // useful BECAUSE adopt wired the ref. We simulate "adopt forgot to set refById" by calling exec on
    // a SandboxId that the adapter never mapped (the exact shape adopt returns: `sbx-os-adopt-<uuid>`).
    const t = adoptTransport({});
    const adapter = new OpenShellSandboxAdapter(t);

    const unmapped = `sbx-os-adopt-${randomUUID()}`;
    const exec = await adapter.execSandbox(GOOD_CTX, unmapped, ["/bin/sh", "-c", "true"]);
    expect(exec.status).toBe("denied");
    if (exec.status !== "denied") throw new Error("unreachable");
    expect(exec.reason).toContain("unknown sandbox");
    // No exec RPC is issued for an unmapped id (deny-by-default: never guess an id).
    expect(t.execCalls).toHaveLength(0);
  });
});
