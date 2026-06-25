/**
 * SLICE-R9b-2b — the SHARED scope/projection helper that wires the R9b-1 governance projection into the
 * autonomous authorize path.
 *
 * `buildProjectionForCall(tc, bindings, lookupManifest, scope)` is the SINGLE place the four authorize
 * closures (personal / developer / enterprise / the Hermes-spawned exec bin) turn a proposed tool call
 * into an OPTIONAL credential-blind `GovernanceProjection`. It composes three gates IN ORDER and returns
 * `undefined` unless ALL pass:
 *
 *   (1) SCOPE — the tool's manifest is IN-SCOPE for `scope`:
 *         `effectful` (default): `sideEffect ∈ {write, destructive}` OR `requiresApproval`.
 *         `all`: also `read` / `none` (an enterprise-strict posture that asks AGT about everything).
 *       A read-only tool under the default `effectful` scope is OUT-OF-SCOPE -> `undefined` -> the AGT
 *       secondary later ABSTAINS without a transport round-trip (the latency cut).
 *   (2) PROJECTOR — the tool's `ExecToolBinding` declares a `governanceProjector` (effectful tools like
 *       `exec.run` do; read-only seed tools declare NONE). No projector => `undefined`.
 *   (3) VALIDATION — `binding.argSchema.safeParse(tc.args ?? {})` succeeds. A failure => `undefined`
 *       (the effect would deny the call anyway; we never hand unvalidated args to the projector).
 *
 * Only then: `governanceProjector(validated)` — built from the BINDING-VALIDATED args (the credential
 * SCREEN already ran BEFORE authorize), then R9b-1 best-effort shape-redacts. So the projection is
 * credential-blind by construction; the helper never touches raw env/stdin/file contents.
 *
 * VENDOR / COHESION: lives in the hermes adapter zone because it consumes the hermes-adapter
 * `ExecToolBinding` type. It is otherwise vendor-neutral: it takes a neutral `ToolManifest` LOOKUP
 * (not a vendor registry) + returns the neutral `GovernanceProjection`. The four closures import it —
 * the bin (same zone) directly, the surfaces (personal/developer/enterprise — NOT in the
 * `no-vendor-in-core` set) via the hermes barrel. A surface that has NO exec bindings passes
 * `bindings: undefined`, so the helper degrades to `undefined` => no projection attached => the
 * surface's authorize stays BYTE-IDENTICAL.
 */
import type { GovernanceProjection } from "../../../../policy/index.js";
import type { ToolManifest, ToolSideEffect } from "../../../../tools/index.js";
import type { ExecToolBinding } from "./exec-closed-loop.js";

/**
 * The AGT consult scope. `effectful` (default) consults AGT only for state-changing / approval-gated
 * tools — the autonomous-loop latency cut. `all` (enterprise-strict) also consults for read/none tools.
 */
export type AgtScope = "effectful" | "all";

/** The minimal proposed-call shape the helper inspects: the tool name + the brain's DECLARED args. */
export interface ProjectableCall {
  readonly tool: string;
  readonly args?: Record<string, unknown>;
}

/** A neutral manifest lookup (e.g. `registry.lookup.bind(registry)`); absent tool => undefined. */
export type ManifestLookup = (toolName: string) => ToolManifest | undefined;

/** IN-SCOPE iff the tool's side-effect / approval class is consulted for the given scope. */
function isInScope(manifest: ToolManifest, scope: AgtScope): boolean {
  if (scope === "all") return true;
  const effectful: ReadonlySet<ToolSideEffect> = new Set<ToolSideEffect>(["write", "destructive"]);
  // SLICE-CAP6 — a SEAL-PUNCHING containment (network-egress / host-fs-write) is ALWAYS in-scope under
  // `effectful`, regardless of sideEffect. A network READ (net.fetch: sideEffect:"read") still punches
  // the sandbox seal to the network, so its projection (networkHosts) MUST be built so the bin's egress
  // fold can GATE it — the whole point of CAP6. BYTE-IDENTICAL for the existing tools: every prior seed
  // tool is `containment:"in-sandbox"`, so this clause never fires for them.
  if (manifest.containment !== "in-sandbox") return true;
  return effectful.has(manifest.sideEffect) || manifest.requiresApproval;
}

/**
 * Build the OPTIONAL credential-blind {@link GovernanceProjection} for a proposed tool call, or
 * `undefined` when the call is out-of-scope / has no projector / fails arg validation / has no binding.
 * PURE: no I/O, no throw on normal input (a throwing projector is caught -> `undefined`, fail-closed:
 * a build error attaches no projection, so AGT abstains rather than the loop crashing).
 */
export function buildProjectionForCall(
  tc: ProjectableCall,
  bindings: ReadonlyMap<string, ExecToolBinding> | undefined,
  lookupManifest: ManifestLookup,
  scope: AgtScope,
): GovernanceProjection | undefined {
  // No bindings (a surface without exec bindings) => no projection -> byte-identical degrade.
  if (bindings === undefined) return undefined;

  // (1) SCOPE — needs the manifest. An unregistered tool (no manifest) is out-of-scope.
  const manifest = lookupManifest(tc.tool);
  if (manifest === undefined || !isInScope(manifest, scope)) return undefined;

  // (2) PROJECTOR — the binding must declare one (read-only tools declare NONE).
  const binding = bindings.get(tc.tool);
  if (binding === undefined || binding.governanceProjector === undefined) return undefined;

  // (3) VALIDATION — only hand VALIDATED args to the projector (else the effect would deny anyway).
  const parsed = binding.argSchema.safeParse(tc.args ?? {});
  if (!parsed.success) return undefined;

  try {
    return binding.governanceProjector(parsed.data);
  } catch {
    // Fail-closed: a throwing projector attaches NO projection (AGT abstains), never crashes the loop.
    return undefined;
  }
}
