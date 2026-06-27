/**
 * SLICE-ACT1 (RED-first) — the ActionBinding port + FakeActionConnector + bindingWrappedActionEffect +
 * buildActionProjectionForCall, the SIBLING of the exec family for NON-argv app/API actions (gmail/drive).
 *
 * This file proves the PORT + EFFECT EDGE + PROJECTION HELPER as pure units (no pipeline, no subprocess):
 *   - the effect edge: no-binding deny / strict-schema deny / credential-blind INPUT guard deny / valid
 *     -> descriptor built in ONE place + delegate to the connector (env is placeholder-only);
 *   - the projection helper: 3 gates (scope -> actionProjector -> strict-validate), projector emits ONLY
 *     safe-derived fields (networkHosts/operationClass/destructiveFlags), NEVER params;
 *   - NON-VACUITY: a mutation skipping the INPUT guard flips the literal-secret test RED; skipping the
 *     no-binding deny flips the unbound test RED.
 *
 * Fake connector ONLY — NO real MCP / OAuth / network. The end-to-end join through the REAL pipeline lives
 * in `action-join.test.ts`. HONEST BOUNDARY: ACT1 is the governed PORT + fake + contract; the real send +
 * OAuth/SecretResolver-at-egress + MCP transport are deploy/EXEC2-gated/BLOCKED.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { redactSecrets } from "../../../../audit/index.js";
import type { GovernanceProjection } from "../../../../policy/index.js";
import { defaultExecSecretDetector } from "../../../substrate/index.js";
import {
  type ActionBinding,
  type ActionConnector,
  type ActionDescriptor,
  type ActionResult,
  FakeActionConnector,
  bindingWrappedActionEffect,
} from "./action-closed-loop.js";
import { buildActionProjectionForCall } from "./action-projection-for-call.js";
import {
  GMAIL_OAUTH_KEY_ENV,
  driveReadBinding,
  driveReadManifest,
  gmailSendBinding,
  gmailSendManifest,
  seedActionBindings,
  seedActionRegistry,
} from "./action-seed-tools.js";

const validCtx = {
  actorId: "agent:hermes",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

/** Runtime-built secret canary matching audit/redact's `sk-...` shape (NOT a source literal). */
function secretCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`; // 24 alnum chars => matches /sk-[A-Za-z0-9]{16,}/
}

/** The action-family wired set: egress-allowlist + approval (so gmail.send registers). */
const ACTION_WIRED = new Set(["egress-allowlist", "approval"] as const);

// ==================================================================================================
// RED1 — port/effect edge: deny-by-default (no binding), strict deny (extra key), INPUT-guard deny
//        (literal secret), valid (descriptor built in ONE place + Fake.invoke receives it).
// ==================================================================================================
describe("ACT1 — bindingWrappedActionEffect: deny-by-default / strict / credential-blind / valid", () => {
  it("(a) an UNBOUND tool denies deny-by-default and NEVER calls connector.invoke", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    const res = await effect({ tool: "action.unbound", context: validCtx, args: { to: "x" } });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("no action binding");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("(b) gmail.send + an EXTRA key (bcc) -> strict argSchema denies; connector NEVER called", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    const res = await effect({
      tool: "gmail.send",
      context: validCtx,
      // `bcc` is NOT in the strict {to,subject,body} schema — a smuggled extra channel.
      args: { to: "a@b.com", subject: "hi", body: "hello", bcc: "evil@x.com" },
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("invalid action args");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("(c) gmail.send with a LITERAL secret in body -> credential-blind INPUT guard denies; NEVER called", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    const canary = secretCanary();
    const res = await effect({
      tool: "gmail.send",
      context: validCtx,
      args: { to: "a@b.com", subject: "hi", body: `here is my key ${canary} bye` },
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("credential-blind");
    // NON-VACUITY: a mutation skipping the INPUT guard would let this reach the connector -> length 1.
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("(d) a VALID gmail.send -> descriptor built in ONE place + connector receives it; env placeholder-only", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    // SLICE-CRED-ONELEVEL: the binding's toCredentialEnv keys by the CONSTANT NAME
    // (GMAIL_OAUTH_KEY_ENV = "AGENTOS_GMAIL_OAUTH_KEY"), NOT by any env value — so the descriptor env is
    // ALWAYS the one-level placeholder, independent of process.env. (The token itself lives in that env
    // var at egress; only the PLACEHOLDER ever rides the descriptor.)
    const res = await effect({
      tool: "gmail.send",
      context: validCtx,
      args: { to: "a@b.com", subject: "hi", body: "hello world" },
    });
    expect(res.ok).toBe(true);
    expect(fake.invokeCalls.length).toBe(1);
    const desc = fake.invokeCalls[0]?.descriptor as ActionDescriptor;
    // service/method are composer-fixed (NEVER brain-supplied).
    expect(desc.service).toBe("gmail");
    expect(desc.method).toBe("send");
    // params are the structured body the binding's toParams built (NO command-string).
    expect(desc.params).toEqual({ to: "a@b.com", subject: "hi", body: "hello world" });
    // env is the ONE-LEVEL placeholder, keyed by the constant NAME — NEVER a literal token.
    expect(desc.env).toEqual({
      [GMAIL_OAUTH_KEY_ENV]: `openshell:resolve:env:${GMAIL_OAUTH_KEY_ENV}`,
    });
    const envValues = Object.values(desc.env ?? {});
    expect(envValues.length).toBeGreaterThanOrEqual(1);
    for (const v of envValues) {
      expect(v.startsWith("openshell:resolve:env:")).toBe(true);
      // a placeholder is NOT secret-shaped (the INPUT guard let it through).
      expect(defaultExecSecretDetector(v)).toBe(false);
    }
  });

  it("(g) ONE-LEVEL: the descriptor env is the placeholder keyed by the constant NAME, regardless of process.env", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    // Even with AGENTOS_GMAIL_OAUTH_KEY UNSET in process.env, the descriptor env is the one-level
    // placeholder (the binding keys by the CONSTANT, not the env value). The token's presence/absence is
    // resolved by the TRANSPORT at egress (fail-closed there), not by the descriptor builder here.
    const prev = process.env[GMAIL_OAUTH_KEY_ENV];
    delete process.env[GMAIL_OAUTH_KEY_ENV];
    try {
      const res = await effect({
        tool: "gmail.send",
        context: validCtx,
        args: { to: "a@b.com", subject: "hi", body: "hello" },
      });
      expect(res.ok).toBe(true);
      const desc = fake.invokeCalls[0]?.descriptor as ActionDescriptor;
      expect(desc.env).toEqual({
        [GMAIL_OAUTH_KEY_ENV]: `openshell:resolve:env:${GMAIL_OAUTH_KEY_ENV}`,
      });
    } finally {
      if (prev !== undefined) process.env[GMAIL_OAUTH_KEY_ENV] = prev;
    }
  });

  it("(e) a LITERAL secret smuggled via the toCredentialEnv path -> INPUT guard denies; NEVER called", async () => {
    const fake = new FakeActionConnector();
    const canary = secretCanary();
    // A rogue binding whose composer-built env carries a literal secret — the INPUT guard must DENY it
    // BEFORE the connector, exactly like makeExecEffect's env guard.
    const leakBinding: ActionBinding = {
      service: "leak",
      method: "x",
      argSchema: z.object({ k: z.string() }).strict(),
      toParams: (a) => ({ k: (a as { k: string }).k }),
      toCredentialEnv: () => ({ TOKEN: canary }),
      actionProjector: (): GovernanceProjection => ({
        version: 1,
        operationClass: "action:leak.x",
        argv0: "leak.x",
        argc: 0,
        argvRedacted: [],
        truncated: false,
        usesShellInterpreter: false,
        networkHosts: ["leak.example"],
        destructiveFlags: [],
        writeTargets: [],
      }),
    };
    const bindings = new Map<string, ActionBinding>([["leak.x", leakBinding]]);
    const effect = bindingWrappedActionEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const res = await effect({ tool: "leak.x", context: validCtx, args: { k: "ok" } });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("credential-blind");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("(f) drive.read valid -> connector receives {service:'drive', method:'read', params:{fileId}}", async () => {
    const fake = new FakeActionConnector();
    const effect = bindingWrappedActionEffect(fake, seedActionBindings(ACTION_WIRED), {
      detectSecret: defaultExecSecretDetector,
    });
    const res = await effect({
      tool: "drive.read",
      context: validCtx,
      args: { fileId: "file-123" },
    });
    expect(res.ok).toBe(true);
    expect(fake.invokeCalls.length).toBe(1);
    const desc = fake.invokeCalls[0]?.descriptor as ActionDescriptor;
    expect(desc.service).toBe("drive");
    expect(desc.method).toBe("read");
    expect(desc.params).toEqual({ fileId: "file-123" });
  });
});

// ==================================================================================================
// RED2 — buildActionProjectionForCall: 3 gates (scope -> actionProjector -> strict-validate). The
//        projector emits ONLY safe-derived fields (networkHosts non-empty), NEVER params.
// ==================================================================================================
describe("ACT1 — buildActionProjectionForCall: 3 gates, host-only projection, NO params", () => {
  const lookup = (name: string) => seedActionRegistry(ACTION_WIRED).lookup(name);

  it("gmail.send (in-scope, valid) -> projection with networkHosts=[gmail host]; NO params field", () => {
    const proj = buildActionProjectionForCall(
      { tool: "gmail.send", args: { to: "a@b.com", subject: "s", body: "b" } },
      seedActionBindings(ACTION_WIRED),
      lookup,
      "effectful",
    );
    expect(proj).toBeDefined();
    expect(proj?.networkHosts).toEqual(["gmail.googleapis.com"]);
    expect(proj?.operationClass).toContain("gmail");
    // The projection MUST NOT carry the brain's params (to/subject/body) anywhere.
    const blob = JSON.stringify(proj);
    expect(blob).not.toContain("a@b.com");
    expect(blob).not.toContain('"to"');
    expect(blob).not.toContain("subject");
    expect(blob).not.toContain("body");
  });

  it("drive.read (network-egress READ) is IN-SCOPE under effectful (CAP6: seal-punch always in-scope)", () => {
    const proj = buildActionProjectionForCall(
      { tool: "drive.read", args: { fileId: "file-1" } },
      seedActionBindings(ACTION_WIRED),
      lookup,
      "effectful",
    );
    expect(proj).toBeDefined();
    expect((proj?.networkHosts.length ?? 0) > 0).toBe(true);
  });

  it("INVALID args (extra key) -> the strict-validate gate yields undefined (no projection)", () => {
    const proj = buildActionProjectionForCall(
      { tool: "gmail.send", args: { to: "a@b.com", subject: "s", body: "b", bcc: "x" } },
      seedActionBindings(ACTION_WIRED),
      lookup,
      "effectful",
    );
    expect(proj).toBeUndefined();
  });

  it("an UNREGISTERED tool (no manifest) -> undefined (out-of-scope by construction)", () => {
    const proj = buildActionProjectionForCall(
      { tool: "action.nope", args: {} },
      seedActionBindings(ACTION_WIRED),
      lookup,
      "effectful",
    );
    expect(proj).toBeUndefined();
  });

  it("bindings undefined -> undefined (degrade, byte-identical for a surface without action bindings)", () => {
    const proj = buildActionProjectionForCall(
      { tool: "gmail.send", args: { to: "a@b.com", subject: "s", body: "b" } },
      undefined,
      lookup,
      "effectful",
    );
    expect(proj).toBeUndefined();
  });
});

// ==================================================================================================
// RED3 — registration: gmail.send registers in wired {egress-allowlist, approval}; missing EITHER throws.
// ==================================================================================================
describe("ACT1 — seedActionRegistry conditional registration (deny-by-default at registration)", () => {
  it("gmail.send + drive.read REGISTER when egress-allowlist + approval are both wired", () => {
    const reg = seedActionRegistry(ACTION_WIRED);
    expect(reg.lookup("gmail.send")?.name).toBe("gmail.send");
    expect(reg.lookup("drive.read")?.name).toBe("drive.read");
  });

  it("a registry MISSING approval refuses gmail.send (destructive needs approval) — assertRegisterable THROWS", () => {
    // egress-allowlist wired but NOT approval. gmail.send is destructive => requires approval => refused.
    expect(() => seedActionRegistry(new Set(["egress-allowlist"]))).toThrow();
  });

  it("a registry MISSING egress-allowlist refuses gmail.send (network-egress needs egress) — THROWS", () => {
    // approval wired but NOT egress-allowlist. gmail.send is network-egress => requires egress => refused.
    // (drive.read is also network-egress and would refuse too.)
    expect(() => seedActionRegistry(new Set(["approval"]))).toThrow();
  });

  it("the DEFAULT (no primitives wired) registers NEITHER gmail.send NOR drive.read (none present)", () => {
    // With no egress/approval wired, the conditional registration omits both — the registry is EMPTY of
    // action tools (not a throw, because nothing seal-punching is registered).
    const reg = seedActionRegistry(new Set());
    expect(reg.lookup("gmail.send")).toBeUndefined();
    expect(reg.lookup("drive.read")).toBeUndefined();
  });
});

// ==================================================================================================
// RED4 — manifests + bindings: contract sanity (destructive=>requiresApproval; composer-fixed identity).
// ==================================================================================================
describe("ACT1 — manifests + bindings contract", () => {
  it("gmail.send manifest is network-egress + destructive + requiresApproval:true + idempotent:false", () => {
    expect(gmailSendManifest.containment).toBe("network-egress");
    expect(gmailSendManifest.sideEffect).toBe("destructive");
    expect(gmailSendManifest.requiresApproval).toBe(true);
    expect(gmailSendManifest.idempotent).toBe(false);
  });

  it("drive.read manifest is network-egress + read + requiresApproval:false", () => {
    expect(driveReadManifest.containment).toBe("network-egress");
    expect(driveReadManifest.sideEffect).toBe("read");
    expect(driveReadManifest.requiresApproval).toBe(false);
  });

  it("the bindings carry composer-fixed service+method (brain never supplies them)", () => {
    expect(gmailSendBinding.service).toBe("gmail");
    expect(gmailSendBinding.method).toBe("send");
    expect(driveReadBinding.service).toBe("drive");
    expect(driveReadBinding.method).toBe("read");
  });

  it("FakeActionConnector returns a canned ActionResult and records the descriptor + context", async () => {
    const fake = new FakeActionConnector();
    const result: ActionResult = await fake.invoke(validCtx, {
      service: "gmail",
      method: "send",
      params: { to: "a", subject: "s", body: "b" },
    });
    expect(result.ok).toBe(true);
    expect(fake.invokeCalls.length).toBe(1);
    expect(fake.invokeCalls[0]?.context).toBe(validCtx);
    expect((fake.invokeCalls[0]?.descriptor as ActionDescriptor).service).toBe("gmail");
  });
});

// ==================================================================================================
// RED5 — credential-blind detector RECURSES over nested params (defense the action INPUT guard relies on)
// ==================================================================================================
describe("ACT1 — the reused detector recurses over nested params (the INPUT-guard guarantee)", () => {
  it("a literal secret nested in a params object is detected", () => {
    const canary = secretCanary();
    expect(defaultExecSecretDetector({ outer: { inner: [canary] } })).toBe(true);
    expect(defaultExecSecretDetector({ outer: { inner: ["clean"] } })).toBe(false);
    // sanity: redactSecrets really changes the canary-bearing blob (the detector's basis).
    expect(JSON.stringify(redactSecrets(canary))).not.toBe(JSON.stringify(canary));
  });
});
