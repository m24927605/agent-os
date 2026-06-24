import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redactSecrets } from "../../audit/index.js";
import { makeExecEffect } from "../substrate/index.js";
import {
  OpenShellSandboxAdapter,
  createOpenShellGrpcTransport,
  makeOpenShellExecCapable,
} from "./index.js";

/**
 * SLICE-EXEC2 GATED live test — drives a REAL command in a REAL OpenShell sandbox through the FULL
 * EXEC1/EXEC2 stack: the real `OpenShellSandboxAdapter` (mTLS gRPC transport to the running gateway) is
 * wrapped by `makeOpenShellExecCapable` into the buffered `ExecCapableSandboxAdapter`, then driven by the
 * credential-blind `makeExecEffect`. This is the EXEC2 honest claim made REAL: the streaming exec, once
 * reconciled to the buffered port, returns real {exitCode, stdout, stderr} through the governed effect
 * (redacted + capped) — exactly what EXEC3's DHB3 closed loop will feed back to Hermes.
 *
 * Flow: createSandbox (REAL CreateSandbox; populates refById) -> awaitReady (poll to READY) ->
 * makeExecEffect(wrapper).exec a benign real command -> assert EffectResult{ok:true} whose redacted,
 * capped detail carries "hello" + "exit=0" (real output came back through the buffered reconcile) ->
 * destroySandbox (DeleteSandbox) in afterAll (no leaked sandbox). Bounded timeouts; never hangs.
 *
 * ⚠️ HONEST BOUNDARY: this is a SANDBOX command (create/exec/delete) against the user's OpenShell
 * gateway — it has REAL side effects (a real sandbox is created + a real command runs + it is deleted),
 * which is why it is GATED + user-initiated. It is credential-blind: the mTLS materials are read from the
 * OpenShell CLI's local store (never inlined, never committed); no Agent OS secret is placed in the
 * command env. EXEC2 = reconcile + this gated live harness; DHB3 closed-loop real-output feedback = EXEC3.
 *
 * SKIPPED unless `AGENTOS_LIVE_OPENSHELL=1` (it self-creates, so no sandbox env is needed), so
 * `pnpm run verify` stays hermetic. Run via the live harness:
 *   AGENTOS_LIVE_OPENSHELL=1 pnpm run e2e:live-substrate-exec
 */
const ON = process.env.AGENTOS_LIVE_OPENSHELL === "1";
const d = ON ? describe : describe.skip;

const CTX = {
  actorId: "agent:exec2-live",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live",
  requestId: "req-exec2-live-1",
};

/** The empirically-confirmed openclaw boot image (pinned @sha256 digest; passes assertPinnedImageDigest). */
const SANDBOX_IMAGE =
  "ghcr.io/nvidia/openshell-community/sandboxes/openclaw@sha256:c116946b3f9e84791630f21f115ac35c9c9f669af70ec0eef3035d79833a9550";

const mtls = join(homedir(), ".config/openshell/gateways/openshell/mtls");

/** The repo's real detector (same construction as every bootstrap): secret-shaped iff redact changes it. */
const detectSecret = (v: unknown): boolean =>
  JSON.stringify(redactSecrets(v)) !== JSON.stringify(v);

d(
  "EXEC2 — makeExecEffect over makeOpenShellExecCapable runs a REAL command in a REAL sandbox (create -> exec -> delete)",
  () => {
    let adapter: OpenShellSandboxAdapter;
    let sandboxId: string;

    beforeAll(async () => {
      const transport = createOpenShellGrpcTransport({
        endpoint: "127.0.0.1:17670",
        caCertPath: join(mtls, "ca.crt"),
        clientCertPath: join(mtls, "tls.crt"),
        clientKeyPath: join(mtls, "tls.key"),
        deadlineMs: 15_000,
      });
      adapter = new OpenShellSandboxAdapter(transport);
      // REAL CreateSandbox — no seed. The response populates refById; exec/delete resolve it.
      const created = await adapter.createSandbox(CTX, { image: SANDBOX_IMAGE });
      expect(created.status).toBe("ok");
      if (created.status !== "ok") throw new Error(`create denied: ${created.reason}`);
      sandboxId = created.sandboxId;
      // Poll readiness to READY via the adapter's getSandbox path (bounded; fail-closed on timeout).
      const deadline = Date.now() + 120_000;
      for (;;) {
        const verdict = await adapter.awaitReady(CTX, sandboxId, { deadlineMs: 2_000 });
        if (verdict.status === "ok") break;
        if (Date.now() >= deadline) throw new Error("sandbox did not reach READY (fail-closed)");
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }, 180_000);

    afterAll(async () => {
      // Clean up — no leaked sandbox. Destroy is best-effort (errors swallowed) but always attempted.
      if (sandboxId !== undefined) await adapter.destroySandbox(CTX, sandboxId).catch(() => {});
    }, 60_000);

    it("returns real stdout + a zero exit through the buffered reconcile + the governed effect", async () => {
      // Wrap the REAL streaming adapter as the buffered port, then drive it with the credential-blind
      // effect — exactly the production path EXEC3 will reuse.
      const wrapper = makeOpenShellExecCapable(adapter);
      const effect = makeExecEffect(wrapper, sandboxId);

      const res = await effect({
        context: CTX,
        // A benign real command: emit on stdout AND stderr and exit 0.
        args: { argv: ["sh", "-c", "echo hello; echo err 1>&2; exit 0"], timeoutMs: 15_000 },
      });

      expect(res.ok).toBe(true);
      expect(res.detail).toBeDefined();
      // Real output came back through the streaming->buffered reconcile, redacted + capped by the effect.
      expect(res.detail).toContain("hello");
      expect(res.detail).toContain("exit=0");
    }, 30_000);
  },
);
