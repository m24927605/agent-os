/**
 * Brain PORT CONTRACT + credential-blind enforcement.
 *
 * Pluggability: the contract runs over >=2 implementations (ScriptedBrain + EchoBrain). Safety: the
 * brain is untrusted and MUST stay credential-blind — a ToolCall carrying a literal secret is DENIED
 * before any effect. The secret detector is the repo's REAL one (audit/redact `redactSecrets`),
 * injected here, proving the guard integrates with actual secret detection (not a toy regex).
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../audit/redact.js";
import type { AgentContext } from "../iam/ids.js";
import { HermesBrainShim } from "../runtime/brain/adapters/hermes/index.js";
import {
  type BrainAdapter,
  type BrainEvent,
  BrainEvent as BrainEventSchema,
  EchoBrain,
  ScriptedBrain,
  governBrainStream,
  screenBrainEvent,
} from "../runtime/brain/index.js";

const validCtx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

// The repo's real secret detection, expressed as a boolean: a value contains a secret iff redacting
// it changes it.
const detectSecret = (value: unknown): boolean =>
  JSON.stringify(redactSecrets(value)) !== JSON.stringify(value);

async function collect(stream: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const ADAPTERS: { name: string; make: () => BrainAdapter }[] = [
  {
    name: "ScriptedBrain",
    make: () =>
      new ScriptedBrain([
        (ctx) => ({ kind: "plan-step", context: ctx, description: "do a thing" }),
        (ctx) => ({ kind: "tool-call", context: ctx, tool: "send", args: { to: "x" } }),
      ]),
  },
  { name: "EchoBrain", make: () => new EchoBrain() },
  {
    name: "HermesBrainShim",
    make: () =>
      new HermesBrainShim({
        async *turns() {
          yield { planText: "do a thing", toolCalls: [{ tool: "send", args: { to: "x" } }] };
        },
      }),
  },
];

describe.each(ADAPTERS)("BrainAdapter contract — $name", ({ make }) => {
  it("emits a stream of schema-valid BrainEvents, each carrying the caller's context", async () => {
    const events = await collect(make().execute(validCtx, "hello"));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      BrainEventSchema.parse(e); // throws if malformed
      expect(`${e.context.tenantId}`).toBe("tenant-a");
    }
  });

  it("is FAIL-CLOSED on a malformed AgentContext: yields NO events (never acts on an unidentified caller)", async () => {
    const events = await collect(make().execute({ tenantId: "" }, "hello"));
    expect(events).toEqual([]);
  });
});

describe("credential-blind enforcement (the untrusted brain must never emit a literal secret)", () => {
  // Secret-shaped canary built at runtime (NOT a source literal, so scan_secrets.sh stays clean)
  // hidden in an innocuously-named field — the scary exfiltration case (by-shape detection, not just
  // by-key-name). Matches the redact SECRET_VALUE pattern sk-[A-Za-z0-9]{16,} at runtime.
  const secretArgs = { note: `the key is sk-${"d".repeat(24)}` };

  it("screenBrainEvent DENIES a ToolCall whose args contain a secret-shaped value", () => {
    const ctx = validCtx as unknown as AgentContext;
    const evil = BrainEventSchema.parse({
      kind: "tool-call",
      context: ctx,
      tool: "exfiltrate",
      args: secretArgs,
    });
    const res = screenBrainEvent(evil, detectSecret);
    expect(res.status).toBe("denied");
    if (res.status === "denied") expect(res.reason).toContain("credential-blind");
  });

  it("DENIES (deny-by-default) when the secret detector itself throws", () => {
    const ctx = validCtx as unknown as AgentContext;
    const evt = BrainEventSchema.parse({ kind: "plan-step", context: ctx, description: "x" });
    const res = screenBrainEvent(evt, () => {
      throw new Error("detector blew up");
    });
    expect(res.status).toBe("denied");
    if (res.status === "denied") expect(res.reason).toMatch(/deny-by-default|fail-closed/i);
  });

  it("DENIES the secret-bearing ToolCall BEFORE any effect, and stops the stream (fail-closed)", async () => {
    const brain = new ScriptedBrain([
      (ctx) => ({ kind: "plan-step", context: ctx, description: "ok step" }),
      (ctx) => ({ kind: "tool-call", context: ctx, tool: "leak", args: secretArgs }),
      (ctx) => ({ kind: "tool-call", context: ctx, tool: "after", args: { ok: true } }),
    ]);
    const results = [];
    for await (const r of governBrainStream(brain.execute(validCtx, "x"), detectSecret)) {
      results.push(r);
    }
    expect(results.map((r) => r.status)).toEqual(["ok", "denied"]); // 3rd event never surfaced
    const okTools = results.filter((r) => r.event.kind === "tool-call" && r.status === "ok");
    expect(okTools).toEqual([]);
  });

  it("lets clean ToolCalls (bundleRef args, no literal secret) through", async () => {
    const brain = new ScriptedBrain([
      (ctx) => ({
        kind: "tool-call",
        context: ctx,
        tool: "send",
        args: { bundleRef: "github:PAT:prod" },
      }),
    ]);
    const results = [];
    for await (const r of governBrainStream(brain.execute(validCtx, "x"), detectSecret)) {
      results.push(r);
    }
    expect(results.map((r) => r.status)).toEqual(["ok"]);
  });
});
