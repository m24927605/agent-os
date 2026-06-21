/**
 * HermesBrainShim — the real-vendor brain shim for the BrainAdapter port (R11-S2).
 *
 * Hermes is a conversation-loop agent (/tmp/hermes-agent-probe/run_agent.py) whose LLM turns produce
 * an assistant message + `tool_calls` (collected as `{name, arguments}` at run_agent.py:1635-1647).
 * This shim faithfully maps a Hermes turn onto the vendor-neutral BrainEvent stream:
 *   - turn.toolCalls  -> ToolCall   (tool = name, args = arguments)
 *   - turn.planText   -> PlanStep   (the assistant's plan narration)
 *   - turn.memoryOps  -> MemoryMutation  } emit-only: the governed pipeline Appends-to-WORM BEFORE
 *   - turn.skillOps   -> SkillMutation   } these take effect (reversing Hermes's fire-and-forget
 *                                          self-improvement — design vendor-adapters.md §2.2).
 *
 * CREDENTIAL-BLIND (the core security value): Hermes self-manages an `api_key` (run_agent.py:346/421
 * client-held credential anti-pattern). This shim STRIPS that channel — the `HermesTurn` contract has
 * NO api_key field and the shim maps ONLY tool/args/plan/ops, so no key can ever flow into an emitted
 * event (the real key is injected at the OpenShell SecretResolver egress, never here). Any arg that
 * still smuggles a literal secret is denied + stops the stream by the existing `governBrainStream`
 * guard applied above this shim (this module does not re-implement that guard).
 *
 * FAIL-CLOSED: a malformed AgentContext yields nothing (never act on an unidentified caller —
 * port.ts:67-74); a turn-source that throws terminates the stream without yielding (deny-by-default).
 *
 * Capability gate: the real Hermes process / live model egress is an injected `HermesTurnSource` seam
 * (R9 Python credential-blind shim + R1 land the live wire), so the shim runs fully in-process with no
 * I/O and the core imports no vendor SDK. Cohesion: imports ONLY the brain barrel + iam/ids + zod.
 */
import { type AgentContext, parseAgentContext } from "../../../../iam/ids.js";
import { type BrainEvent, BrainEvent as BrainEventSchema } from "../../index.js";

/** A proposed Hermes tool call (run_agent.py:1635-1647 `{name, arguments}`). Args carry NO literal secret. */
export interface HermesToolCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** A Hermes intent to mutate its own `~/.hermes` durable memory (emit-only; governed before effect). */
export interface HermesMemoryOp {
  readonly operation: "write" | "update" | "delete";
  readonly key: string;
}

/** A Hermes intent to mutate its own skills (self-improvement; emit-only; governed before effect). */
export interface HermesSkillOp {
  readonly operation: "create" | "update" | "archive";
  readonly skillId: string;
}

/**
 * The minimal Hermes-turn shape this shim consumes. DELIBERATELY has NO `api_key` field: Hermes's
 * client-held credential channel is not part of the contract, so it can never be forwarded.
 */
export interface HermesTurn {
  readonly planText?: string;
  readonly toolCalls?: readonly HermesToolCall[];
  readonly memoryOps?: readonly HermesMemoryOp[];
  readonly skillOps?: readonly HermesSkillOp[];
}

/**
 * Injected transport seam standing in for the live Hermes runtime (R9 Python shim + R1 land the wire).
 * It produces Hermes-style turns for an intent. NOT a credential channel.
 */
export interface HermesTurnSource {
  turns(intent: string): AsyncIterable<HermesTurn>;
}

export class HermesBrainShim {
  constructor(private readonly turnSource: HermesTurnSource) {}

  async *execute(ctx: unknown, intent: string): AsyncIterable<BrainEvent> {
    let context: AgentContext;
    try {
      context = parseAgentContext(ctx);
    } catch {
      return; // fail-closed: never act on an unidentified caller
    }

    let turns: AsyncIterable<HermesTurn>;
    try {
      turns = this.turnSource.turns(intent);
      for await (const turn of turns) {
        yield* mapTurn(turn, context);
      }
    } catch {
      return; // fail-closed: a turn source that throws stops the stream (deny-by-default)
    }
  }
}

/** Map one Hermes turn to its BrainEvent stream. Reads ONLY known fields — api_key is never touched. */
function* mapTurn(turn: HermesTurn, context: AgentContext): Generator<BrainEvent> {
  if (turn.planText !== undefined && turn.planText.length > 0) {
    yield BrainEventSchema.parse({ kind: "plan-step", context, description: turn.planText });
  }
  for (const tc of turn.toolCalls ?? []) {
    yield BrainEventSchema.parse({ kind: "tool-call", context, tool: tc.tool, args: tc.args });
  }
  for (const op of turn.memoryOps ?? []) {
    yield BrainEventSchema.parse({
      kind: "memory-mutation",
      context,
      operation: op.operation,
      key: op.key,
    });
  }
  for (const op of turn.skillOps ?? []) {
    yield BrainEventSchema.parse({
      kind: "skill-mutation",
      context,
      operation: op.operation,
      skillId: op.skillId,
    });
  }
}
