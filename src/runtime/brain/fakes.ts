/**
 * In-memory brain adapters — the mandatory >=2 implementations that prove the Brain port is genuinely
 * swappable (a real Hermes adapter lands under src/runtime/brain/<vendor>/ in P2, behind the same
 * port). Both are credential-blind and fail-closed on a malformed AgentContext (yield nothing).
 */
import { type AgentContext, parseAgentContext } from "../../iam/ids.js";
import type { SecretDetector } from "./credential-guard.js";
import { type BrainAdapter, BrainEvent } from "./port.js";
import {
  type BrainState,
  type MemoryEntry,
  VersionedMemory,
  assertCredentialBlind,
  assertSchemaVersion,
} from "./state.js";

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

/**
 * In-memory `BrainState` — the fake that proves the versioning contract (export/import round-trip,
 * schemaVersion gate, credential-blind export). A real Hermes versioning adapter is R11 (capability-
 * gated: Hermes mutates memory in place with no versioned event, design §30); this fake stands in
 * behind the same port so orchestration's snapshot/restore wiring (R10-S3) can be tested without it.
 */
export class ScriptedBrainState implements BrainState {
  private entries: MemoryEntry[];

  constructor(
    public readonly schemaVersion: number,
    entries: readonly MemoryEntry[],
    private sequence = 0,
  ) {
    this.entries = entries.map((e) => ({ ...e }));
  }

  /** Credential-blind: builds the memory, then refuses to emit it if it holds any secret (or the detector errors). */
  export(detectSecret: SecretDetector): VersionedMemory {
    const mem = VersionedMemory.parse({
      schemaVersion: this.schemaVersion,
      sequence: this.sequence,
      entries: this.entries.map((e) => ({ ...e })),
    });
    return assertCredentialBlind(mem, detectSecret);
  }

  /** Rejects a mismatched schemaVersion (backwards-compat gate) before adopting the memory. */
  import(mem: VersionedMemory): void {
    const accepted = assertSchemaVersion(this.schemaVersion, mem);
    this.entries = accepted.entries.map((e) => ({ ...e }));
    this.sequence = accepted.sequence;
  }
}
