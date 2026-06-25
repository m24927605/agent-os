/**
 * SLICE-EXEC3a — wire the REAL exec effect into the DHB3 closed loop SAFELY (Design A: composer-held
 * command-template binding + ephemeral per-loop sandbox + effect injected ABOVE the closed loop).
 *
 * This is the highest-risk seam in the product: it connects an UNTRUSTED brain to REAL command
 * execution. The whole safety story rests on TWO layers, both enforced here:
 *
 *   1. deny-by-default name check — every proposal re-enters `runGovernedToolCall` -> `authorize`, so a
 *      tool name that is not registered is denied at the policy stage and never reaches the effect
 *      (this layer lives in the injected `baseDeps.authorize`, reused unchanged).
 *   2. argv-binding (NEW, the core of this slice) — the brain proposes only a REGISTERED tool name +
 *      DECLARED params; it NEVER supplies `argv[0]` / a raw argv / a shell string. The COMPOSER holds a
 *      side `Map<toolName, ExecToolBinding>` (parallel to the ToolRegistry): the binding fixes
 *      `argvPrefix`, a STRICT `argSchema`, and a pure `toArgv` builder. `bindingWrappedExecEffect`:
 *        (a) looks up the binding — ABSENT => fail-closed deny, `makeExecEffect` NOT called;
 *        (b) validates the brain's declared args with the STRICT schema — any unknown/extra/missing key
 *            => deny, `makeExecEffect` NOT called (a smuggled `argv`/`; rm -rf /` key cannot pass);
 *        (c) builds `argv = [...argvPrefix, ...toArgv(validated)]` as a PURE STRING VECTOR — never a
 *            shell string, never `sh -c` / `bash -c`;
 *        (d) delegates to the REAL `makeExecEffect` (credential-blind env screen + output redact + cap +
 *            fail-closed) for that fixed `(substrate, sandboxId)`.
 *      So argv is constructed in exactly ONE place — the composer's binding — never from raw brain input.
 *
 * `runExecClosedLoop` owns the EPHEMERAL per-loop sandbox: it create+starts the sandbox BEFORE the loop,
 * injects the binding-wrapped effect into the caller's `baseDeps`, runs `runClosedLoop`, and destroys
 * the sandbox in a `finally` — fail-closed teardown even on a thrown transport or a `maxTurns` stop, so
 * host blast-radius is bounded to one short-lived sandbox.
 *
 * HONEST BOUNDARY: this proves the JOIN logic + all invariants against a Fake substrate + an in-tree
 * fake `hermes acp`. A real command in a real sandbox + a real Hermes return-edge is EXEC3b (live).
 * Redaction is best-effort (known secret shapes only) — the REAL credential boundary is a sandbox
 * provisioned with ZERO real credentials + NO egress, not redaction.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone. Imports ONLY the NEUTRAL public barrels
 * (substrate, orchestration types) + the in-module `runClosedLoop` — no deep cross-module import, no
 * vendor named in core. Exported via the hermes barrel.
 */
import type { z } from "zod";
import type { EffectResult, GovernedToolCallDeps } from "../../../../orchestration/index.js";
import type { GovernanceProjection } from "../../../../policy/index.js";
import {
  type ExecCapableSandboxAdapter,
  type ExecSecretDetector,
  makeExecEffect,
} from "../../../substrate/index.js";
import { type ClosedLoopOptions, type ClosedLoopResult, runClosedLoop } from "./closed-loop.js";

/**
 * The COMPOSER-HELD binding for one registered exec tool. The brain supplies only the DECLARED params
 * (validated by `argSchema`); the composer fixes `argvPrefix` and how params become positional/flag
 * args (`toArgv`), and OPTIONALLY a placeholder/bundleRef env (`toEnv`). argv is therefore a pure
 * string vector built by the composer — never a shell string, never `sh -c` / `bash -c`, never raw
 * brain input.
 */
export interface ExecToolBinding {
  /** The fixed program + leading args the composer owns (e.g. ["echo"], ["ls"]). Never brain-supplied. */
  readonly argvPrefix: readonly string[];
  /**
   * STRICT schema for the brain's DECLARED params. `.strict()` (no unknown keys) is REQUIRED: a smuggled
   * `argv` / `; rm -rf /` extra key must fail validation, so it can never reach the effect.
   */
  readonly argSchema: z.ZodType<unknown>;
  /** Build the trailing positional/flag args from the VALIDATED params. Pure: returns a string vector. */
  readonly toArgv: (validatedArgs: unknown) => readonly string[];
  /**
   * OPTIONAL composer-built env (placeholder/bundleRef strings only). A raw secret here is rejected by
   * `makeExecEffect`'s credential-blind INPUT guard BEFORE any exec — the substrate/process never sees it.
   */
  readonly toEnv?: (validatedArgs: unknown) => Readonly<Record<string, string>>;
  /**
   * SLICE-R9b-2b — OPTIONAL tool-declared governance projector. An EFFECTFUL tool (e.g. `exec.run`) that
   * wants the AGT advisory to opine on it declares a thin wrapper around its R9b-1 projection builder
   * (over the VALIDATED args — the screen already ran, then the projection best-effort redacts). A
   * READ-ONLY tool (echo/ls/cat/...) declares NONE: with no projector it is OUT-OF-SCOPE by construction,
   * so the AGT secondary abstains (no transport round-trip). The projector is PURE: validated args ->
   * a credential-blind {@link GovernanceProjection}. Never given raw args — `buildProjectionForCall`
   * validates with `argSchema` first.
   */
  readonly governanceProjector?: (validatedArgs: unknown) => GovernanceProjection;
}

/** Options for {@link bindingWrappedExecEffect} (forwarded to `makeExecEffect`). */
export interface BindingWrappedExecEffectOptions {
  /** Cap (UTF-8 bytes) for the redacted combined output written to `EffectResult.detail`. */
  readonly maxOutputBytes?: number;
  /** Secret detector for the credential-blind INPUT guard. Defaults to the `redactSecrets`-changed test. */
  readonly detectSecret?: ExecSecretDetector;
}

/** The shape the wrapper governs — a proposal carrying the brain's DECLARED args (NOT argv). */
interface BoundExecCall {
  readonly tool: string;
  readonly context: unknown;
  readonly args?: Record<string, unknown>;
}

/**
 * Wrap the REAL `makeExecEffect` with the argv-binding seam. The returned function is the pipeline's
 * injected `effect` for a fixed `(substrate, sandboxId)`. It NEVER lets the brain's raw args become
 * argv: argv is built ONLY from the binding's `argvPrefix` + `toArgv(validated)`.
 *
 * Fail-closed at every gate, BEFORE the real effect:
 *   - no binding for the tool        => `{ok:false}`; `makeExecEffect` NOT called.
 *   - invalid args (strict schema)   => `{ok:false}`; `makeExecEffect` NOT called.
 * Only a fully validated proposal builds a pure argv vector and reaches `makeExecEffect`.
 */
export function bindingWrappedExecEffect(
  substrate: ExecCapableSandboxAdapter,
  sandboxId: string,
  bindings: ReadonlyMap<string, ExecToolBinding>,
  opts: BindingWrappedExecEffectOptions = {},
): (toolCall: BoundExecCall) => Promise<EffectResult> {
  const execEffect = makeExecEffect(substrate, sandboxId, {
    ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
    ...(opts.detectSecret !== undefined ? { detectSecret: opts.detectSecret } : {}),
  });

  return async (toolCall: BoundExecCall): Promise<EffectResult> => {
    // (a) deny-by-default: a tool with no composer binding NEVER executes (parallel to the registry).
    const binding = bindings.get(toolCall.tool);
    if (binding === undefined) {
      return { ok: false, detail: `no exec binding for ${toolCall.tool} (deny-by-default)` };
    }

    // (b) STRICT validation of the brain's DECLARED args. Unknown/extra/missing key => deny; the real
    // effect is NEVER reached. A smuggled `argv`/shell-injection key fails here.
    const parsed = binding.argSchema.safeParse(toolCall.args ?? {});
    if (!parsed.success) {
      return { ok: false, detail: "invalid exec args (deny)" };
    }
    const validated = parsed.data;

    // (c) build argv as a PURE STRING VECTOR from the composer's prefix + the validated params. The
    // brain's args are DECLARED PARAMS, NOT argv — this is the ONLY place argv is constructed.
    let argv: readonly string[];
    let env: Readonly<Record<string, string>> | undefined;
    try {
      argv = [...binding.argvPrefix, ...binding.toArgv(validated)];
      env = binding.toEnv?.(validated);
    } catch {
      // A binding builder that throws is fail-closed (deny) — never an unbounded crash to the loop.
      return { ok: false, detail: "exec binding build error (deny)" };
    }

    // (d) delegate to the REAL credential-blind, fail-closed, capped exec effect.
    return execEffect({
      context: toolCall.context,
      args: { argv, ...(env !== undefined ? { env } : {}) },
    });
  };
}

/** Options for {@link runExecClosedLoop}. */
export interface ExecClosedLoopOptions extends ClosedLoopOptions {
  /** Cap (UTF-8 bytes) for the redacted combined output. Forwarded to the binding-wrapped effect. */
  readonly maxOutputBytes?: number;
  /** Secret detector for the credential-blind INPUT guard. Defaults to the `redactSecrets`-changed test. */
  readonly detectSecret?: ExecSecretDetector;
  /** SandboxSpec for the ephemeral per-loop sandbox (image/labels). */
  readonly sandboxSpec?: { readonly image?: string; readonly labels?: Record<string, string> };
}

/**
 * Run the closed agentic loop with the REAL exec effect over an EPHEMERAL per-loop sandbox.
 *
 * Lifecycle (fail-closed): create + start an ephemeral sandbox BEFORE the loop; build the
 * binding-wrapped effect for that `(substrate, sandboxId)`; inject it into the caller's `baseDeps`
 * (everything EXCEPT `effect` — screen/authorize/cost/appender are the caller's governance); run
 * `runClosedLoop`; ALWAYS `destroySandbox` in a `finally` — even on a thrown transport or a `maxTurns`
 * stop. So the host blast-radius is bounded to one short-lived sandbox.
 *
 * `maxTurns` defaults TIGHT (the first real-effect loop should bound blast radius), overridable via opts.
 */
const DEFAULT_EXEC_MAX_TURNS = 4;

export async function runExecClosedLoop<R>(
  transport: Parameters<typeof runClosedLoop>[0],
  substrate: ExecCapableSandboxAdapter,
  baseDeps: Omit<GovernedToolCallDeps<BoundExecCall, R>, "effect">,
  bindings: ReadonlyMap<string, ExecToolBinding>,
  context: unknown,
  intent: string,
  opts: ExecClosedLoopOptions = {},
): Promise<ClosedLoopResult<R>> {
  // Create the ephemeral sandbox BEFORE the loop (containment: one short-lived sandbox per loop).
  const created = await substrate.createSandbox(context, opts.sandboxSpec ?? {});
  if (created.status !== "ok") {
    throw new Error(`exec-closed-loop: sandbox create denied — ${created.reason}`);
  }
  const sandboxId = created.sandboxId;

  try {
    const started = await substrate.startSandbox(context, sandboxId);
    if (started.status !== "ok") {
      throw new Error(`exec-closed-loop: sandbox start denied — ${started.reason}`);
    }

    const effect = bindingWrappedExecEffect(substrate, sandboxId, bindings, {
      ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
      ...(opts.detectSecret !== undefined ? { detectSecret: opts.detectSecret } : {}),
    });

    const deps: GovernedToolCallDeps<BoundExecCall, R> = { ...baseDeps, effect };

    return await runClosedLoop(transport, deps, context, intent, {
      maxTurns: opts.maxTurns ?? DEFAULT_EXEC_MAX_TURNS,
    });
  } finally {
    // Fail-closed teardown: destroy the ephemeral sandbox even on throw / maxTurns. A destroy failure is
    // swallowed (best-effort) so the original loop error/result is what propagates.
    try {
      await substrate.destroySandbox(context, sandboxId);
    } catch {
      // best-effort teardown; never mask the loop's own outcome
    }
  }
}
