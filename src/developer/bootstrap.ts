/**
 * createDeveloperKit — the Developer-vertical COMPOSITION ROOT (SLICE-DV1).
 *
 * This is the first place the already-built Developer-surface primitives (R9 ToolRegistry /
 * parseToolManifest / authorizeToolInvoke + R10 replayTimeline) are wired with the governed pipeline
 * into ONE runnable, SELF-CONTAINED author->govern->WORM->independently-verify spine over a PURELY
 * in-memory backbone (no kernel process, no docker, no vendor):
 *
 *   verifyToolManifest(manifest)  -> ToolManifest        (thin parseToolManifest; fail-closed)
 *   authorTool(manifest)          -> ToolBinding          (registry.register; fail-closed throw)
 *   registeredTools()             -> readonly ToolManifest[]  (registry.list() snapshot)
 *   bundleRefFor(pattern)         -> "bundle://<pattern>" (credential-blind helper)
 *   runTool(toolCall)             -> GovernedOutcome+     (runGovernedToolCall over this kit's deps)
 *   replayFold(uptoSeq?)          -> TaskTimeline         (replayTimeline over the WORM's entries)
 *   verifyEvidenceChain(pubkey)   -> VerifyResult         (SPAWN the released verifier; relay 0/1/2)
 *
 * It mirrors `createPersonalShell` (src/personal/bootstrap.ts) and `createEnterpriseFleet`, but the
 * Developer surface is the only one that EXPOSES INDEPENDENT VERIFIABILITY: a developer/auditor does
 * not have to trust the operator — they recompute (`replayFold`, a pure deterministic fold) AND verify
 * the WORM chain with the SEPARATELY-RELEASED verifier (`verifyEvidenceChain`, a process-boundary
 * spawn). READING != ATTESTING.
 *
 * ── THE REGISTRY-BACKED AUTHORIZE (INDEX §3 the surface's core) ────────────────────────────────────
 * Unlike Personal (whose authorize is a hardcoded `personal:*` allow + a boolean), `runTool`'s
 * `authorize` is `authorizeToolInvoke(req, THIS registry, rules)`: an UNREGISTERED tool is denied
 * DENY-BY-DEFAULT (the registry pre-screen), and a REGISTERED tool delegates to the PDP. So the only
 * tools that can execute are ones an author actually registered AND that the kit's allow rule grants.
 *
 * ── THE COMMIT-BEFORE-EFFECT SEAM (reused, mirrors Personal) ───────────────────────────────────────
 * The pipeline hands the appender a STRUCTURAL event `{kind,tool,context,decisionReason}`. The seam
 * appender SYNTHESIZES a real `AuditEvent` via `createAuditEvent(...)`, appends it to THIS kit's
 * `InMemoryAppendOnlyLog` (the WORM), and returns that `AppendReceipt` — BEFORE the effect runs.
 * `replayFold()` then folds the SAME WORM's `entries()`, so "what the appender wrote" == "what the
 * developer recomputes". The independent verifier validates the SAME WORM's signed chain.
 *
 * Low coupling: imports cross-module ONLY through public barrels (tools / orchestration / cost / audit /
 * runtime-brain / runtime-substrate / policy); `iam/ids` is the existing interim pre-barrel exception
 * (type-only here). Names no vendor. NEVER imports Go/kernel internals — the verifier is reached by
 * spawn (a PROCESS boundary), and the chain hash is NEVER recomputed in TS (that is the verifier's job).
 */
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppendReceipt,
  type AuditEvent,
  InMemoryAppendOnlyLog,
  createAuditEvent,
  redactSecrets,
} from "../audit/index.js";
import type { CommitAppender } from "../commitgate/index.js";
import { type CostGate, InMemoryCostGate, failClosedCostGate } from "../cost/index.js";
import type { AgentContext } from "../iam/ids.js";
import {
  type GovernedCall,
  type GovernedStage,
  type GovernedToolCallDeps,
  type TaskTimeline,
  replayTimeline,
  runGovernedToolCall,
} from "../orchestration/index.js";
import {
  type AllowRule,
  type PolicyRequest,
  type SecondaryPolicyAdapter,
  combineDecisions,
  evaluateSecondaries,
} from "../policy/index.js";
import { type SecretDetector, screenBrainEvent } from "../runtime/brain/index.js";
import { FakeSandboxAdapter } from "../runtime/substrate/index.js";
import {
  type ToolManifest,
  ToolRegistry,
  authorizeToolInvoke,
  parseToolManifest,
} from "../tools/index.js";
import { type ForensicState, foldForensicState, projectWormToReplayEvents } from "./forensic.js";

/**
 * A ToolBinding — the registry-pinned identity of a registered tool. `ToolRegistry.register` is
 * `void` (it owns existence + duplicate rejection), so the composition root PROJECTS this binding off
 * the parsed manifest: the four fields a downstream caller needs to address + authorize the tool.
 */
export interface ToolBinding {
  readonly name: string;
  readonly version: string;
  readonly resourcePattern: string;
  readonly action: string;
}

/** A developer-kit tool call: a GovernedCall carrying author-supplied `args` the screen inspects. */
export interface DeveloperToolCall extends GovernedCall {
  readonly tool: string;
  readonly context: AgentContext;
  /** Arbitrary author-supplied args; the credential screen catches a secret that slipped in here. */
  readonly args: Record<string, unknown>;
}

/** The governed outcome of `runTool`, enriched with whether the FakeSandbox was created (for tests). */
export type RunToolOutcome =
  | {
      status: "executed";
      reservationId: string;
      receipt: AppendReceipt;
      sandboxCreated: boolean;
      detail?: string;
    }
  | { status: "denied"; stage: GovernedStage; reason: string };

/** Result of the INDEPENDENT chain verification (the verifier's relayed verdict; never a TS recompute). */
export type VerifyResult =
  | { ok: true; length?: number }
  | { ok: false; reason: string; brokenAt?: number };

/** Options for the in-memory Developer kit. Defaults give a runnable happy-path backbone. */
export interface DeveloperKitOpts {
  /** Token budget for the in-memory CostGate. */
  readonly budget?: number;
  /** Fixed token estimate per call (mirrors the pipeline.e2e `() => 10`). */
  readonly estimateTokens?: number;
  /**
   * The PDP allow rules a REGISTERED tool is delegated to (after the registry deny-by-default pre-screen).
   * ABSENT => the kit's default: a single allow over the kit's `dev:*` resource namespace, so a tool
   * authored in that namespace passes the PDP. An empty array (`[]`) => every tool denied@policy.
   */
  readonly rules?: readonly AllowRule[];
  /**
   * SLICE-DVx — an INJECTABLE shared tool catalog. ABSENT (the default) => the kit builds its OWN
   * internal `ToolRegistry` exactly as before (byte-identical: `authorTool` registers into it,
   * `registeredTools()` lists it, the registry-backed authorize deny-by-defaults everything else). When
   * provided, the kit uses THIS registry as its catalog instead — the same instance can be shared with
   * `createPersonalShell` / `createEnterpriseFleet` so all three surfaces consult ONE developer-registered
   * catalog (the three-surface UNIFIED registry-backed admission). Developer already does registry-backed
   * authorize; this opt only makes the registry an INJECTABLE (shareable) seam.
   */
  readonly toolRegistry?: ToolRegistry;
  /**
   * SLICE-IT1a — an INJECTABLE, vendor-neutral CostGate (the spend slot). ABSENT (the default) => the
   * DV1-identical `new InMemoryCostGate(budget)` (byte-identical to today). When provided (e.g. a
   * config-driven SpendGuardCostGate wired by IT1b), the governed pipeline reserves against THIS gate
   * instead — and the injection can ONLY NARROW: a CostGate's `reserve` can DENY (deny@cost), it never
   * grants more budget than the gate allows. The kit depends ONLY on the vendor-neutral `CostGate`
   * PORT type here — never a vendor adapter (SpendGuard/AGT).
   */
  readonly costGate?: CostGate;
  /**
   * SLICE-IT1a — INJECTABLE, vendor-neutral ADVISORY secondary policy adapters (e.g. AGT). ABSENT (the
   * default) => `[]` (byte-identical to today: `combineDecisions(decision, [])`). When provided, every
   * adapter is folded via `combineDecisions(decision, opts.secondaries)`: the registry-backed PDP is
   * the SOLE deny authority and the merge is any-deny-wins / fail-closed, so a secondary can ONLY
   * NARROW — it can NEVER grant/relax what the registry/PDP denied. The kit depends ONLY on the
   * vendor-neutral `SecondaryPolicyAdapter` PORT type — never a vendor adapter.
   */
  readonly secondaries?: readonly SecondaryPolicyAdapter[];
}

/** The composed Developer-surface facade a developer (or a test) drives end-to-end. */
export interface DeveloperKit {
  /** Thin `parseToolManifest` (fail-closed: malformed / guardrail-violating / unknown-field throws). */
  verifyToolManifest(manifest: unknown): ToolManifest;
  /** Register a manifest into THIS kit's registry (fail-closed throw on malformed/duplicate) -> binding. */
  authorTool(manifest: unknown): ToolBinding;
  /** Read-only snapshot of the registered manifests. */
  registeredTools(): readonly ToolManifest[];
  /** Credential-blind helper: the `bundle://`-prefixed reference for a pattern (never a literal secret). */
  bundleRefFor(pattern: string): string;
  /** Run a tool call through the governed pipeline (registry-backed authorize; commit-before-effect). */
  runTool(toolCall: DeveloperToolCall): Promise<RunToolOutcome>;
  /** Read-only deterministic fold of THIS kit's WORM into a TaskTimeline (forensic replay). */
  replayFold(uptoSequence?: number): TaskTimeline;
  /**
   * Read-only, deterministic forensic fold of THIS kit's WORM into the typed `ForensicState` schema
   * (SLICE-DV3): `{ eventCount, executed, denied, byResource }` over the WORM's AuditEvents. ADDITIVE
   * over `replayFold` (which keeps returning the generic `TaskTimeline`): an auditor reads the
   * point-in-time forensic SUMMARY without the engine's `unknown` foldedState.
   *
   * POINT-IN-TIME: `forensicState(uptoSeq)` reflects ONLY entries with `sequence <= uptoSeq` — it folds
   * the SAME `replayTimeline` cut `replayFold` produces (reusing the engine's validated, gap-checked
   * steps), so the cut semantics + an out-of-range `uptoSequence` (-> `ReplayError`) are IDENTICAL to
   * `replayFold`. Default (no `uptoSequence`) folds the whole WORM (== as-of-head).
   */
  forensicState(uptoSequence?: number): ForensicState;
  /**
   * Export THIS kit's Ed25519 PUBLIC key as an SPKI PEM — the trust-root a developer/auditor hands to
   * the released verifier (`--pubkey`) to verify the kit's signed WORM chain. PUBLIC material ONLY:
   * the private key never leaves the kit and is unreachable through this (or any) accessor.
   */
  publicKeyPem(): string;
  /**
   * INDEPENDENT verification: serialize THIS kit's WORM to the verifier's --chain input, SPAWN the
   * released verifier (`AGENTOS_VERIFIER_BIN` override; default `agentos-verifier`), and RELAY its exit
   * code (0=intact / 1=broken / 2=bad-input; absent/error => fail-closed). NEVER recomputes the chain.
   */
  verifyEvidenceChain(pubkeyPath: string, env?: NodeJS.ProcessEnv): Promise<VerifyResult>;
}

/** The repo's real secret detector: redaction-changed-anything ⇒ a secret was present (pipeline.e2e:31). */
const detectSecret: SecretDetector = (v) => JSON.stringify(redactSecrets(v)) !== JSON.stringify(v);

/** The kit's default resource namespace — a non-wildcard-only prefix the PDP accepts (evaluate.ts:74). */
const DEFAULT_ALLOW: readonly AllowRule[] = [
  { id: "dv1-default", action: "tool:invoke", resource: "dev:*" },
];

/** The structural event the pipeline hands the appender (pipeline.ts:79-84). */
interface StructuralEvent {
  readonly kind: string;
  readonly tool: string;
  readonly context: unknown;
  readonly decisionReason: string;
}

export function createDeveloperKit(opts: DeveloperKitOpts = {}): DeveloperKit {
  const budget = opts.budget ?? 1000;
  const estimate = opts.estimateTokens ?? 10;
  // The PDP rules a REGISTERED tool delegates to (the registry deny-by-default runs FIRST, regardless).
  const rules: readonly AllowRule[] = opts.rules ?? DEFAULT_ALLOW;

  // ── The kit's WORM the appender writes and replayFold/verifyEvidenceChain read (ed25519, like Personal) ──
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const worm = new InMemoryAppendOnlyLog({ publicKey, privateKey });
  // The single authoritative source for "which tools exist" (deny-by-default for everything else). With
  // NO `opts.toolRegistry` this is a fresh internal registry (byte-identical to DV1); when injected, the
  // kit shares the SAME catalog as the other surfaces (SLICE-DVx three-surface unified admission).
  const registry = opts.toolRegistry ?? new ToolRegistry();
  const fake = new FakeSandboxAdapter();
  // SLICE-IT1a: the INJECTED CostGate or — ABSENT — the DV1-identical `new InMemoryCostGate(budget)`.
  // The injected gate is the spend AUTHORITY for this kit (replacement); the invariant is that a
  // CostGate that DENIES cannot grant the effect. Wrapped fail-closed so an EXTERNAL gate's thrown
  // reserve/commit/release becomes a structured deny (the in-tree gate never throws, so the ABSENT path
  // stays byte-identical to today).
  const cost: CostGate = failClosedCostGate(opts.costGate ?? new InMemoryCostGate(budget));

  /**
   * The seam appender (mirrors Personal): synthesize a REAL AuditEvent from the structural event and
   * append it to THIS kit's WORM, returning the receipt — BEFORE the effect runs (commit-before-effect).
   * `result:"success"` + `policyDecision.effect:"allow"` because the pipeline only commits AFTER
   * screen+authorize+cost pass. `replayFold` then folds the SAME WORM the appender wrote.
   */
  const appender: CommitAppender<StructuralEvent, AppendReceipt> = {
    append: (event) => {
      const ctx = event.context as AgentContext;
      const auditEvent = createAuditEvent({
        actorId: ctx.actorId,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        requestId: ctx.requestId,
        sandboxId: ctx.sandboxId,
        action: "tool:invoke",
        resource: event.tool,
        policyDecision: { effect: "allow", reason: event.decisionReason },
        result: "success",
      });
      return Promise.resolve(worm.append(auditEvent));
    },
  };

  // Whether the FakeSandbox was created during the LAST effect (for the executed-outcome enrichment).
  let lastSandboxCreated = false;

  // The governed-pipeline deps (mirrors the pipeline.e2e makeDeps template + the SEAM appender) with the
  // REGISTRY-BACKED authorize — the load-bearing Developer-surface invariant.
  const deps: GovernedToolCallDeps<DeveloperToolCall, AppendReceipt> = {
    screen: (tc) => {
      const r = screenBrainEvent(tc as never, detectSecret);
      return r.status === "ok" ? { ok: true as const } : { ok: false as const, reason: r.reason };
    },
    authorize: async (tc) => {
      const req = { ...tc.context, action: "tool:invoke", resource: tc.tool } as PolicyRequest;
      // authorizeToolInvoke is the deny-only registry pre-screen IN FRONT of the PDP: an UNREGISTERED
      // tool is denied deny-by-default; a REGISTERED tool is delegated to evaluatePolicy(req, rules).
      const decision = authorizeToolInvoke(req, registry, rules);
      // SLICE-IT1a: evaluate the INJECTED advisory secondaries fail-closed (a throwing/rejecting adapter
      // -> a synthetic deny), then fold them into the decision. ABSENT => `[]` adapters -> `[]` decisions,
      // byte-identical to today's `combineDecisions(decision, [])`. combineDecisions is any-deny-wins /
      // PDP-sovereign: a secondary can only deny more — it never grants/relaxes a registry/PDP deny.
      // SLICE-R9a: `evaluateSecondaries` is async, so this closure is `async` and `await`s it.
      const secondaryDecisions = await evaluateSecondaries(opts.secondaries ?? [], req);
      const combined = combineDecisions(decision, secondaryDecisions);
      // Scrub UNTRUSTED secondary `reason` text before it flows into the committed AuditEvent (replayFold
      // folds the RAW WORM, so write-side redaction is the defense). ABSENT path => identity redact.
      return { effect: combined.effect, reason: redactSecrets(combined.reason) };
    },
    cost,
    estimateTokens: () => estimate,
    appender,
    effect: async (tc) => {
      const res = await fake.createSandbox(tc.context, { image: tc.tool });
      lastSandboxCreated = res.status === "ok";
      return { ok: res.status === "ok", detail: res.status };
    },
  };

  return {
    verifyToolManifest: (manifest) => parseToolManifest(manifest),

    authorTool: (manifest) => {
      // Fail-closed: register THROWS on malformed input / guardrail violation / duplicate name. We do
      // NOT swallow it (mirror the registry contract). The parse is the single source of truth for the
      // binding's fields — project the four a caller needs to address + authorize the tool.
      const parsed = parseToolManifest(manifest);
      registry.register(parsed);
      return {
        name: parsed.name,
        version: parsed.version,
        resourcePattern: parsed.resourcePattern,
        action: parsed.action,
      };
    },

    registeredTools: () => registry.list(),

    bundleRefFor: (pattern) => `bundle://${pattern}`,

    // Export the kit's Ed25519 PUBLIC key as an SPKI PEM (the verifier's `--pubkey` input). We export
    // the PUBLIC KeyObject ONLY — `privateKey` is closed over but is NEVER exposed, so an auditor gets
    // the trust-root to verify the signed chain without ever seeing private material.
    publicKeyPem: () => publicKey.export({ type: "spki", format: "pem" }) as string,

    runTool: async (toolCall) => {
      lastSandboxCreated = false;
      const outcome = await runGovernedToolCall(deps, toolCall);
      if (outcome.status === "executed") {
        return {
          status: "executed",
          reservationId: outcome.reservationId,
          receipt: outcome.receipt,
          sandboxCreated: lastSandboxCreated,
          detail: outcome.detail,
        };
      }
      return { status: "denied", stage: outcome.stage, reason: outcome.reason };
    },

    replayFold: (uptoSequence) => {
      // Project the WORM's LogEntry[] into the ReplayEvent shape replayTimeline consumes
      // (`{sequence, event}` — replay.ts:30) via the formalized, fail-closed, sorted DV3 helper
      // (replacing the prior inline projection), then fold (read-only, deterministic timelineHash).
      const events = projectWormToReplayEvents(worm.entries());
      return replayTimeline(events, uptoSequence);
    },

    forensicState: (uptoSequence) => {
      // Reuse replayTimeline's VALIDATED, point-in-time cut: the engine gap-checks + orders the
      // projection and trims to `sequence <= uptoSequence` (out-of-range uptoSequence -> ReplayError,
      // IDENTICAL to replayFold). Then fold ONLY those cut steps into the typed ForensicState — so the
      // forensic summary is consistent with the timeline replayFold returns at the same cut-point.
      const events = projectWormToReplayEvents(worm.entries());
      const timeline = replayTimeline(events, uptoSequence);
      return foldForensicState(timeline.steps);
    },

    verifyEvidenceChain: async (pubkeyPath, env = process.env) => {
      // Serialize THIS kit's WORM to the verifier's --chain input: a SignedChain JSON `{entries, checkpoint}`.
      // The TS LogEntry/Checkpoint/SignedChain field names match the Go verifier's json tags
      // (kernel/internal/chain/types.go), so this is the verifier's expected shape. HONEST SCOPE: this is
      // a BEST-EFFORT serialization of the in-memory chain; DV2 validates it byte-for-byte against the
      // REAL released verifier (whether the AuditEvent canonicalization matches Go's recompute is a DV2
      // proof). DV1 proves the SPAWN-RELAY CONTRACT (with a test-double verifier), NOT real attestation.
      const chainJson = JSON.stringify({ entries: worm.entries(), checkpoint: worm.checkpoint() });
      const dir = mkdtempSync(join(tmpdir(), "dv1-chain-"));
      const chainPath = join(dir, "chain.json");
      try {
        writeFileSync(chainPath, chainJson);
        // Spawn the RELEASED verifier across a PROCESS boundary (NEVER an import of Go/kernel internals).
        // Mirrors src/cli/main.ts:114-131 — but CAPTURES the exit code (NOT stdio:inherit) to map it.
        const bin = env.AGENTOS_VERIFIER_BIN ?? "agentos-verifier";
        const result = spawnSync(bin, ["--pubkey", pubkeyPath, "--chain", chainPath], { env });
        if (result.error !== undefined) {
          // Binary absent / not executable — fail-closed: NEVER report intact.
          return {
            ok: false,
            reason: `verifier unavailable (fail-closed): ${result.error.message}`,
          };
        }
        if (result.signal !== null) {
          return {
            ok: false,
            reason: `verifier terminated by signal ${result.signal} (fail-closed)`,
          };
        }
        // Relay the verifier's exit code verbatim (0=intact, 1=broken, 2=bad input). Anything else =>
        // fail-closed deny (never treat an unexpected code as intact).
        switch (result.status) {
          case 0:
            return { ok: true };
          case 1:
            return { ok: false, reason: "chain broken (verifier exit 1)" };
          case 2:
            return { ok: false, reason: "bad input (verifier exit 2)" };
          default:
            return { ok: false, reason: `verifier exit ${result.status ?? "null"} (fail-closed)` };
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
