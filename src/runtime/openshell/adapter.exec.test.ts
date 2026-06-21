/**
 * RED-first tests for SLICE-P2R-R1-S4 — ExecSandbox server-stream (stdout/stderr/exit -> result).
 *
 * These assert the behaviours + security invariants of §5 of the slice spec
 * (docs/slices/phase-2-remaining/P2R-R1-S4-execsandbox-stream.md) BEFORE any `execSandbox`
 * implementation exists. They MUST be SEEN to fail first (the transport seam has no `execSandbox`
 * and the adapter has no `execSandbox`).
 *
 * No live OpenShell server exists in this environment (design §7.4): every test drives the adapter
 * through an INJECTED transport double that mimics the S2/S3 transport seam extended with the S4
 * `execSandbox` server-stream primitive (openshell.proto:67; ExecSandboxEvent oneof at proto:690-696).
 *
 * Load-bearing security probe (deny-by-default / fail-closed): a stream that errors before exit, a
 * stream that closes WITHOUT an exit event, a deadline that elapses, OR an unknown sandbox id ALL
 * fail CLOSED (denied, NEVER a fabricated exit code 0); an env value carrying a reserved credential
 * marker as plaintext (NOT a well-formed `openshell:resolve:env:` placeholder) is denied BEFORE any
 * RPC (credentials must never enter exec env in the clear). The adapter NEVER throws across the port
 * boundary and a denied reason NEVER leaks baseUrl / endpoint / credential detail.
 */
import { describe, expect, it, vi } from "vitest";
import { OpenShellSandboxAdapter } from "./adapter.js";
import { PINNED_SANDBOX_IMAGE } from "./client.js";
import { isExecEnvValueAllowed } from "./client.js";
import type { ExecSandboxEvent, ExecSandboxRequest, OpenShellExecTransport } from "./client.js";

/** A well-formed AgentContext (mirrors the iam/ids AgentContext schema). */
const GOOD_CTX = {
  actorId: "actor-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  taskId: "task-1",
  requestId: "request-1",
};

const OS_NAME = "os-sbx-exec";
const OS_ID = "sbxid-exec-stable-gateway-id";

interface ExecDoubleOpts {
  /** ExecSandbox events streamed in order; an Error throws from the iterator (stream error). */
  execEvents?: Array<ExecSandboxEvent | Error>;
  /** When set, `execSandbox` throws synchronously (transport refused). */
  execReject?: Error;
}

/** A transport double that records exec calls (and the AbortSignal) and replays exec stream events. */
function execTransport(opts: ExecDoubleOpts): OpenShellExecTransport & {
  execCalls: ExecSandboxRequest[];
  execSignals: Array<AbortSignal | undefined>;
} {
  const execCalls: ExecSandboxRequest[] = [];
  const execSignals: Array<AbortSignal | undefined> = [];
  return {
    execCalls,
    execSignals,
    health: () => Promise.resolve({ ok: true }),
    createSandbox: () => Promise.resolve({ sandbox: { metadata: { name: OS_NAME, id: OS_ID } } }),
    deleteSandbox: () => Promise.resolve({ deleted: true }),
    execSandbox(req: ExecSandboxRequest, signal?: AbortSignal): AsyncIterable<ExecSandboxEvent> {
      execCalls.push(req);
      execSignals.push(signal);
      if (opts.execReject !== undefined) throw opts.execReject;
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

/** Create a sandbox through the adapter and return its mapped SandboxId. */
async function createMapped(adapter: OpenShellSandboxAdapter): Promise<string> {
  const res = await adapter.createSandbox(GOOD_CTX, { image: PINNED_SANDBOX_IMAGE });
  if (res.status !== "ok") throw new Error("setup: createSandbox should be ok");
  return res.sandboxId;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const stdoutEvent = (data: string): ExecSandboxEvent => ({ stdout: { data: enc(data) } });
const stderrEvent = (data: string): ExecSandboxEvent => ({ stderr: { data: enc(data) } });
const exitEvent = (code: number): ExecSandboxEvent => ({ exit: { exitCode: code } });

describe("OpenShellSandboxAdapter.execSandbox — happy path (stream convergence)", () => {
  it("converges stdout chunks + exit 0 into an ok result with the exit code and joined stdout", async () => {
    const t = execTransport({
      execEvents: [stdoutEvent("hello "), stdoutEvent("world"), exitEvent(0)],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["echo", "hi"]);

    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.result.exitCode).toBe(0);
    expect(dec(res.result.stdout)).toBe("hello world");
    expect(dec(res.result.stderr)).toBe("");
    // ExecSandboxRequest MUST be keyed by the gateway-assigned stable `sandbox_id` (proto:647),
    // NOT the human-readable name, and carry the command.
    expect(t.execCalls).toHaveLength(1);
    expect(t.execCalls[0]?.sandboxId).toBe(OS_ID);
    expect(t.execCalls[0]?.command).toEqual(["echo", "hi"]);
  });

  it("separates stdout and stderr streams and reports a NON-ZERO exit code as ok (not a transport failure)", async () => {
    const t = execTransport({
      execEvents: [stdoutEvent("out"), stderrEvent("err1"), stderrEvent("err2"), exitEvent(7)],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["false"]);

    // A non-zero exit is a faithfully-reported command result, NOT a transport/deny condition.
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.result.exitCode).toBe(7);
    expect(dec(res.result.stdout)).toBe("out");
    expect(dec(res.result.stderr)).toBe("err1err2");
  });

  it("forwards workdir / env / timeoutSeconds / stdin into the ExecSandboxRequest", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["env"], {
      workdir: "/work",
      // A well-formed placeholder is the ONLY accepted credential-bearing env value (design §2.3).
      env: { TOKEN: "openshell:resolve:env:v3_TOKEN", PLAIN: "literal" },
      timeoutSeconds: 30,
      stdin: enc("piped-in"),
    });

    expect(res.status).toBe("ok");
    expect(t.execCalls).toHaveLength(1);
    const sent = t.execCalls[0];
    expect(sent?.workdir).toBe("/work");
    expect(sent?.environment).toEqual({
      TOKEN: "openshell:resolve:env:v3_TOKEN",
      PLAIN: "literal",
    });
    expect(sent?.timeoutSeconds).toBe(30);
    expect(sent?.stdin && dec(sent.stdin)).toBe("piped-in");
  });
});

describe("OpenShellSandboxAdapter.execSandbox — fail-closed before any RPC", () => {
  it("denies a bad AgentContext and does NOT call ExecSandbox", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.execSandbox({ not: "a context" }, "sbx-os-anything", ["ls"]);

    expect(res.status).toBe("denied");
    expect(res.event.result).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("denies an unknown sandbox id (no mapping) and issues NO RPC (deny-by-default)", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.execSandbox(GOOD_CTX, "sbx-os-never-created", ["ls"]);

    expect(res.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("denies an invalid (empty) sandbox id and issues NO RPC", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);

    const res = await adapter.execSandbox(GOOD_CTX, "", ["ls"]);

    expect(res.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });
});

describe("OpenShellSandboxAdapter.execSandbox — adversarial fail-closed (never fabricate success)", () => {
  it("denies (fail-closed) when the stream closes WITHOUT an exit event — never invents exit 0", async () => {
    const t = execTransport({
      // stdout arrived but the stream closed before the terminal ExecSandboxExit.
      execEvents: [stdoutEvent("partial output")],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["sleep"]);

    expect(res.status).toBe("denied");
    if (res.status !== "denied") throw new Error("unreachable");
    // Must NOT fabricate a zero exit; the reason names the missing terminal exit.
    expect(res.reason.toLowerCase()).toContain("exit");
  });

  it("denies (fail-closed, does NOT throw) when the exec stream errors before exit, leaking no secret", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = "https://super-secret-gateway.internal:8443";
    const t = execTransport({
      execEvents: [stdoutEvent("x"), new Error(`stream RST_STREAM ${secret}`)],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["cmd"]);

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

  it("denies (fail-closed) when execSandbox itself throws synchronously (transport refused)", async () => {
    const t = execTransport({ execReject: new Error("UNAVAILABLE") });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["cmd"]);

    expect(res.status).toBe("denied");
  });

  it("denies (fail-closed) when the deadline elapses before an exit event is observed", async () => {
    vi.useFakeTimers();
    try {
      let sawAbort = false;
      const t: OpenShellExecTransport = {
        health: () => Promise.resolve({ ok: true }),
        createSandbox: () =>
          Promise.resolve({ sandbox: { metadata: { name: "os-sbx-slow", id: "sbxid-slow" } } }),
        deleteSandbox: () => Promise.resolve({ deleted: true }),
        // Yields one chunk then hangs forever — only the deadline can resolve this. The signal MUST
        // be aborted when the deadline fires (real cancellation, design §3.4).
        execSandbox(
          _req: ExecSandboxRequest,
          signal?: AbortSignal,
        ): AsyncIterable<ExecSandboxEvent> {
          signal?.addEventListener("abort", () => {
            sawAbort = true;
          });
          return {
            async *[Symbol.asyncIterator](): AsyncIterator<ExecSandboxEvent> {
              yield stdoutEvent("starting");
              await new Promise<never>(() => {}); // never settles
            },
          };
        },
      };
      const adapter = new OpenShellSandboxAdapter(t);
      const id = await createMapped(adapter);

      const pending = adapter.execSandbox(GOOD_CTX, id, ["sleep"], { deadlineMs: 500 });
      await vi.advanceTimersByTimeAsync(600);
      const res = await pending;

      expect(res.status).toBe("denied");
      // The deadline MUST really cancel the underlying stream (not just race a Promise).
      expect(sawAbort).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("denies (fail-closed) when total output would exceed the byte cap — never OOMs / truncates", async () => {
    // Two 4-byte chunks then (would-be) exit; cap at 6 bytes => overflow on the 2nd chunk => deny.
    const t = execTransport({
      execEvents: [stdoutEvent("aaaa"), stdoutEvent("bbbb"), exitEvent(0)],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["yes"], { maxOutputBytes: 6 });

    expect(res.status).toBe("denied");
    if (res.status !== "denied") throw new Error("unreachable");
    // Must NOT return a truncated success; the reason names the byte cap.
    expect(res.reason.toLowerCase()).toContain("bytes");
    // The overflowing stream is cancelled.
    expect(t.execSignals[0]?.aborted).toBe(true);
  });

  it("passes an AbortSignal to the transport and aborts it once the exec completes", async () => {
    const t = execTransport({ execEvents: [stdoutEvent("ok"), exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["echo"]);

    expect(res.status).toBe("ok");
    // A signal is supplied (design §3.4 cancellation budget) and aborted on the completion path.
    expect(t.execSignals[0]).toBeInstanceOf(AbortSignal);
    expect(t.execSignals[0]?.aborted).toBe(true);
  });
});

describe("isExecEnvValueAllowed — placeholder grammar (unit, fail-closed)", () => {
  it("accepts plain literals with no reserved marker", () => {
    expect(isExecEnvValueAllowed("literal")).toBe(true);
    expect(isExecEnvValueAllowed("")).toBe(true);
    expect(isExecEnvValueAllowed("/usr/local/bin")).toBe(true);
  });

  it("accepts well-formed rev0 and revisioned placeholders", () => {
    expect(isExecEnvValueAllowed("openshell:resolve:env:TOKEN")).toBe(true);
    expect(isExecEnvValueAllowed("openshell:resolve:env:v3_TOKEN")).toBe(true);
    expect(isExecEnvValueAllowed("openshell:resolve:env:v12_MY_KEY_2")).toBe(true);
  });

  it("rejects the alias marker form and any marker-bearing non-placeholder", () => {
    expect(isExecEnvValueAllowed("X-OPENSHELL-RESOLVE-ENV-TOKEN")).toBe(false);
    expect(isExecEnvValueAllowed("OPENSHELL-RESOLVE-ENV-TOKEN")).toBe(false);
  });

  it("rejects an empty placeholder (prefix only, no KEY)", () => {
    expect(isExecEnvValueAllowed("openshell:resolve:env:")).toBe(false);
  });

  it("rejects the prefix embedded mid-string and non-env-key characters", () => {
    expect(isExecEnvValueAllowed("prefix-openshell:resolve:env:v1_TOKEN-suffix")).toBe(false);
    expect(isExecEnvValueAllowed("openshell:resolve:env:BAD-KEY")).toBe(false); // '-' not an env char
    expect(isExecEnvValueAllowed("openshell:resolve:env: TOKEN")).toBe(false); // space not env char
  });

  it("treats `v0_TOKEN` as a valid rev0 KEY (SecretResolver omits `v0_`; the value is still a safe placeholder ref)", () => {
    // rev0 emits `openshell:resolve:env:<KEY>` with no version segment, so `v0_TOKEN` is just a KEY
    // made of legal env chars — it is a placeholder reference, never a raw secret, so it is accepted.
    expect(isExecEnvValueAllowed("openshell:resolve:env:v0_TOKEN")).toBe(true);
    expect(isExecEnvValueAllowed("openshell:resolve:env:v_TOKEN")).toBe(true);
  });
});

describe("OpenShellSandboxAdapter.execSandbox — credentials never enter exec env in the clear", () => {
  it("denies an env value carrying the alias credential marker (plaintext, not a placeholder), no RPC", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    // The alias marker form (secrets.rs:10 PROVIDER_ALIAS_MARKER) is NOT a well-formed
    // `openshell:resolve:env:` placeholder — it must never be forwarded as a literal env value.
    const res = await adapter.execSandbox(GOOD_CTX, id, ["env"], {
      env: { SNEAKY: "X-OPENSHELL-RESOLVE-ENV-TOKEN" },
    });

    expect(res.status).toBe("denied");
    if (res.status !== "denied") throw new Error("unreachable");
    expect(res.reason.toLowerCase()).toContain("credential");
    // Fail-closed BEFORE the RPC: the command must never be dispatched with a smuggled credential.
    expect(t.execCalls).toHaveLength(0);
  });

  it("denies an env value with the placeholder prefix embedded mid-string (not a clean prefix), no RPC", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["env"], {
      env: { SNEAKY: "prefix-openshell:resolve:env:v1_TOKEN-suffix" },
    });

    expect(res.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("ACCEPTS a clean revision-0 placeholder (no v0_ prefix) — fail-closed guard must not over-reject", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["env"], {
      // revision==0 form: `openshell:resolve:env:<KEY>` (design §2.3, secrets.rs:487-493).
      env: { TOKEN: "openshell:resolve:env:TOKEN" },
    });

    expect(res.status).toBe("ok");
    expect(t.execCalls).toHaveLength(1);
    expect(t.execCalls[0]?.environment?.TOKEN).toBe("openshell:resolve:env:TOKEN");
  });
});

describe("OpenShellSandboxAdapter.execSandbox — malformed inputs fail closed (never throw), no RPC", () => {
  // The port accepts untrusted JS callers; a malformed cmd/opts must DENY before any RPC, not throw.
  // biome-ignore lint/suspicious/noExplicitAny: deliberately exercising untrusted/garbled JS inputs.
  const bad = (v: unknown): any => v;

  it("denies an empty command array", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, []);

    expect(res.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("denies a non-string-array command without throwing", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, bad([1, 2, 3]));

    expect(res.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("denies a non-array command (preflight, no zod iteration) without throwing", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, bad("not-an-array"));

    expect(res.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("denies a huge sparse argv via the length preflight (no full-array spread)", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    // A sparse array of 100M slots: the length preflight rejects it before any per-element work.
    const sparse: unknown[] = [];
    sparse.length = 100_000_000;
    const res = await adapter.execSandbox(GOOD_CTX, id, bad(sparse));

    expect(res.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("treats null opts as no-options (default caps) — ok, not a fail-closed deny", async () => {
    const t = execTransport({ execEvents: [stdoutEvent("hi"), exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["echo"], bad(null));

    expect(res.status).toBe("ok");
    expect(t.execCalls).toHaveLength(1);
  });

  it("denies a null / non-string-valued env without throwing (no Object.values crash)", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const resNull = await adapter.execSandbox(GOOD_CTX, id, ["env"], bad({ env: null }));
    const resNum = await adapter.execSandbox(GOOD_CTX, id, ["env"], bad({ env: { K: 5 } }));

    expect(resNull.status).toBe("denied");
    expect(resNum.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("denies a non-finite maxOutputBytes (the OOM cap can never be disabled with Infinity/NaN)", async () => {
    const t = execTransport({ execEvents: [stdoutEvent("x"), exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const resInf = await adapter.execSandbox(
      GOOD_CTX,
      id,
      ["x"],
      bad({ maxOutputBytes: Number.POSITIVE_INFINITY }),
    );
    const resNaN = await adapter.execSandbox(
      GOOD_CTX,
      id,
      ["x"],
      bad({ maxOutputBytes: Number.NaN }),
    );

    expect(resInf.status).toBe("denied");
    expect(resNaN.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("denies an unknown extra option (strict schema, no silent pass-through)", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["x"], bad({ tty: true }));

    expect(res.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("denies (does NOT throw) when an opts property getter throws during validation", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const hostile = {
      get env(): Record<string, string> {
        throw new Error("hostile getter");
      },
    };
    // Must NOT propagate the getter's throw across the port boundary.
    const res = await adapter.execSandbox(GOOD_CTX, id, ["x"], bad(hostile));

    expect(res.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("denies (does NOT throw) when a Proxy trap throws during validation", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile trap");
        },
      },
    );
    const res = await adapter.execSandbox(GOOD_CTX, id, ["x"], bad(hostile));

    expect(res.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });
});

describe("OpenShellSandboxAdapter.execSandbox — oversized request inputs deny before RPC", () => {
  it("denies an argv with too many entries", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, new Array(5000).fill("a"));

    expect(res.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("denies an argv whose joined bytes exceed the cap", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["x", "y".repeat(2 * 1024 * 1024)]);

    expect(res.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("denies an oversized stdin payload", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["x"], {
      stdin: new Uint8Array(9 * 1024 * 1024),
    });

    expect(res.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });

  it("denies an oversized env entry and an out-of-range timeout", async () => {
    const t = execTransport({ execEvents: [exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const resEnv = await adapter.execSandbox(GOOD_CTX, id, ["x"], {
      env: { K: "v".repeat(200 * 1024) },
    });
    const resTimeout = await adapter.execSandbox(GOOD_CTX, id, ["x"], {
      timeoutSeconds: 48 * 60 * 60,
    });

    expect(resEnv.status).toBe("denied");
    expect(resTimeout.status).toBe("denied");
    expect(t.execCalls).toHaveLength(0);
  });
});

describe("OpenShellSandboxAdapter.execSandbox — malformed stream frames fail closed (never success)", () => {
  it("denies a frame mixing exit + bytes (oneof violated) — never accepts it as success", async () => {
    const t = execTransport({
      // A garbled frame carrying BOTH an exit and stdout bytes violates the proto oneof.
      execEvents: [{ exit: { exitCode: 0 }, stdout: { data: enc("x") } }],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["x"]);

    expect(res.status).toBe("denied");
  });

  it("denies an empty frame (no oneof variant set)", async () => {
    const t = execTransport({ execEvents: [{}, exitEvent(0)] });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["x"]);

    expect(res.status).toBe("denied");
  });

  it("denies a stdout frame whose data is not a Uint8Array (garbled chunk)", async () => {
    const t = execTransport({
      // biome-ignore lint/suspicious/noExplicitAny: deliberately garbled wire frame.
      execEvents: [{ stdout: { data: "not-bytes" as any } }, exitEvent(0)],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["x"]);

    expect(res.status).toBe("denied");
  });

  it("denies a non-integer exit code (no truncation/coercion to a fake success)", async () => {
    const t = execTransport({
      // biome-ignore lint/suspicious/noExplicitAny: deliberately garbled exit code.
      execEvents: [{ exit: { exitCode: 1.5 as any } }],
    });
    const adapter = new OpenShellSandboxAdapter(t);
    const id = await createMapped(adapter);

    const res = await adapter.execSandbox(GOOD_CTX, id, ["x"]);

    expect(res.status).toBe("denied");
  });
});
