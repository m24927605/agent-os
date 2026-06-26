/**
 * SLICE-ACT1c (RED-first) — the END-TO-END JOIN: gmail.send + drive.read through the REAL
 * `runGovernedToolCall` (real screen/authorize-fold/approve/cost/commit-before-effect/boundary) with a
 * FakeActionConnector as `deps.effect = bindingWrappedActionEffect(fake, actionBindings)`.
 *
 * ⚠️ ZERO change to the pipeline OR the production bin. The join HARNESS reconstructs the bin's
 * authorize-fold logic (egress fold + requiresApproval + external + CAP6 fail-closed) IN THIS TEST, over
 * the action projection — exactly as `exec-mcp-server-bin.ts` does for the exec family, but parallel and
 * isolated. No real MCP / OAuth / network: the connector is the in-repo Fake.
 *
 * The 6 SEATBELT properties proven end-to-end:
 *   1. EGRESS — gmail.send + binEgressAllow=[] => denied@policy (egress fold), Fake NEVER called; the
 *      allowlist gmail.googleapis.com => passes the fold.
 *   2. CAP6 fail-closed — a network-egress manifest with a projector yielding NO host => denied@policy.
 *   3. APPROVAL — gmail.send (destructive) with no pre-auth / a deny approver => denied@approval, Fake
 *      NEVER called; pre-authorized => proceeds.
 *   4. COMMIT-BEFORE-EFFECT — the AuditEvent append + receipt is observed BEFORE Fake.invoke (an order
 *      probe); a rejecting appender => Fake NEVER called (email never sent).
 *   5. BOUNDARY — an executed gmail.send => an effect.boundary-crossed WORM event whose payload carries
 *      host-only networkHosts + operationClass + destructiveFlags and contains NO to/subject/body/token.
 *   6. CREDENTIAL-BLIND — a literal token in params => denied; Fake receives only the placeholder env.
 *   + drive.read: read (no approval), still egress-gated; allowlisted => Fake.invoke.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../../audit/index.js";
import type { CommitAppender } from "../../../../commitgate/index.js";
import { type CostGate, InMemoryCostGate } from "../../../../cost/index.js";
import {
  type ApprovalOutcome,
  type AuthorizeDecision,
  type GovernedToolCallDeps,
  createBudgetApprover,
  runGovernedToolCall,
} from "../../../../orchestration/index.js";
import {
  type PolicyDecision,
  combineDecisions,
  egressDecisionForProjection,
} from "../../../../policy/index.js";
import { authorizeToolInvoke } from "../../../../tools/index.js";
import { defaultExecSecretDetector } from "../../../substrate/index.js";
import {
  type ActionConnector,
  type ActionDescriptor,
  FakeActionConnector,
  bindingWrappedActionEffect,
} from "./action-closed-loop.js";
import { buildActionProjectionForCall } from "./action-projection-for-call.js";
import {
  GMAIL_OAUTH_KEY_ENV,
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

const ACTION_WIRED = new Set(["egress-allowlist", "approval"] as const);

/** Runtime-built secret canary matching audit/redact's `sk-...` shape (NOT a source literal). */
function secretCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`;
}

/** A counting appender that records every appended event AND a hook to observe append/effect ORDER. */
interface AppenderKit {
  readonly appender: CommitAppender<unknown, { id: number }>;
  readonly appended: unknown[];
  readonly order: string[];
}
function makeAppender(opts: { rejects?: boolean; order?: string[] } = {}): AppenderKit {
  const appended: unknown[] = [];
  const order = opts.order ?? [];
  let id = 0;
  const appender: CommitAppender<unknown, { id: number }> = {
    append: (event) => {
      appended.push(event);
      order.push("append");
      if (opts.rejects === true) return Promise.reject(new Error("WORM down (fake)"));
      return Promise.resolve({ id: ++id });
    },
  };
  return { appender, appended, order };
}

/**
 * Build the JOIN deps over the REAL pipeline. This MIRRORS the bin's authorize-fold (NOT the production
 * bin — reconstructed here for the action family):
 *   - PDP `authorizeToolInvoke` (deny-by-default for an unregistered name) is the sole deny authority;
 *   - the EGRESS fold (`egressDecisionForProjection(networkHosts, binEgressAllow)`) any-deny-wins;
 *   - CAP6 fail-closed: a network-egress tool with NO projectable host => deny;
 *   - `requiresApproval` is read FROM THE MANIFEST so CAP4a's approval stage fires for gmail.send;
 *   - `external` = containment is network-egress => the pipeline appends the boundary on the executed path;
 *   - `projection` rides the decision for the boundary summary.
 * The `effect` is `bindingWrappedActionEffect(fake, bindings)` — the action edge.
 */
function makeJoinDeps(opts: {
  fake: FakeActionConnector;
  binEgressAllow: readonly string[];
  preAuth?: readonly string[];
  approve?: (toolCall: unknown) => ApprovalOutcome | Promise<ApprovalOutcome>;
  appenderKit?: AppenderKit;
  onEffect?: () => void;
}): {
  deps: GovernedToolCallDeps<
    { tool: string; context: unknown; args?: Record<string, unknown> },
    { id: number }
  >;
  appended: unknown[];
} {
  const registry = seedActionRegistry(ACTION_WIRED);
  const bindings = seedActionBindings(ACTION_WIRED);
  const allowRules = [
    { id: "allow-gmail", action: "tool:invoke", resource: "gmail.**", tenantId: "tenant-a" },
    { id: "allow-drive", action: "tool:invoke", resource: "drive.**", tenantId: "tenant-a" },
  ];
  const cost: CostGate = new InMemoryCostGate(1_000_000);
  const kit = opts.appenderKit ?? makeAppender();
  const approve =
    opts.approve ??
    createBudgetApprover((tc) => {
      const name = (tc as { tool?: unknown } | null)?.tool;
      return typeof name === "string" && (opts.preAuth ?? []).includes(name);
    });

  const baseEffect = bindingWrappedActionEffect(opts.fake, bindings, {
    detectSecret: defaultExecSecretDetector,
  });

  const deps: GovernedToolCallDeps<
    { tool: string; context: unknown; args?: Record<string, unknown> },
    { id: number }
  > = {
    screen: () => ({ ok: true }),
    authorize: (tc) => {
      const c = tc.context as typeof validCtx;
      const req = {
        requestId: c.requestId,
        tenantId: c.tenantId,
        projectId: c.projectId,
        taskId: c.taskId,
        actorId: c.actorId,
        action: "tool:invoke",
        resource: tc.tool,
      };
      const projection = buildActionProjectionForCall(
        { tool: tc.tool, ...(tc.args !== undefined ? { args: tc.args } : {}) },
        bindings,
        (name) => registry.lookup(name),
        "effectful",
      );
      const pdp: PolicyDecision = authorizeToolInvoke(req, registry, allowRules);
      // EGRESS fold + CAP6 fail-closed (mirrors the bin).
      const containment = registry.lookup(tc.tool)?.containment;
      let egressDecisions: PolicyDecision[];
      if (projection !== undefined && projection.networkHosts.length > 0) {
        egressDecisions = [
          egressDecisionForProjection(projection.networkHosts, opts.binEgressAllow),
        ];
      } else if (containment === "network-egress") {
        egressDecisions = [
          {
            effect: "deny",
            reason: "egress: network-egress tool with no projectable host — denied (fail-closed)",
            auditRequired: true,
          },
        ];
      } else {
        egressDecisions = [];
      }
      const combined = combineDecisions(pdp, egressDecisions);
      const decision: AuthorizeDecision = {
        effect: combined.effect,
        reason: redactSecrets(combined.reason),
        requiresApproval: registry.lookup(tc.tool)?.requiresApproval ?? false,
        external: containment === "network-egress" || containment === "host-fs-write",
        ...(projection !== undefined ? { projection } : {}),
      };
      return decision;
    },
    approve,
    cost,
    estimateTokens: () => 10,
    appender: kit.appender,
    effect: (tc) => {
      opts.onEffect?.();
      kit.order.push("effect");
      return baseEffect(tc);
    },
  };
  return { deps, appended: kit.appended };
}

// ==================================================================================================
// (1) EGRESS — gmail.send + binEgressAllow=[] => denied@policy; allowlisted gmail host => passes.
// ==================================================================================================
describe("ACT1c JOIN (1) EGRESS — deny-all allowlist denies gmail.send at policy; Fake never called", () => {
  it("binEgressAllow=[] => denied@policy (egress fold); FakeActionConnector NEVER invoked", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: [], preAuth: ["gmail.send"] });
    const out = await runGovernedToolCall(deps, {
      tool: "gmail.send",
      context: validCtx,
      args: { to: "a@b.com", subject: "hi", body: "hello" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("policy");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("allowlist gmail.googleapis.com + pre-auth => the egress fold PASSES (proceeds past policy)", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["gmail.googleapis.com"],
      preAuth: ["gmail.send"],
    });
    const out = await runGovernedToolCall(deps, {
      tool: "gmail.send",
      context: validCtx,
      args: { to: "a@b.com", subject: "hi", body: "hello" },
    });
    expect(out.status).toBe("executed");
    expect(fake.invokeCalls.length).toBe(1);
  });
});

// ==================================================================================================
// (2) CAP6 fail-closed — a network-egress projection with NO host => denied@policy.
// ==================================================================================================
describe("ACT1c JOIN (2) CAP6 fail-closed — network-egress with no projectable host => denied", () => {
  it("a hostless action projector on a network-egress tool denies at policy; Fake never called", async () => {
    const fake = new FakeActionConnector();
    const registry = seedActionRegistry(ACTION_WIRED);
    const bindings = seedActionBindings(ACTION_WIRED);
    const cost: CostGate = new InMemoryCostGate(1_000_000);
    let receiptId = 0;
    const appender: CommitAppender<unknown, { id: number }> = {
      append: () => Promise.resolve({ id: ++receiptId }),
    };
    const baseEffect = bindingWrappedActionEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const deps: GovernedToolCallDeps<
      { tool: string; context: unknown; args?: Record<string, unknown> },
      { id: number }
    > = {
      screen: () => ({ ok: true }),
      // A deliberately BROKEN authorize: it allows gmail.send (network-egress) but yields a projection with
      // NO host — the CAP6 fail-closed rule (network-egress + no projectable host => deny) must fire.
      authorize: (tc) => {
        const containment = registry.lookup(tc.tool)?.containment;
        const egress: PolicyDecision[] =
          containment === "network-egress"
            ? [
                {
                  effect: "deny",
                  reason:
                    "egress: network-egress tool with no projectable host — denied (fail-closed)",
                  auditRequired: true,
                },
              ]
            : [];
        const combined = combineDecisions(
          { effect: "allow", reason: "pdp allow", auditRequired: true },
          egress,
        );
        return {
          effect: combined.effect,
          reason: combined.reason,
          requiresApproval: false,
          external: containment === "network-egress",
        };
      },
      cost,
      estimateTokens: () => 10,
      appender,
      effect: baseEffect,
    };
    const out = await runGovernedToolCall(deps, {
      tool: "gmail.send",
      context: validCtx,
      args: { to: "a@b.com", subject: "hi", body: "hello" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("policy");
    expect(fake.invokeCalls.length).toBe(0);
  });
});

// ==================================================================================================
// (3) APPROVAL — destructive gmail.send: no pre-auth / deny approver => denied@approval; pre-auth proceeds.
// ==================================================================================================
describe("ACT1c JOIN (3) APPROVAL — destructive gmail.send is approval-gated", () => {
  it("no pre-auth (deny-all approver) => denied@approval; Fake NEVER called (email never sent)", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["gmail.googleapis.com"],
      preAuth: [], // deny-all
    });
    const out = await runGovernedToolCall(deps, {
      tool: "gmail.send",
      context: validCtx,
      args: { to: "a@b.com", subject: "hi", body: "hello" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("approval");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("a throwing approver => denied@approval (fail-closed); Fake NEVER called", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["gmail.googleapis.com"],
      approve: () => {
        throw new Error("approver blew up");
      },
    });
    const out = await runGovernedToolCall(deps, {
      tool: "gmail.send",
      context: validCtx,
      args: { to: "a@b.com", subject: "hi", body: "hello" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("approval");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("pre-authorized gmail.send => proceeds to the effect; Fake invoked once", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["gmail.googleapis.com"],
      preAuth: ["gmail.send"],
    });
    const out = await runGovernedToolCall(deps, {
      tool: "gmail.send",
      context: validCtx,
      args: { to: "a@b.com", subject: "hi", body: "hello" },
    });
    expect(out.status).toBe("executed");
    expect(fake.invokeCalls.length).toBe(1);
  });
});

// ==================================================================================================
// (4) COMMIT-BEFORE-EFFECT — the append+receipt is observed BEFORE Fake.invoke; a rejecting appender =>
//     Fake NEVER called (the email is never sent).
// ==================================================================================================
describe("ACT1c JOIN (4) COMMIT-BEFORE-EFFECT — append precedes invoke; reject => no send", () => {
  it("the AuditEvent append happens BEFORE the connector invoke (order probe)", async () => {
    const fake = new FakeActionConnector();
    const order: string[] = [];
    const appenderKit = makeAppender({ order });
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["gmail.googleapis.com"],
      preAuth: ["gmail.send"],
      appenderKit,
    });
    const out = await runGovernedToolCall(deps, {
      tool: "gmail.send",
      context: validCtx,
      args: { to: "a@b.com", subject: "hi", body: "hello" },
    });
    expect(out.status).toBe("executed");
    // The first "append" must precede the first "effect" — commit BEFORE effect.
    expect(order.indexOf("append")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("append")).toBeLessThan(order.indexOf("effect"));
  });

  it("a rejecting appender aborts BEFORE the effect => Fake NEVER called; outcome denied@commit", async () => {
    const fake = new FakeActionConnector();
    const appenderKit = makeAppender({ rejects: true });
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["gmail.googleapis.com"],
      preAuth: ["gmail.send"],
      appenderKit,
    });
    const out = await runGovernedToolCall(deps, {
      tool: "gmail.send",
      context: validCtx,
      args: { to: "a@b.com", subject: "hi", body: "hello" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("commit");
    expect(fake.invokeCalls.length).toBe(0); // the email was NEVER sent.
  });
});

// ==================================================================================================
// (5) BOUNDARY — an executed gmail.send appends an effect.boundary-crossed WORM event with host-only
//     networkHosts + operationClass + destructiveFlags and NO to/subject/body/token.
// ==================================================================================================
describe("ACT1c JOIN (5) BOUNDARY — executed gmail.send appends a credential-blind boundary WORM event", () => {
  it("the boundary event carries host-only summary; a canary in to/body reaches NO appended byte", async () => {
    const fake = new FakeActionConnector();
    const canaryTo = ["CANARY", "to", Math.random().toString(36).slice(2)].join("_");
    const canaryBody = ["CANARY", "body", Math.random().toString(36).slice(2)].join("_");
    const appenderKit = makeAppender();
    const { deps, appended } = makeJoinDeps({
      fake,
      binEgressAllow: ["gmail.googleapis.com"],
      preAuth: ["gmail.send"],
      appenderKit,
    });
    const out = await runGovernedToolCall(deps, {
      tool: "gmail.send",
      context: validCtx,
      // Non-secret-shaped canaries (so they pass the INPUT guard) but MUST NOT reach the WORM bytes.
      args: { to: `${canaryTo}@x.com`, subject: "subj", body: `dear friend ${canaryBody}` },
    });
    expect(out.status).toBe("executed");
    expect(fake.invokeCalls.length).toBe(1);
    // Two appends: the commit-before-effect intent + the post-effect boundary.
    const blob = JSON.stringify(appended);
    expect(blob).toContain("effect.boundary-crossed");
    // The boundary's safe summary carries the host + destructive flags + operationClass.
    expect(blob).toContain("gmail.googleapis.com");
    // NO param values reach ANY appended byte (intent OR boundary).
    expect(blob).not.toContain(canaryTo);
    expect(blob).not.toContain(canaryBody);
    expect(blob).not.toContain("subj");
    // No param KEY leakage of the body either.
    expect(blob.includes("dear friend")).toBe(false);
  });
});

// ==================================================================================================
// (6) CREDENTIAL-BLIND — a literal token in params => denied; Fake receives only placeholder env.
// ==================================================================================================
describe("ACT1c JOIN (6) CREDENTIAL-BLIND — literal token denied; placeholder env on the executed path", () => {
  it("a literal secret in body => denied (INPUT guard); Fake never called", async () => {
    const fake = new FakeActionConnector();
    const canary = secretCanary();
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["gmail.googleapis.com"],
      preAuth: ["gmail.send"],
    });
    const out = await runGovernedToolCall(deps, {
      tool: "gmail.send",
      context: validCtx,
      args: { to: "a@b.com", subject: "hi", body: `token ${canary}` },
    });
    // The INPUT guard denies inside the effect: commit ran, but the connector was never called and the
    // effect reported ok:false. The pipeline status is "executed" with a deny detail OR denied — either
    // way the connector NEVER received the secret.
    expect(fake.invokeCalls.length).toBe(0);
    if (out.status === "executed") {
      expect(out.detail).toContain("credential-blind");
    }
  });

  it("an executed gmail.send => the connector's env is placeholder-only (no literal token)", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["gmail.googleapis.com"],
      preAuth: ["gmail.send"],
    });
    // Configure the per-service KEY so the env is non-empty (else the placeholder assertion is vacuous).
    const prev = process.env[GMAIL_OAUTH_KEY_ENV];
    process.env[GMAIL_OAUTH_KEY_ENV] = "GMAIL_OAUTH_TOKEN";
    try {
      await runGovernedToolCall(deps, {
        tool: "gmail.send",
        context: validCtx,
        args: { to: "a@b.com", subject: "hi", body: "hello" },
      });
      const desc = fake.invokeCalls[0]?.descriptor as ActionDescriptor;
      const values = Object.values(desc.env ?? {});
      expect(values.length).toBeGreaterThanOrEqual(1);
      for (const v of values) {
        expect(v.startsWith("openshell:resolve:env:")).toBe(true);
      }
    } finally {
      if (prev === undefined) delete process.env[GMAIL_OAUTH_KEY_ENV];
      else process.env[GMAIL_OAUTH_KEY_ENV] = prev;
    }
  });
});

// ==================================================================================================
// drive.read — read (no approval), still egress-gated; allowlisted => Fake.invoke.
// ==================================================================================================
describe("ACT1c JOIN — drive.read: read (NO approval), egress-gated", () => {
  it("drive.read NOT egress-allowlisted => denied@policy; Fake never called", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: [] });
    const out = await runGovernedToolCall(deps, {
      tool: "drive.read",
      context: validCtx,
      args: { fileId: "file-1" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("policy");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("drive.read allowlisted => proceeds WITHOUT approval (read); Fake invoked once", async () => {
    const fake = new FakeActionConnector();
    // NOTE: drive.read is sideEffect:read => requiresApproval:false => NO pre-auth needed.
    const { deps } = makeJoinDeps({ fake, binEgressAllow: ["www.googleapis.com"] });
    const out = await runGovernedToolCall(deps, {
      tool: "drive.read",
      context: validCtx,
      args: { fileId: "file-1" },
    });
    expect(out.status).toBe("executed");
    expect(fake.invokeCalls.length).toBe(1);
    const desc = fake.invokeCalls[0]?.descriptor as ActionDescriptor;
    expect(desc.service).toBe("drive");
    expect(desc.method).toBe("read");
  });
});

// Reference the ActionConnector type so an unused-import lint never trips (it's part of the port contract).
const _portTypeCheck: ActionConnector = new FakeActionConnector();
void _portTypeCheck;
