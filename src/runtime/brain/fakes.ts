/**
 * In-memory brain adapters — the mandatory >=2 implementations that prove the Brain port is genuinely
 * swappable (a real Hermes adapter lands under src/runtime/brain/<vendor>/ in P2, behind the same
 * port). Both are credential-blind and fail-closed on a malformed AgentContext (yield nothing).
 */
import { type AgentContext, parseAgentContext } from "../../iam/ids.js";
import { type BrainAdapter, BrainEvent } from "./port.js";

/** A brain driven by a scripted list of event-builders — the test harness brain. */
export class ScriptedBrain implements BrainAdapter {
  constructor(private readonly drafts: ((ctx: AgentContext) => unknown)[]) {}

  async *execute(ctx: unknown, _intent: string): AsyncIterable<BrainEvent> {
    let context: AgentContext;
    try {
      context = parseAgentContext(ctx);
    } catch {
      return; // fail-closed: never act on an unidentified caller
    }
    for (const draft of this.drafts) {
      yield BrainEvent.parse(draft(context));
    }
  }
}

/** A minimal intent-derived brain: a plan step + one echo tool call. A genuinely distinct 2nd impl. */
export class EchoBrain implements BrainAdapter {
  async *execute(ctx: unknown, intent: string): AsyncIterable<BrainEvent> {
    let context: AgentContext;
    try {
      context = parseAgentContext(ctx);
    } catch {
      return; // fail-closed
    }
    yield BrainEvent.parse({ kind: "plan-step", context, description: `plan: ${intent}` });
    yield BrainEvent.parse({ kind: "tool-call", context, tool: "echo", args: { intent } });
  }
}
