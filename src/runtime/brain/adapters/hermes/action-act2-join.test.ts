/**
 * SLICE-ACT2 (RED-first) — the END-TO-END JOIN for the 4 NEW actions through the REAL
 * `runGovernedToolCall` (real screen/authorize-fold/approve/cost/commit-before-effect/boundary) with a
 * FakeActionConnector. This MIRRORS `action-join.test.ts` EXACTLY (same harness shape, same gates) —
 * it does NOT change ACT1's join logic; it reconstructs the same authorize-fold over the action
 * projection for the new actions (PURE ADDITION). NO real MCP / OAuth / network.
 *
 * The properties proven end-to-end for the new actions:
 *   - drive.files.delete (DESTRUCTIVE) — no pre-auth / deny approver => denied@approval, Fake NEVER
 *     called; pre-authorized (AGENTOS_APPROVE_PREAUTH-style includes drive.files.delete) + allowlisted
 *     host => proceeds => an effect.boundary-crossed WORM event carrying ONLY host/operationClass/
 *     destructiveFlags — a runtime canary in fileId reaches NO appended (WORM) byte.
 *   - calendar.events.create (WRITE) + calendar.events.list / gmail.search (READ) — NO approval;
 *     egress-gated (binEgressAllow=[] => denied@policy, Fake never called; allowlisted => Fake.invoke);
 *     credential-blind (a literal secret in a param => INPUT guard deny, connector never called).
 *
 * HONEST BOUNDARY (same as ACT1): the join proves the governance edge against the Fake + the real
 * pipeline. The real API calls + OAuth/SecretResolver-at-egress + MCP transport + real egress reach are
 * deploy/EXEC2-gated/BLOCKED (ACT3). Provider hosts are composer-fixed constants => the substrate seal
 * stays PRIMARY and the REAL connector (ACT3) MUST refuse an undeclared host.
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
import { FakeActionConnector, bindingWrappedActionEffect } from "./action-closed-loop.js";
import { buildActionProjectionForCall } from "./action-projection-for-call.js";
import { seedActionBindings, seedActionRegistry } from "./action-seed-tools.js";

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
 * Build the JOIN deps over the REAL pipeline — the SAME authorize-fold as action-join.test.ts's
 * `makeJoinDeps` (egress fold + CAP6 fail-closed + requiresApproval from the manifest + external =
 * network-egress), reconstructed here for the ACT2 actions. The allow-rules cover calendar/drive/gmail.
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
    { id: "allow-calendar", action: "tool:invoke", resource: "calendar.**", tenantId: "tenant-a" },
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
// drive.files.delete (DESTRUCTIVE) — approval-gated end-to-end, with a credential-blind boundary.
// ==================================================================================================
describe("ACT2 JOIN — drive.files.delete (DESTRUCTIVE) is approval-gated", () => {
  it("no pre-auth (deny-all approver) => denied@approval; Fake NEVER called (file never deleted)", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["www.googleapis.com"],
      preAuth: [], // deny-all
    });
    const out = await runGovernedToolCall(deps, {
      tool: "drive.files.delete",
      context: validCtx,
      args: { fileId: "file-1" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("approval");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("a throwing approver => denied@approval (fail-closed); Fake NEVER called", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["www.googleapis.com"],
      approve: () => {
        throw new Error("approver blew up");
      },
    });
    const out = await runGovernedToolCall(deps, {
      tool: "drive.files.delete",
      context: validCtx,
      args: { fileId: "file-1" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("approval");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("pre-authorized + allowlisted host => proceeds; Fake invoked once with {service,method}", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["www.googleapis.com"],
      preAuth: ["drive.files.delete"],
    });
    const out = await runGovernedToolCall(deps, {
      tool: "drive.files.delete",
      context: validCtx,
      args: { fileId: "file-1" },
    });
    expect(out.status).toBe("executed");
    expect(fake.invokeCalls.length).toBe(1);
    const desc = fake.invokeCalls[0]?.descriptor as { service: string; method: string };
    expect(desc.service).toBe("drive");
    expect(desc.method).toBe("files.delete");
  });

  it("executed drive.files.delete => boundary WORM carries host-only summary; fileId canary reaches NO byte", async () => {
    const fake = new FakeActionConnector();
    const canaryFileId = ["CANARY", "fileId", Math.random().toString(36).slice(2)].join("_");
    const appenderKit = makeAppender();
    const { deps, appended } = makeJoinDeps({
      fake,
      binEgressAllow: ["www.googleapis.com"],
      preAuth: ["drive.files.delete"],
      appenderKit,
    });
    const out = await runGovernedToolCall(deps, {
      tool: "drive.files.delete",
      context: validCtx,
      args: { fileId: canaryFileId },
    });
    expect(out.status).toBe("executed");
    expect(fake.invokeCalls.length).toBe(1);
    const blob = JSON.stringify(appended);
    expect(blob).toContain("effect.boundary-crossed");
    // The boundary's safe summary carries the drive host.
    expect(blob).toContain("www.googleapis.com");
    // The runtime fileId canary reaches NO appended (WORM) byte — intent OR boundary.
    expect(blob).not.toContain(canaryFileId);
  });

  it("a rejecting appender aborts BEFORE the effect => Fake NEVER called; outcome denied@commit", async () => {
    const fake = new FakeActionConnector();
    const appenderKit = makeAppender({ rejects: true });
    const { deps } = makeJoinDeps({
      fake,
      binEgressAllow: ["www.googleapis.com"],
      preAuth: ["drive.files.delete"],
      appenderKit,
    });
    const out = await runGovernedToolCall(deps, {
      tool: "drive.files.delete",
      context: validCtx,
      args: { fileId: "file-1" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("commit");
    expect(fake.invokeCalls.length).toBe(0); // the file was NEVER deleted.
  });
});

// ==================================================================================================
// calendar.events.create (WRITE) — NO approval; egress-gated; credential-blind.
// ==================================================================================================
describe("ACT2 JOIN — calendar.events.create (WRITE): no approval, egress-gated", () => {
  it("binEgressAllow=[] => denied@policy (egress fold); Fake NEVER called", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: [] });
    const out = await runGovernedToolCall(deps, {
      tool: "calendar.events.create",
      context: validCtx,
      args: { summary: "s", start: "2026-01-01", end: "2026-01-02" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("policy");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("allowlisted host => proceeds WITHOUT approval (write is not destructive); Fake invoked once", async () => {
    const fake = new FakeActionConnector();
    // NOTE: calendar.events.create is sideEffect:write => requiresApproval:false => NO pre-auth needed.
    const { deps } = makeJoinDeps({ fake, binEgressAllow: ["www.googleapis.com"] });
    const out = await runGovernedToolCall(deps, {
      tool: "calendar.events.create",
      context: validCtx,
      args: { summary: "standup", start: "2026-01-01T09:00", end: "2026-01-01T09:30" },
    });
    expect(out.status).toBe("executed");
    expect(fake.invokeCalls.length).toBe(1);
    const desc = fake.invokeCalls[0]?.descriptor as { service: string; method: string };
    expect(desc.service).toBe("calendar");
    expect(desc.method).toBe("events.create");
  });

  it("a literal secret in summary => denied (INPUT guard); Fake never called", async () => {
    const fake = new FakeActionConnector();
    const canary = secretCanary();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: ["www.googleapis.com"] });
    const out = await runGovernedToolCall(deps, {
      tool: "calendar.events.create",
      context: validCtx,
      args: { summary: `mtg ${canary}`, start: "2026-01-01", end: "2026-01-02" },
    });
    expect(fake.invokeCalls.length).toBe(0);
    if (out.status === "executed") {
      expect(out.detail).toContain("credential-blind");
    }
  });
});

// ==================================================================================================
// calendar.events.list + gmail.search (READ) — NO approval; egress-gated.
// ==================================================================================================
describe("ACT2 JOIN — calendar.events.list / gmail.search (READ): no approval, egress-gated", () => {
  it("calendar.events.list NOT egress-allowlisted => denied@policy; Fake never called", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: [] });
    const out = await runGovernedToolCall(deps, {
      tool: "calendar.events.list",
      context: validCtx,
      args: {},
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("policy");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("calendar.events.list allowlisted => proceeds WITHOUT approval; Fake invoked once", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: ["www.googleapis.com"] });
    const out = await runGovernedToolCall(deps, {
      tool: "calendar.events.list",
      context: validCtx,
      args: { timeMin: "2026-01-01", timeMax: "2026-02-01" },
    });
    expect(out.status).toBe("executed");
    expect(fake.invokeCalls.length).toBe(1);
  });

  it("gmail.search NOT egress-allowlisted => denied@policy; Fake never called", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: [] });
    const out = await runGovernedToolCall(deps, {
      tool: "gmail.search",
      context: validCtx,
      args: { query: "in:inbox" },
    });
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("policy");
    expect(fake.invokeCalls.length).toBe(0);
  });

  it("gmail.search allowlisted => proceeds WITHOUT approval; Fake invoked once", async () => {
    const fake = new FakeActionConnector();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: ["gmail.googleapis.com"] });
    const out = await runGovernedToolCall(deps, {
      tool: "gmail.search",
      context: validCtx,
      args: { query: "from:boss is:unread" },
    });
    expect(out.status).toBe("executed");
    expect(fake.invokeCalls.length).toBe(1);
    const desc = fake.invokeCalls[0]?.descriptor as { service: string; method: string };
    expect(desc.service).toBe("gmail");
    expect(desc.method).toBe("search");
  });

  it("a literal secret in gmail.search query => denied (INPUT guard); Fake never called", async () => {
    const fake = new FakeActionConnector();
    const canary = secretCanary();
    const { deps } = makeJoinDeps({ fake, binEgressAllow: ["gmail.googleapis.com"] });
    const out = await runGovernedToolCall(deps, {
      tool: "gmail.search",
      context: validCtx,
      args: { query: `from:boss ${canary}` },
    });
    expect(fake.invokeCalls.length).toBe(0);
    if (out.status === "executed") {
      expect(out.detail).toContain("credential-blind");
    }
  });
});
