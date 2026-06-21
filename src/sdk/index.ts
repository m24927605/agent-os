/**
 * Agent OS — Developer SDK author barrel (SLICE-P2R-R9-S2).
 *
 * This is the CONVERGENT, author-facing public surface for third-party tool authors. It is
 * deliberately NARROWER than the core barrel (`src/index.ts`, which aggregates governance internals).
 * An author "writes once, against a stable contract" here and never touches — or even sees — the
 * governance internals (PDP evaluator, audit kernel, dedup law, …). The SDK is a downstream CONSUMER
 * of core, never a new authority: it adds no deny/allow/append capability and cannot bypass the PDP.
 *
 * Hard constraints proven by command (see index.test.ts + `pnpm run deps:check`):
 *  - Re-exports ONLY via each module's public `index.ts` barrel — NO deep import into any module's
 *    internals (dependency-cruiser `not-to-internal`).
 *  - Single direction: root `src/index.ts` -> this barrel -> module barrels. This file MUST NEVER
 *    import root `src/index.ts` (would create a cycle -> `no-circular` red).
 *  - vendor-neutral: only contracts + in-tree Fakes are re-exported; no real vendor adapter.
 *
 * What an author gets:
 *  - R3 ToolManifest contract: declare a tool's side-effect semantics as a Zod-strict manifest.
 *  - The four vendor-neutral Port surfaces (Brain / CostGate / AgentHosting / ExecutionSubstrate) —
 *    interface types to author against, plus in-tree Fake adapters to run contracts locally.
 *
 * Intentionally EXCLUDED (anti-leak, pinned by index.test.ts):
 *  - Policy is NOT here: `src/policy` is an evaluator (governance internal), not an author-facing Port.
 *  - Audit kernel, dedup, redaction, IAM ids, orchestration, etc. — all governance internals.
 */

// R3 — ToolManifest contract (schema + parse + side-effect type), via the tools module barrel.
export { ToolManifest, parseToolManifest, type ToolSideEffect } from "../tools/index.js";

// Brain Port — author against `BrainAdapter`; run locally with Scripted/Echo fakes.
export type { BrainAdapter } from "../runtime/brain/index.js";
export { ScriptedBrain, EchoBrain } from "../runtime/brain/index.js";

// ExecutionSubstrate Port — author against `SandboxAdapter`; run locally with the Fake.
export type { SandboxAdapter } from "../runtime/substrate/index.js";
export { FakeSandboxAdapter } from "../runtime/substrate/index.js";

// CostGate Port — author against `CostGate`; run locally with the in-memory hard-cap gate.
export type { CostGate } from "../cost/index.js";
export { InMemoryCostGate } from "../cost/index.js";

// AgentHosting Port — author against `AgentHosting`; run locally with the in-memory tenant-scoped host.
export type { AgentHosting } from "../hosting/index.js";
export { InMemoryAgentHosting } from "../hosting/index.js";
