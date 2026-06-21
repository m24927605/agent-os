/**
 * Brain port — the vendor-neutral contract for the (untrusted) agent that does the work.
 *
 * The brain is ONE pluggable slot (default Hermes; swappable for Claude Code / OpenClaw / Codex /
 * custom). It is UNTRUSTED by construction: it only PROPOSES work as a stream of typed events; it
 * never denies (the PDP does), never touches secrets (it is credential-blind — args carry reference
 * `bundleRef` strings, never literal secrets), and never writes the WORM directly. This `brain/` path
 * carries NO vendor name; a real adapter (e.g. Hermes) lands under `src/runtime/brain/<vendor>/` and
 * implements `BrainAdapter`.
 *
 * Cohesion/coupling: this port imports only identity primitives + zod. Credential-blind enforcement
 * is a SEPARATE, injectable guard (credential-guard.ts) so the port stays decoupled from the audit
 * layer's secret detector.
 */
import { z } from "zod";
import { AgentContext } from "../../iam/ids.js";

const base = { context: AgentContext };

/** A step in the brain's plan (human-readable intent decomposition). */
export const PlanStep = z.object({
  ...base,
  kind: z.literal("plan-step"),
  description: z.string().min(1),
});
export type PlanStep = z.infer<typeof PlanStep>;

/**
 * A proposed tool invocation. `args` MUST reference credentials by bundleRef (e.g. "github:PAT:prod"),
 * never carry a literal secret — enforced by the credential guard before any effect.
 */
export const ToolCall = z.object({
  ...base,
  kind: z.literal("tool-call"),
  tool: z.string().min(1),
  args: z.record(z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCall>;

/** A proposed change to the brain's own durable memory (must be governed: Append-to-WORM before it takes effect). */
export const MemoryMutation = z.object({
  ...base,
  kind: z.literal("memory-mutation"),
  operation: z.enum(["write", "update", "delete"]),
  key: z.string().min(1),
});
export type MemoryMutation = z.infer<typeof MemoryMutation>;

/** A proposed change to the brain's own skills (self-improvement; likewise governed). */
export const SkillMutation = z.object({
  ...base,
  kind: z.literal("skill-mutation"),
  operation: z.enum(["create", "update", "archive"]),
  skillId: z.string().min(1),
});
export type SkillMutation = z.infer<typeof SkillMutation>;

/** Everything a brain may emit. Discriminated on `kind`. */
export const BrainEvent = z.discriminatedUnion("kind", [
  PlanStep,
  ToolCall,
  MemoryMutation,
  SkillMutation,
]);
export type BrainEvent = z.infer<typeof BrainEvent>;

/**
 * A hosted brain. `execute` turns an intent into a stream of proposed events. It MUST fail-closed on a
 * malformed AgentContext (yield nothing — never act on an unidentified caller) and every emitted event
 * MUST carry a valid AgentContext.
 */
export interface BrainAdapter {
  execute(ctx: unknown, intent: string): AsyncIterable<BrainEvent>;
}
