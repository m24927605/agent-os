/**
 * DesktopHermesTurnSource — a real `HermesTurnSource` for a LOCALLY-RUN desktop Hermes, driven over
 * ACP (Agent Client Protocol — the surface `hermes acp` exposes for editor integration: JSON-RPC over
 * stdio, where a client sends `session/prompt(intent)` and receives streamed `session/update`
 * notifications).
 *
 * This module supplies the LAST missing piece of the brain seam (shim.ts): a `HermesTurnSource` whose
 * turns come from a real local desktop Hermes rather than a hand-scripted double. It does so in three
 * decoupled parts:
 *   - `AcpUpdateFrame`  — a permissive shape for one ACP `session/update` frame.
 *   - `DesktopHermesTransport` — the injected port that submits an intent and streams back raw frames.
 *   - `parseFrame` + `DesktopHermesTurnSource` — map frames -> `HermesTurn`s, fail-closed.
 *
 * ⚠️ HONEST BOUNDARY (SLICE-DHB1): DHB1 does NOT launch the real `hermes acp` stdio subprocess and does
 * NOT bind the exact ACP message dialect — that (the live wire + `hermes acp --check` dialect
 * confirmation + propose-only proof) is DHB2. DHB1 proves the SEAM, credential-blindness, and
 * fail-closed behaviour against an in-tree Fake ACP transport. The dialect mapping below is kept
 * PERMISSIVE + fail-closed so the real dialect (confirmed in DHB2) drops in without weakening security.
 *
 * CREDENTIAL-BLIND: `parseFrame` reads ONLY the four known HermesTurn fields (planText/toolCalls/
 * memoryOps/skillOps). It NEVER reads an `api_key`/credential field off a frame — Hermes self-manages
 * a client-held key, but the `HermesTurn` contract has no such field, so it is structurally stripped
 * and can never reach a BrainEvent. A literal secret that nonetheless rides inside `args` is caught by
 * the existing `governBrainStream` guard layered above the shim (this module does not re-implement it).
 *
 * FAIL-CLOSED (deny-by-default): a malformed/unknown frame -> skipped (null), per-frame, never throws
 * and never poisons the rest of the stream; a transport that throws mid-stream -> the turn source stops
 * yielding (no partial/ok turn is emitted after an error).
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone (no-vendor-in-core compliant) and imports
 * ONLY the in-module shim types. Exported via the hermes barrel (index.ts), never the neutral brain barrel.
 */
import type { HermesToolCall, HermesTurn, HermesTurnSource } from "./shim.js";

/**
 * One ACP `session/update` notification frame, modelled permissively. A real frame is a loose JSON
 * object discriminated by `sessionUpdate`; it MAY carry arbitrary extra fields (including a
 * credential-looking `api_key`) which `parseFrame` IGNORES. The known kinds DHB1 maps:
 *   - `agent_message_chunk`: a text content chunk     -> HermesTurn.planText
 *   - `tool_call`:           a proposed tool + raw args -> HermesTurn.toolCalls
 * Any other kind (`tool_call_update`, `plan`, unknown) is tolerated and skipped.
 */
export interface AcpUpdateFrame {
  /** The ACP update discriminator (e.g. "agent_message_chunk", "tool_call", "plan", …). */
  readonly sessionUpdate?: string;
  /** For agent_message_chunk: the streamed content block ({ type: "text", text }). */
  readonly content?: { readonly type?: string; readonly text?: string } & Record<string, unknown>;
  /** For tool_call: the human-readable tool name/title. */
  readonly title?: string;
  /** For tool_call: an alternative tool identifier some dialects use. */
  readonly toolName?: string;
  /** For tool_call: the raw tool input/arguments. */
  readonly rawInput?: Record<string, unknown>;
  /** Permissive: a real frame may carry arbitrary extra fields, which the parser must ignore. */
  readonly [extra: string]: unknown;
}

/**
 * The injected transport port for a local desktop Hermes ACP session.
 *
 * Contract: `submit` sends ONLY the intent text (plus, if a dialect needs it, an AgentContext-derived
 * identity) into the local Hermes ACP session — it NEVER sends any Agent OS secret. It streams back the
 * raw `session/update` frames as they arrive. The real implementation (the `hermes acp` stdio
 * subprocess: initialize -> session/new -> session/prompt -> session/update) lands in DHB2; DHB1 wires
 * a Fake.
 */
export interface DesktopHermesTransport {
  submit(intent: string): AsyncIterable<AcpUpdateFrame>;
}

/** True iff `v` is a non-empty string. */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Map one ACP `session/update` frame to a `HermesTurn`, or `null` if the frame carries nothing this
 * adapter understands (fail-closed per-frame: NEVER throws, NEVER poisons the rest of the stream).
 *
 * Reads ONLY the known turn fields — an `api_key`/credential field on the frame is NEVER read, so
 * Hermes's client-held credential channel is structurally stripped before any BrainEvent exists.
 */
export function parseFrame(frame: AcpUpdateFrame): HermesTurn | null {
  if (frame === null || typeof frame !== "object") return null;

  switch (frame.sessionUpdate) {
    case "agent_message_chunk": {
      const text = frame.content?.text;
      return isNonEmptyString(text) ? { planText: text } : null;
    }
    case "tool_call": {
      const tool = isNonEmptyString(frame.title)
        ? frame.title
        : isNonEmptyString(frame.toolName)
          ? frame.toolName
          : undefined;
      if (tool === undefined) return null;
      // Read ONLY the tool name + its raw args. Any api_key/credential field on the frame is never
      // touched. args defaults to {} so a no-arg tool_call still maps cleanly.
      const args: Record<string, unknown> =
        frame.rawInput !== null && typeof frame.rawInput === "object" ? frame.rawInput : {};
      const toolCall: HermesToolCall = { tool, args };
      return { toolCalls: [toolCall] };
    }
    default:
      // Unknown / unsupported kind (tool_call_update, plan, …) or a malformed frame -> skipped.
      return null;
  }
}

/**
 * A real `HermesTurnSource` backed by a desktop Hermes ACP transport. `turns(intent)` submits the
 * intent to the transport, parses each streamed frame, and yields the non-null `HermesTurn`s.
 *
 * FAIL-CLOSED: a frame that parses to `null` is skipped (the stream continues); if the transport
 * throws mid-stream, iteration propagates the throw OUT of `turns` (it does not swallow it into an ok
 * turn), and the consuming `HermesBrainShim.execute` catches it to stop the BrainEvent stream
 * deny-by-default. No partial/ok turn is yielded after an error.
 */
export class DesktopHermesTurnSource implements HermesTurnSource {
  constructor(private readonly transport: DesktopHermesTransport) {}

  async *turns(intent: string): AsyncIterable<HermesTurn> {
    for await (const frame of this.transport.submit(intent)) {
      const turn = parseFrame(frame);
      if (turn !== null) yield turn;
    }
  }
}

/** How a `FakeDesktopHermesTransport` should behave once its scripted frames are exhausted/triggered. */
type FakeMode = "normal" | "throw-after-first";

/**
 * An in-tree `DesktopHermesTransport` for the DHB1 contract: scripted with a fixed list of ACP frames.
 * Static helpers build the adversarial scenarios DHB1 must defend against. All secret-looking strings
 * are built at runtime (never source literals) so `secret-scan` stays clean.
 */
export class FakeDesktopHermesTransport implements DesktopHermesTransport {
  constructor(
    private readonly frames: readonly AcpUpdateFrame[],
    private readonly mode: FakeMode = "normal",
  ) {}

  async *submit(_intent: string): AsyncIterable<AcpUpdateFrame> {
    let first = true;
    for (const frame of this.frames) {
      if (!first && this.mode === "throw-after-first") {
        throw new Error("desktop hermes ACP transport down mid-stream");
      }
      yield frame;
      first = false;
    }
  }

  /**
   * (a) A tool_call frame whose EXTRA fields carry an api_key/credential. The parser must ignore them:
   * the resulting turn carries only the legitimate bundleRef arg, and no key reaches any BrainEvent.
   */
  static withApiKeyFrame(apiKeyValue: string): FakeDesktopHermesTransport {
    const frame = {
      sessionUpdate: "tool_call",
      title: "send",
      rawInput: { bundleRef: "github:PAT:prod" },
      api_key: apiKeyValue,
      apiKey: apiKeyValue,
    } as unknown as AcpUpdateFrame;
    return new FakeDesktopHermesTransport([frame]);
  }

  /**
   * (b) A tool_call frame whose ARGS carry a LITERAL secret (a by-shape exfiltration attempt). The
   * parser passes it through faithfully; the governBrainStream guard above the shim must DENY it and
   * stop the stream — so the trailing valid frame here must never surface.
   */
  static withLiteralSecretToolCall(): FakeDesktopHermesTransport {
    // Secret canary built at runtime — NOT a source literal, so secret-scan stays clean.
    const literalSecret = `sk-${"c".repeat(24)}`;
    return new FakeDesktopHermesTransport([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok step" } },
      { sessionUpdate: "tool_call", title: "leak", rawInput: { note: literalSecret } },
      { sessionUpdate: "tool_call", title: "after", rawInput: { ok: true } },
    ]);
  }

  /**
   * (c) A malformed frame sandwiched between two valid frames. Per-frame fail-closed: the malformed
   * one is skipped, both valid frames (a plan before, a tool_call after) still produce turns.
   */
  static withMalformedBetweenValid(): FakeDesktopHermesTransport {
    return new FakeDesktopHermesTransport([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "valid plan" } },
      { sessionUpdate: "tool_call" } as AcpUpdateFrame, // malformed: tool_call with no tool name
      { sessionUpdate: "tool_call", title: "valid_tool", rawInput: { ok: true } },
    ]);
  }

  /**
   * (d) A transport that THROWS mid-stream after its first frame. The turn source must stop — the
   * post-throw scripted tool_call ("should_not_appear") must never be yielded.
   */
  static withThrowAfterFirst(): FakeDesktopHermesTransport {
    return new FakeDesktopHermesTransport(
      [
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pre-throw plan" } },
        { sessionUpdate: "tool_call", title: "should_not_appear", rawInput: {} },
      ],
      "throw-after-first",
    );
  }
}
