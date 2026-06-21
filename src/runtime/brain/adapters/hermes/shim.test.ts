/**
 * HermesBrainShim adapter — behavioural + adversarial RED tests (R11-S2).
 *
 * Maps Hermes's real conversation-turn shape (verified from /tmp/hermes-agent-probe/run_agent.py:
 * tool_calls collected as `{name, arguments}` at :1635-1647) onto the vendor-neutral BrainAdapter
 * port: tool_calls -> ToolCall, plan narration -> PlanStep, ~/.hermes memory/skill write intents ->
 * MemoryMutation/SkillMutation (emit-only; the governed pipeline Appends-to-WORM first).
 *
 * The real Hermes process / live model egress is replaced by an injected in-process HermesTurnSource
 * (R9 Python shim + R1 land the live wire), so the contract runs with no I/O. These tests assert:
 * the credential-blind shim strips Hermes's client-held api_key (run_agent.py:346/421 anti-pattern —
 * the HermesTurn type has NO api_key field and the shim never forwards one), fail-closed on bad ctx
 * (yield nothing), turnSource-throw terminates the stream, and every emitted event carries a valid
 * AgentContext. Secret-shape args are caught by the existing governBrainStream guard (proving the
 * shim composes with the credential guard, not that it re-implements it).
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../../audit/redact.js";
import { BrainEvent as BrainEventSchema, governBrainStream } from "../../index.js";
import { HermesBrainShim, type HermesTurn, type HermesTurnSource } from "./index.js";

const validCtx = {
  actorId: "agent:hermes",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

const detectSecret = (value: unknown): boolean =>
  JSON.stringify(redactSecrets(value)) !== JSON.stringify(value);

/** An in-process HermesTurnSource double scripted with a fixed list of Hermes-style turns. */
class ScriptedTurnSource implements HermesTurnSource {
  constructor(private readonly scripted: HermesTurn[]) {}
  async *turns(_intent: string): AsyncIterable<HermesTurn> {
    for (const t of this.scripted) yield t;
  }
}

/** A turn source whose iteration throws — exercises the shim's fail-closed turn-source error path. */
class ThrowingTurnSource implements HermesTurnSource {
  turns(): AsyncIterable<HermesTurn> {
    return {
      [Symbol.asyncIterator]() {
        throw new Error("hermes runtime down");
      },
    };
  }
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("HermesBrainShim — turn -> BrainEvent mapping", () => {
  it("maps a turn's toolCalls to ToolCall events (kind/tool/args, carrying ctx)", async () => {
    const shim = new HermesBrainShim(
      new ScriptedTurnSource([
        { toolCalls: [{ tool: "send_email", args: { to: "x@example.com" } }] },
      ]),
    );
    const events = await collect(shim.execute(validCtx, "do a thing"));
    const tc = events.find((e) => e.kind === "tool-call");
    expect(tc).toBeDefined();
    if (tc && tc.kind === "tool-call") {
      expect(tc.tool).toBe("send_email");
      expect(tc.args).toEqual({ to: "x@example.com" });
      expect(`${tc.context.tenantId}`).toBe("tenant-a");
    }
  });

  it("maps planText -> PlanStep and memoryOps/skillOps -> Memory/SkillMutation (emit-only)", async () => {
    const shim = new HermesBrainShim(
      new ScriptedTurnSource([
        {
          planText: "first I will read the repo",
          memoryOps: [{ operation: "write", key: "fact-1" }],
          skillOps: [{ operation: "create", skillId: "skill-1" }],
        },
      ]),
    );
    const events = await collect(shim.execute(validCtx, "intent"));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("plan-step");
    expect(kinds).toContain("memory-mutation");
    expect(kinds).toContain("skill-mutation");
    const mem = events.find((e) => e.kind === "memory-mutation");
    if (mem && mem.kind === "memory-mutation") {
      expect(mem.operation).toBe("write");
      expect(mem.key).toBe("fact-1");
    }
  });

  it("every emitted event is schema-valid and carries the caller's context", async () => {
    const shim = new HermesBrainShim(
      new ScriptedTurnSource([
        { planText: "plan" },
        { toolCalls: [{ tool: "echo", args: { v: 1 } }] },
      ]),
    );
    const events = await collect(shim.execute(validCtx, "hello"));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      BrainEventSchema.parse(e); // throws if malformed
      expect(`${e.context.tenantId}`).toBe("tenant-a");
    }
  });
});

describe("HermesBrainShim — fail-closed (deny-by-default)", () => {
  it("yields NO events on a malformed AgentContext (never acts on an unidentified caller)", async () => {
    const shim = new HermesBrainShim(
      new ScriptedTurnSource([{ toolCalls: [{ tool: "t", args: {} }] }]),
    );
    for (const bad of [{}, null, { tenantId: "" }, { tenantId: "t" }]) {
      const events = await collect(shim.execute(bad, "x"));
      expect(events).toEqual([]);
    }
  });

  it("a throwing HermesTurnSource terminates the stream without yielding an ok event", async () => {
    const shim = new HermesBrainShim(new ThrowingTurnSource());
    const events = await collect(shim.execute(validCtx, "x"));
    expect(events).toEqual([]);
  });
});

describe("HermesBrainShim — credential-blind (the Hermes api_key channel, stripped)", () => {
  // Secret-shaped canary built at runtime (NOT a source literal, so secret-scan stays clean),
  // smuggled inside an innocuous toolCall arg — the by-shape exfiltration case.
  const secretArg = { note: `the key is sk-${"d".repeat(24)}` };

  it("a secret-shaped toolCall arg is DENIED by governBrainStream and stops the stream", async () => {
    const shim = new HermesBrainShim(
      new ScriptedTurnSource([
        { planText: "ok step" },
        { toolCalls: [{ tool: "leak", args: secretArg }] },
        { toolCalls: [{ tool: "after", args: { ok: true } }] },
      ]),
    );
    const results = await collect(governBrainStream(shim.execute(validCtx, "x"), detectSecret));
    expect(results.map((r) => r.status)).toEqual(["ok", "denied"]); // 3rd event never surfaced
    const okTools = results.filter((r) => r.event.kind === "tool-call" && r.status === "ok");
    expect(okTools).toEqual([]);
  });

  it("a HermesTurn with a client-held api_key forwards NO key into any emitted event", async () => {
    // The shim must IGNORE an api_key even when a (malicious/legacy) turn carries one: the
    // HermesTurn contract has no api_key field, and the shim maps only tool/args/plan/ops.
    const apiKeyCamel = `sk-${"a".repeat(24)}`;
    const apiKeySnake = `sk-${"b".repeat(24)}`;
    const turnWithKey = {
      apiKey: apiKeyCamel,
      api_key: apiKeySnake,
      toolCalls: [{ tool: "send", args: { bundleRef: "github:PAT:prod" } }],
    } as unknown as HermesTurn;
    const shim = new HermesBrainShim(new ScriptedTurnSource([turnWithKey]));
    const events = await collect(shim.execute(validCtx, "x"));
    const serialized = JSON.stringify(events);
    // Neither the key VALUES nor the key FIELD NAMES survive into any emitted event: the shim reads
    // only tool/args/plan/ops, so Hermes's client-held api_key channel is structurally stripped.
    expect(serialized).not.toContain(apiKeyCamel);
    expect(serialized).not.toContain(apiKeySnake);
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("apiKey");
    // the legitimate bundleRef arg still flows through
    const tc = events.find((e) => e.kind === "tool-call");
    if (tc && tc.kind === "tool-call") expect(tc.args).toEqual({ bundleRef: "github:PAT:prod" });
  });
});
