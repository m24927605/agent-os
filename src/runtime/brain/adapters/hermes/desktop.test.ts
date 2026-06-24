/**
 * DesktopHermesTurnSource adapter — behavioural + adversarial RED tests (SLICE-DHB1).
 *
 * DHB1 connects the existing injected `HermesTurnSource` seam (shim.ts) to a *local desktop Hermes*
 * driven over ACP (Agent Client Protocol — JSON-RPC over stdio; the surface `hermes acp` exposes for
 * editor integration). A client sends `session/prompt(intent)` and receives streamed `session/update`
 * notifications; the relevant kinds are `agent_message_chunk` (a text chunk -> HermesTurn.planText)
 * and `tool_call` (a proposed tool name + raw input/args -> HermesTurn.toolCalls).
 *
 * DHB1 does NOT launch the real `hermes acp` subprocess (that is DHB2). It models the ACP
 * `session/update` FRAME shape (`AcpUpdateFrame`) and proves the mapping + security with an in-tree
 * Fake transport. These tests assert the three DHB1 claims:
 *   1. SEAM: a Fake-scripted plan + tool_call -> DesktopHermesTurnSource -> HermesBrainShim ->
 *      BrainEvent stream -> governBrainStream all pass (no deny).
 *   2. CREDENTIAL-BLIND: an ACP frame carrying an api_key/credential field NEVER appears in any
 *      emitted BrainEvent (structural + content); a tool_call whose args carry a LITERAL secret is
 *      DENIED @screen and STOPS the stream (the repo's real redactSecrets-based detector).
 *   3. FAIL-CLOSED: a malformed frame is skipped per-frame (the valid turns still flow); a transport
 *      that THROWS mid-stream stops the turn source — no ok turn is yielded after the throw.
 *
 * The real `hermes acp` stdio subprocess + the exact ACP dialect + propose-only live proof = DHB2.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../../audit/redact.js";
import { BrainEvent as BrainEventSchema, governBrainStream } from "../../index.js";
import {
  type AcpUpdateFrame,
  DesktopHermesTurnSource,
  FakeDesktopHermesTransport,
  HermesBrainShim,
  parseFrame,
} from "./index.js";

const validCtx = {
  actorId: "agent:hermes",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

// The repo's REAL detector (same one the shim tests + composition root wire): a value is secret-
// bearing iff redacting it changes its serialization. NOT re-implemented here — reused.
const detectSecret = (value: unknown): boolean =>
  JSON.stringify(redactSecrets(value)) !== JSON.stringify(value);

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("parseFrame — ACP session/update frame -> HermesTurn", () => {
  it("maps an agent_message_chunk frame to a {planText} turn", () => {
    const frame: AcpUpdateFrame = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "first I will read the repo" },
    };
    const turn = parseFrame(frame);
    expect(turn).not.toBeNull();
    expect(turn?.planText).toBe("first I will read the repo");
    expect(turn?.toolCalls).toBeUndefined();
  });

  it("maps a tool_call frame to a {toolCalls:[{tool,args}]} turn", () => {
    const frame: AcpUpdateFrame = {
      sessionUpdate: "tool_call",
      title: "send_email",
      rawInput: { to: "x@example.com" },
    };
    const turn = parseFrame(frame);
    expect(turn?.toolCalls).toEqual([{ tool: "send_email", args: { to: "x@example.com" } }]);
    expect(turn?.planText).toBeUndefined();
  });

  it("reads ONLY known fields — an api_key/credential field on the frame is never read", () => {
    const apiKeyValue = `sk-${"a".repeat(24)}`;
    const frame = {
      sessionUpdate: "tool_call",
      title: "send",
      rawInput: { bundleRef: "github:PAT:prod" },
      // adversarial extra fields the parser must IGNORE entirely:
      api_key: apiKeyValue,
      apiKey: apiKeyValue,
    } as unknown as AcpUpdateFrame;
    const turn = parseFrame(frame);
    // structural: the produced HermesTurn has only tool/args, no key field survives.
    const serialized = JSON.stringify(turn);
    expect(serialized).not.toContain(apiKeyValue);
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("apiKey");
    expect(turn?.toolCalls).toEqual([{ tool: "send", args: { bundleRef: "github:PAT:prod" } }]);
  });

  it("returns null (skipped) for a malformed / unknown frame — never throws", () => {
    expect(parseFrame({ sessionUpdate: "plan" } as AcpUpdateFrame)).toBeNull();
    expect(parseFrame({} as AcpUpdateFrame)).toBeNull();
    expect(parseFrame({ sessionUpdate: "tool_call" } as AcpUpdateFrame)).toBeNull();
    expect(parseFrame(null as unknown as AcpUpdateFrame)).toBeNull();
    expect(parseFrame("garbage" as unknown as AcpUpdateFrame)).toBeNull();
  });
});

describe("DesktopHermesTurnSource — seam: Fake ACP transport -> HermesBrainShim -> governed stream", () => {
  it("a scripted plan + tool_call flows through to governed BrainEvents (no deny)", async () => {
    const transport = new FakeDesktopHermesTransport([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "read the repo" } },
      { sessionUpdate: "tool_call", title: "open_pr", rawInput: { bundleRef: "github:PAT:prod" } },
    ]);
    const shim = new HermesBrainShim(new DesktopHermesTurnSource(transport));
    const results = await collect(
      governBrainStream(shim.execute(validCtx, "ship it"), detectSecret),
    );

    expect(results.every((r) => r.status === "ok")).toBe(true);
    const kinds = results.map((r) => r.event.kind);
    expect(kinds).toContain("plan-step");
    expect(kinds).toContain("tool-call");
    const tc = results.find((r) => r.event.kind === "tool-call");
    if (tc && tc.event.kind === "tool-call") {
      expect(tc.event.tool).toBe("open_pr");
      expect(tc.event.args).toEqual({ bundleRef: "github:PAT:prod" });
      expect(`${tc.event.context.tenantId}`).toBe("tenant-a");
    }
    for (const r of results) BrainEventSchema.parse(r.event);
  });
});

describe("DesktopHermesTurnSource — credential-blind (ACP api_key channel, stripped)", () => {
  it("an api_key-bearing frame forwards NO key into any emitted BrainEvent (structural + content)", async () => {
    // Secret canary built at runtime (NOT a source literal -> secret-scan stays clean).
    const apiKeyValue = `sk-${"a".repeat(24)}`;
    const transport = FakeDesktopHermesTransport.withApiKeyFrame(apiKeyValue);
    const shim = new HermesBrainShim(new DesktopHermesTurnSource(transport));
    const events = await collect(shim.execute(validCtx, "x"));

    const serialized = JSON.stringify(events);
    // content: neither the key VALUE nor the key FIELD NAMES survive into any emitted event.
    expect(serialized).not.toContain(apiKeyValue);
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("apiKey");
    // structural: the legitimate bundleRef arg still flows through.
    const tc = events.find((e) => e.kind === "tool-call");
    expect(tc).toBeDefined();
    if (tc && tc.kind === "tool-call") expect(tc.args).toEqual({ bundleRef: "github:PAT:prod" });
  });

  it("a tool_call whose args carry a LITERAL secret is DENIED @screen and stops the stream", async () => {
    const transport = FakeDesktopHermesTransport.withLiteralSecretToolCall();
    const shim = new HermesBrainShim(new DesktopHermesTurnSource(transport));
    const results = await collect(governBrainStream(shim.execute(validCtx, "x"), detectSecret));

    // the leak frame is denied, and the trailing valid frame never surfaces (stream stops).
    expect(results.map((r) => r.status)).toEqual(["ok", "denied"]);
    const okTools = results.filter((r) => r.event.kind === "tool-call" && r.status === "ok");
    expect(okTools).toEqual([]);
  });
});

describe("DesktopHermesTurnSource — fail-closed (deny-by-default)", () => {
  it("a malformed frame is skipped per-frame; the valid turns still flow", async () => {
    const transport = FakeDesktopHermesTransport.withMalformedBetweenValid();
    const shim = new HermesBrainShim(new DesktopHermesTurnSource(transport));
    const events = await collect(shim.execute(validCtx, "x"));

    // both valid frames (before AND after the malformed one) produced events: one frame's
    // malformedness does not poison the rest of the stream.
    const planSteps = events.filter((e) => e.kind === "plan-step");
    const toolCalls = events.filter((e) => e.kind === "tool-call");
    expect(planSteps.length).toBe(1);
    expect(toolCalls.length).toBe(1);
  });

  it("a transport that THROWS mid-stream stops the turn source — no ok turn after the throw", async () => {
    const transport = FakeDesktopHermesTransport.withThrowAfterFirst();
    const shim = new HermesBrainShim(new DesktopHermesTurnSource(transport));
    const events = await collect(shim.execute(validCtx, "x"));

    // the one valid pre-throw frame may yield; nothing AFTER the throw is yielded, and the
    // post-throw scripted tool_call (a recognisable marker) must be absent.
    const toolCalls = events.filter((e) => e.kind === "tool-call");
    expect(toolCalls).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("should_not_appear");
  });
});
