/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *  REFERENCE COMPOSITION ROOT — the DEVELOPER surface.
 *
 *  This is the canonical "run a surface" entry point for the Developer vertical. COPY THIS FILE and
 *  replace the in-memory seams with your real adapters for production. Out of the box it composes the
 *  already-built Developer-surface primitives (R9 ToolRegistry / parseToolManifest / authorizeToolInvoke
 *  + R10 replayTimeline) with the governed pipeline into ONE runnable, self-contained
 *  author → govern → WORM → independently-recompute spine over a PURELY in-memory backbone — NO kernel
 *  process, NO docker, NO vendor, NO network, ZERO external deps. It demonstrates a REAL governed
 *  outcome AND the surface's distinctive first-value: INDEPENDENT VERIFIABILITY (the developer
 *  recomputes the WORM with a pure deterministic fold; READING != ATTESTING):
 *
 *      verifyToolManifest / authorTool (registry deny-by-default)
 *        → runTool (governed: screen → registry-backed authorize → cost → commit-before-effect → effect)
 *          → WORM → replayFold (deterministic forensic recompute)
 *
 *  ── ADOPTER SEAMS (what to replace for production) ────────────────────────────────────────────────
 *    • rules            : DEFAULT = a single allow over the kit's `dev:*` namespace. PRODUCTION: drive
 *                         your real PDP allow-set (`[]` => every registered tool denied@policy).
 *    • toolRegistry     : DEFAULT = a fresh internal `ToolRegistry`. PRODUCTION: inject the SHARED
 *                         developer-registered catalog so all three surfaces consult ONE admission list.
 *    • costGate         : DEFAULT = `InMemoryCostGate`. PRODUCTION: inject your real spend gate.
 *    • sandbox          : the effect uses the in-tree `FakeSandboxAdapter` (composed inside the factory).
 *                         PRODUCTION: the real substrate adapter wires the same DI way inside the root.
 *    • verifyEvidenceChain : the INDEPENDENT verify path SPAWNS the SEPARATELY-RELEASED verifier across a
 *                         PROCESS boundary (`AGENTOS_VERIFIER_BIN`). It is NOT exercised here (no verifier
 *                         binary in this zero-dep example); PRODUCTION/an auditor points it at the real
 *                         released verifier + the kit's `publicKeyPem()` trust-root. `replayFold` (a pure
 *                         TS fold) IS exercised — it proves the recompute spine without any binary.
 *
 *  HONEST SCOPE: every seam below is a FAKE; the example shows the WIRING. The chain hash is NEVER
 *  recomputed in TS — that is the released verifier's job (a real-attestation, deploy-gated boundary).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { createDeveloperKit } from "../../dist/developer/index.js";

/** The concise, credential-blind governed-outcome summary `main()` prints and the test asserts on. */
export interface DeveloperRunSummary {
  readonly surface: "developer";
  /** The governed decision for the run tool call: "executed" (effect ran) or "denied" (a gate refused). */
  readonly decision: string;
  /** Number of tools registered into the kit's registry (the admission catalog). */
  readonly registeredToolCount: number;
  /** Whether the FakeSandbox was created during the effect (proof the effect actually ran). */
  readonly sandboxCreated: boolean;
  /** Number of steps in the deterministic replay fold of the WORM (the independent recompute). */
  readonly replayStepCount: number;
  /** Whether two folds of the same WORM produced the SAME timelineHash (determinism proof). */
  readonly replayDeterministic: boolean;
  /** True when this root used ONLY in-memory defaults (no shared registry / external gate / verifier). */
  readonly usedInMemoryDefaults: true;
}

/** A valid 9-field tool manifest in the kit's default `dev:` namespace (so the default allow rule matches). */
function validManifest(name: string): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    description: "echo tool for the developer kit reference example",
    action: "invoke",
    resourcePattern: `${name}:*`,
    sideEffect: "read",
    idempotent: true,
    requiresApproval: false,
    bundleRefOnly: true,
    containment: "in-sandbox",
  };
}

/**
 * Run the Developer reference composition root end-to-end and return a governed-outcome summary.
 * Exported so the acceptance test drives the SAME flow `main()` runs (no duplicate wiring).
 */
export async function runExample(): Promise<DeveloperRunSummary> {
  // ── THE COMPOSITION ROOT ── in-memory defaults (fresh registry, in-memory cost, in-memory WORM).
  const kit = createDeveloperKit();

  // 1. authorTool (fail-closed): register a valid manifest. The registry is the deny-by-default
  //    admission catalog — only registered tools can be authorized downstream.
  const binding = kit.authorTool(validManifest("dev:echo"));
  const registered = kit.registeredTools();

  // 2. runTool the REGISTERED tool through the governed pipeline. `bundleRefFor` yields a credential-blind
  //    `bundle://` reference (NEVER a literal secret) — the kind of arg an author passes to a tool.
  const outcome = await kit.runTool({
    tool: binding.name,
    context: {
      actorId: "agent:dev",
      tenantId: "tenant-dev",
      projectId: "proj-dev",
      taskId: "task-dev",
      requestId: "req-dev",
    },
    args: { bundle: kit.bundleRefFor("dev:echo:payload") },
  });

  // 3. replayFold: the INDEPENDENT, deterministic forensic recompute of the WORM the pipeline committed.
  const fold = kit.replayFold();
  const foldAgain = kit.replayFold();
  const replayDeterministic = fold.timelineHash === foldAgain.timelineHash;

  return {
    surface: "developer",
    decision: outcome.status,
    registeredToolCount: registered.length,
    sandboxCreated: outcome.status === "executed" ? outcome.sandboxCreated : false,
    replayStepCount: fold.steps.length,
    replayDeterministic,
    usedInMemoryDefaults: true,
  };
}

/** Standalone run: `node examples/surfaces/run-developer-kit.ts` (after `pnpm build`). */
async function main(): Promise<void> {
  const s = await runExample();
  // Credential-blind by construction: only neutral governed fields + counts are printed.
  console.log("[developer] governed outcome:", JSON.stringify(s, null, 2));
  if (s.decision !== "executed" || s.replayStepCount < 1 || !s.replayDeterministic) {
    console.error("[developer] FAILED: expected executed + a deterministic non-empty replay fold");
    process.exit(1);
  }
  console.log(
    "[developer] OK — registry-backed executed outcome + a deterministic WORM replay fold.",
  );
}

// import.meta-guarded run: executes only when this file is the entrypoint, never when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
