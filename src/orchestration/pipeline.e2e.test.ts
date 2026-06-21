/**
 * END-TO-END composition proof: the 5 vendor-neutral ports wired into one governed intent->effect
 * pipeline, exercised with the REAL fake/in-tree implementations (not stubs). Proves the seams fit and
 * the short-circuits + commit-before-effect ordering hold BEFORE any real vendor adapter exists.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../audit/redact.js";
import type { CommitAppender } from "../commitgate/index.js";
import { InMemoryCostGate } from "../cost/index.js";
import { combineDecisions, evaluateSecondaries } from "../policy/dedup.js";
import { evaluatePolicy } from "../policy/evaluate.js";
import type { AllowRule, DenyRule, PolicyRequest } from "../policy/types.js";
import {
  ScriptedBrain,
  type SecretDetector,
  ToolCall,
  governBrainStream,
  screenBrainEvent,
} from "../runtime/brain/index.js";
import { FakeSandboxAdapter } from "../runtime/substrate/index.js";
import { runGovernedToolCall } from "./pipeline.js";

const ctx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

const detectSecret: SecretDetector = (v) => JSON.stringify(redactSecrets(v)) !== JSON.stringify(v);

function okAppender(): CommitAppender<unknown, { sequence: number }> {
  let seq = 0;
  return { append: async () => ({ sequence: ++seq }) };
}
const failAppender: CommitAppender<unknown, { sequence: number }> = {
  append: async () => {
    throw new Error("kernel unavailable");
  },
};

const allowAll: AllowRule[] = [{ id: "a1", action: "tool:invoke", resource: "*-prod" }];

/** A valid (context-branded) ToolCall built via the brain schema. */
function toolCall(args: Record<string, unknown> = { ok: true }): ToolCall {
  return ToolCall.parse({ kind: "tool-call", context: ctx, tool: "send-prod", args });
}

function makeDeps(opts: {
  allow?: AllowRule[];
  deny?: DenyRule[];
  secondaryAllows?: boolean;
  cost: InMemoryCostGate;
  appender: CommitAppender<unknown, { sequence: number }>;
  fake: FakeSandboxAdapter;
  estimate?: number;
}) {
  const ruleSet = { allow: opts.allow ?? [], deny: opts.deny ?? [] };
  const secondaries = opts.secondaryAllows
    ? [
        {
          evaluate: () => ({ effect: "allow" as const, reason: "agt: allow", auditRequired: true }),
        },
      ]
    : [];
  return {
    screen: (tc: ToolCall) => {
      const r = screenBrainEvent(tc, detectSecret);
      return r.status === "ok" ? { ok: true as const } : { ok: false as const, reason: r.reason };
    },
    authorize: (tc: ToolCall) => {
      const req = { ...tc.context, action: "tool:invoke", resource: tc.tool } as PolicyRequest;
      const combined = combineDecisions(
        evaluatePolicy(req, ruleSet),
        evaluateSecondaries(secondaries, req),
      );
      return { effect: combined.effect, reason: combined.reason };
    },
    cost: opts.cost,
    estimateTokens: () => opts.estimate ?? 10,
    appender: opts.appender,
    effect: async (tc: ToolCall) => {
      const res = await opts.fake.createSandbox(tc.context, { image: tc.tool });
      return { ok: res.status === "ok", detail: res.status };
    },
  };
}

describe("runGovernedToolCall — end-to-end composition over the real fakes", () => {
  it("HAPPY PATH: clean call + allow + budget + ok appender -> executed, effect ran", async () => {
    const fake = new FakeSandboxAdapter();
    const deps = makeDeps({
      allow: allowAll,
      cost: new InMemoryCostGate(1000),
      appender: okAppender(),
      fake,
    });
    const out = await runGovernedToolCall(deps, toolCall());
    expect(out.status).toBe("executed");
    expect((await fake.startSandbox(ctx, "sbx-fake-1")).status).toBe("ok"); // effect really ran
  });

  it("SCREEN short-circuit: a secret in args -> denied@screen, NO effect", async () => {
    const fake = new FakeSandboxAdapter();
    const deps = makeDeps({
      allow: allowAll,
      cost: new InMemoryCostGate(1000),
      appender: okAppender(),
      fake,
    });
    const out = await runGovernedToolCall(deps, toolCall({ note: `sk-${"d".repeat(24)}` }));
    expect(out).toMatchObject({ status: "denied", stage: "screen" });
    expect((await fake.startSandbox(ctx, "sbx-fake-1")).status).toBe("denied");
  });

  it("POLICY short-circuit: no allow rule -> denied@policy, NO effect", async () => {
    const fake = new FakeSandboxAdapter();
    const deps = makeDeps({
      allow: [],
      cost: new InMemoryCostGate(1000),
      appender: okAppender(),
      fake,
    });
    const out = await runGovernedToolCall(deps, toolCall());
    expect(out).toMatchObject({ status: "denied", stage: "policy" });
    expect((await fake.startSandbox(ctx, "sbx-fake-1")).status).toBe("denied");
  });

  it("PDP IS SOLE AUTHORITY: secondary allow + PDP deny -> denied@policy", async () => {
    const fake = new FakeSandboxAdapter();
    const deps = makeDeps({
      allow: [],
      secondaryAllows: true,
      cost: new InMemoryCostGate(1000),
      appender: okAppender(),
      fake,
    });
    expect(await runGovernedToolCall(deps, toolCall())).toMatchObject({
      status: "denied",
      stage: "policy",
    });
  });

  it("COST short-circuit: estimate over budget -> denied@cost, NO effect", async () => {
    const fake = new FakeSandboxAdapter();
    const deps = makeDeps({
      allow: allowAll,
      cost: new InMemoryCostGate(5),
      appender: okAppender(),
      fake,
      estimate: 50,
    });
    const out = await runGovernedToolCall(deps, toolCall());
    expect(out).toMatchObject({ status: "denied", stage: "cost" });
    expect((await fake.startSandbox(ctx, "sbx-fake-1")).status).toBe("denied");
  });

  it("COMMIT-BEFORE-EFFECT: appender rejects -> denied@commit, effect NEVER ran", async () => {
    const fake = new FakeSandboxAdapter();
    const deps = makeDeps({
      allow: allowAll,
      cost: new InMemoryCostGate(1000),
      appender: failAppender,
      fake,
    });
    const out = await runGovernedToolCall(deps, toolCall());
    expect(out).toMatchObject({ status: "denied", stage: "commit" });
    expect((await fake.startSandbox(ctx, "sbx-fake-1")).status).toBe("denied");
  });

  it("invocation count: the effect runs EXACTLY ONCE on the happy path, ZERO times on a short-circuit", async () => {
    // A counting effect catches a regression the startSandbox probe cannot (an effect that runs twice).
    let calls = 0;
    const countingEffect = async () => {
      calls++;
      return { ok: true };
    };
    const ok = {
      ...makeDeps({
        allow: allowAll,
        cost: new InMemoryCostGate(1000),
        appender: okAppender(),
        fake: new FakeSandboxAdapter(),
      }),
      effect: countingEffect,
    };
    expect((await runGovernedToolCall(ok, toolCall())).status).toBe("executed");
    expect(calls).toBe(1); // exactly once

    const denied = {
      ...makeDeps({
        allow: [],
        cost: new InMemoryCostGate(1000),
        appender: okAppender(),
        fake: new FakeSandboxAdapter(),
      }),
      effect: countingEffect,
    };
    await runGovernedToolCall(denied, toolCall());
    expect(calls).toBe(1); // unchanged — a denied call never invokes the effect
  });

  it("composes with governBrainStream: a clean brain stream drives executed tool calls", async () => {
    const fake = new FakeSandboxAdapter();
    const deps = makeDeps({
      allow: allowAll,
      cost: new InMemoryCostGate(1000),
      appender: okAppender(),
      fake,
    });
    const brain = new ScriptedBrain([
      (c) => ({ kind: "tool-call", context: c, tool: "send-prod", args: { ok: true } }),
    ]);
    const outcomes = [];
    for await (const screened of governBrainStream(brain.execute(ctx, "do it"), detectSecret)) {
      if (screened.status === "ok" && screened.event.kind === "tool-call") {
        outcomes.push(await runGovernedToolCall(deps, screened.event));
      }
    }
    expect(outcomes.map((o) => o.status)).toEqual(["executed"]);
  });
});
