/**
 * SLICE-EXEC1 — exec-backed governed effect (RED-first).
 *
 * Proves the exec primitive end of the substrate port + the credential-blind, fail-closed, capped
 * `makeExecEffect` against the in-memory Fake. Secrets are RUNTIME-BUILT here (never literal in source,
 * so scan_secrets.sh stays clean) — `sk-` + a generated suffix matches audit/redact's high-signal
 * SECRET_VALUE shape, so the repo's real `redactSecrets`-based detector flags them.
 *
 * HONEST BOUNDARY: EXEC1 = port + Fake + credential-blind exec effect, in-repo, Fake-proven. Real
 * OpenShell `ExecSandbox` wiring = EXEC2; DHB3 closed-loop real-output feedback = EXEC3.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../audit/index.js";
import { type CommitAppender, commitBeforeEffect } from "../../commitgate/index.js";
import type { EffectResult } from "../../orchestration/index.js";
import type { SecretDetector } from "../brain/index.js";
import {
  type ExecCapableSandboxAdapter,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  NullSandboxAdapter,
  makeExecEffect,
} from "./index.js";

const ctx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

/** The repo's real detector (same construction as every bootstrap): secret-shaped iff redact changes it. */
const detectSecret: SecretDetector = (v) => JSON.stringify(redactSecrets(v)) !== JSON.stringify(v);

/** Runtime-built secret canary that matches audit/redact's `sk-...` SECRET_VALUE shape. */
function secretCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`; // 24 alnum chars after sk- => matches /sk-[A-Za-z0-9]{16,}/
}

/** A governed tool call carrying the exec spec the effect derives argv/env from. */
function execCall(args: { argv: readonly string[]; env?: Record<string, string> }) {
  return { tool: "exec", context: ctx, args };
}

/** Create + return the SandboxId of a live Fake sandbox so execSandbox has a known id to target. */
async function liveFakeSandbox(fake: FakeSandboxAdapter): Promise<string> {
  const created = await fake.createSandbox(ctx, { image: "x" });
  if (created.status !== "ok") throw new Error("fake create failed");
  return created.sandboxId;
}

describe("RED1 happy path — Fake exec ok -> EffectResult ok with redacted output + exit code", () => {
  it("maps an ok exec to EffectResult{ok:true} whose detail carries exit=0 and the output", async () => {
    const fake = new FakeSandboxAdapter({
      exec: () => ({
        ok: true,
        exitCode: 0,
        stdout: "hello world\n",
        stderr: "",
        truncated: false,
      }),
    });
    const sandboxId = await liveFakeSandbox(fake);
    const effect = makeExecEffect(fake, sandboxId, { detectSecret });

    const res: EffectResult = await effect(execCall({ argv: ["echo", "hello world"] }));
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("exit=0");
    expect(res.detail).toContain("hello world");
  });
});

describe("RED2 credential-blind INPUT — raw secret in exec env -> deny, execSandbox NEVER called", () => {
  it("denies (ok:false) and does not call execSandbox when an env VALUE is secret-shaped", async () => {
    let execCalls = 0;
    const fake = new FakeSandboxAdapter({
      exec: () => {
        execCalls += 1;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false };
      },
    });
    const sandboxId = await liveFakeSandbox(fake);
    const effect = makeExecEffect(fake, sandboxId, { detectSecret });

    const res = await effect(execCall({ argv: ["printenv"], env: { TOKEN: secretCanary() } }));
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("credential-blind");
    expect(execCalls).toBe(0); // raw secret NEVER reached the substrate/process
  });

  it("ALLOWS a placeholder/bundleRef env value (exec runs)", async () => {
    let execCalls = 0;
    const fake = new FakeSandboxAdapter({
      exec: () => {
        execCalls += 1;
        return { ok: true, exitCode: 0, stdout: "ok", stderr: "", truncated: false };
      },
    });
    const sandboxId = await liveFakeSandbox(fake);
    const effect = makeExecEffect(fake, sandboxId, { detectSecret });

    const res = await effect(execCall({ argv: ["printenv"], env: { TOKEN: "bundleRef:cred-1" } }));
    expect(res.ok).toBe(true);
    expect(execCalls).toBe(1);
  });
});

describe("RED3 credential-blind OUTPUT — stdout echoes a secret canary -> redacted out of detail", () => {
  it("redactSecrets the stdout before it reaches EffectResult.detail (canary absent)", async () => {
    const canary = secretCanary();
    const fake = new FakeSandboxAdapter({
      exec: () => ({
        ok: true,
        exitCode: 0,
        stdout: `leaked token: ${canary}\n`,
        stderr: `also here: ${canary}`,
        truncated: false,
      }),
    });
    const sandboxId = await liveFakeSandbox(fake);
    const effect = makeExecEffect(fake, sandboxId, { detectSecret });

    const res = await effect(execCall({ argv: ["cat", "secret.txt"] }));
    expect(res.ok).toBe(true);
    expect(res.detail).toBeDefined();
    expect(res.detail).not.toContain(canary);
    expect(res.detail).toContain("[REDACTED]");
  });
});

describe("RED4 fail-closed — failed/no-terminal-exit exec -> EffectResult ok:false, NEVER a fake exit 0", () => {
  it("maps ExecResult{ok:false} (no terminal exit) to EffectResult{ok:false}", async () => {
    const fake = new FakeSandboxAdapter({
      exec: () => ({ ok: false, reason: "exec stream ended before terminal exit (fail-closed)" }),
    });
    const sandboxId = await liveFakeSandbox(fake);
    const effect = makeExecEffect(fake, sandboxId, { detectSecret });

    const res = await effect(execCall({ argv: ["flaky-cmd"] }));
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("fail-closed");
    // honesty: a failed exec must NOT be reported as a successful exit 0.
    expect(res.detail).not.toContain("exit=0");
  });

  it("NullSandboxAdapter.execSandbox is fail-closed deny -> EffectResult{ok:false}", async () => {
    const nul: ExecCapableSandboxAdapter = new NullSandboxAdapter();
    const direct: ExecResult = await nul.execSandbox(ctx, "sbx-anything", { argv: ["echo", "x"] });
    expect(direct.ok).toBe(false);

    const effect = makeExecEffect(nul, "sbx-anything", { detectSecret });
    const res = await effect(execCall({ argv: ["echo", "x"] }));
    expect(res.ok).toBe(false);
  });
});

describe("RED5 output cap — huge stdout -> detail truncated to <= cap with a [truncated] marker", () => {
  it("caps the redacted combined output to maxOutputBytes and marks it truncated", async () => {
    const huge = "x".repeat(200_000); // > 64KB
    const fake = new FakeSandboxAdapter({
      exec: () => ({ ok: true, exitCode: 0, stdout: huge, stderr: "", truncated: false }),
    });
    const sandboxId = await liveFakeSandbox(fake);
    const cap = 65_536;
    const effect = makeExecEffect(fake, sandboxId, { detectSecret, maxOutputBytes: cap });

    const res = await effect(execCall({ argv: ["dump"] }));
    expect(res.ok).toBe(true);
    expect(res.detail).toBeDefined();
    expect(Buffer.byteLength(res.detail ?? "", "utf8")).toBeLessThanOrEqual(cap);
    expect(res.detail).toContain("[truncated]");
  });
});

describe("RED6 commit-before-effect — exec runs ONLY as the effect (0 calls when commit aborts)", () => {
  it("a rejecting appender aborts the commit, so the exec effect never invokes execSandbox", async () => {
    let execCalls = 0;
    const fake = new FakeSandboxAdapter({
      exec: () => {
        execCalls += 1;
        return { ok: true, exitCode: 0, stdout: "ran", stderr: "", truncated: false };
      },
    });
    const sandboxId = await liveFakeSandbox(fake);
    const effect = makeExecEffect(fake, sandboxId, { detectSecret });

    // execSandbox the Fake created the sandbox once (createSandbox), reset the EXEC counter only.
    execCalls = 0;

    const failAppender: CommitAppender<unknown, { sequence: number }> = {
      append: async () => {
        throw new Error("kernel unavailable");
      },
    };

    const committed = await commitBeforeEffect({
      appender: failAppender,
      event: { kind: "tool-invocation", tool: "exec", context: ctx },
      effect: () => effect(execCall({ argv: ["echo", "x"] })),
    });

    expect(committed.status).toBe("aborted");
    expect(execCalls).toBe(0); // aborted commit => the exec effect (and execSandbox) never ran
  });
});

describe("ExecCommandSpec is boundary-validated (zod) — malformed spec is fail-closed at the port", () => {
  it("Fake execSandbox denies a spec with an empty argv (fail-closed, never throws across the port)", async () => {
    const fake = new FakeSandboxAdapter({
      exec: () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false }),
    });
    const sandboxId = await liveFakeSandbox(fake);
    const bad = { argv: [] } as unknown as ExecCommandSpec;
    const res = await fake.execSandbox(ctx, sandboxId, bad);
    expect(res.ok).toBe(false);
  });
});

describe("DEFAULT detector (PRODUCTION) — makeExecEffect with NO detectSecret opt uses redactSecrets-changed", () => {
  it("denies a raw secret in env via the default detector, and never calls execSandbox", async () => {
    let execCalls = 0;
    const fake = new FakeSandboxAdapter({
      exec: () => {
        execCalls += 1;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false };
      },
    });
    const sandboxId = await liveFakeSandbox(fake);
    // NO detectSecret opt -> the production default (redactSecrets-changed) runs.
    const effect = makeExecEffect(fake, sandboxId);

    const res = await effect(execCall({ argv: ["printenv"], env: { TOKEN: secretCanary() } }));
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("credential-blind");
    expect(execCalls).toBe(0); // default detector flagged the raw secret before any exec
  });

  it("ALLOWS a non-secret bundleRef/placeholder via the default detector (exec runs) — default is NOT vacuous", async () => {
    let execCalls = 0;
    const fake = new FakeSandboxAdapter({
      exec: () => {
        execCalls += 1;
        return { ok: true, exitCode: 0, stdout: "ok", stderr: "", truncated: false };
      },
    });
    const sandboxId = await liveFakeSandbox(fake);
    const effect = makeExecEffect(fake, sandboxId); // NO detectSecret opt -> production default.

    const res = await effect(execCall({ argv: ["printenv"], env: { TOKEN: "bundleRef:cred-1" } }));
    expect(res.ok).toBe(true);
    expect(execCalls).toBe(1); // a non-secret reference is NOT flagged -> the default is not always-true
  });
});

describe("THROWING detector — fail-closed: a detector that throws is treated as 'secret present' (deny)", () => {
  it("denies (ok:false) and never calls execSandbox when the injected detector throws", async () => {
    let execCalls = 0;
    const fake = new FakeSandboxAdapter({
      exec: () => {
        execCalls += 1;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false };
      },
    });
    const sandboxId = await liveFakeSandbox(fake);
    const effect = makeExecEffect(fake, sandboxId, {
      detectSecret: () => {
        throw new Error("boom");
      },
    });

    const res = await effect(execCall({ argv: ["printenv"], env: { TOKEN: "anything" } }));
    expect(res.ok).toBe(false); // deny-by-default: a detector error is never let through
    expect(res.detail).toContain("credential-blind");
    expect(execCalls).toBe(0);
  });
});
