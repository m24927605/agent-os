/**
 * SLICE-ACT1 — the PARALLEL scope/projection helper for the ACTION family, typed to {@link ActionBinding}.
 *
 * This is the SIBLING of `buildProjectionForCall` (governance-projection-for-call.ts, typed to
 * `ExecToolBinding`). It is a SEPARATE function — it does NOT widen / modify the exec helper, keeping the
 * two families low-coupled and the exec seam untouched.
 *
 * `buildActionProjectionForCall(tc, bindings, lookupManifest, scope)` composes the SAME three gates IN
 * ORDER and returns `undefined` unless ALL pass:
 *   (1) SCOPE — the tool's manifest is IN-SCOPE for `scope`. A seal-PUNCHING containment
 *       (network-egress / host-fs-write) is ALWAYS in-scope under `effectful` (CAP6) — gmail.send /
 *       drive.read are network-egress, so their projection (networkHosts) is ALWAYS built so the egress
 *       fold can gate them.
 *   (2) PROJECTOR — the action binding declares an `actionProjector` (REQUIRED on every ActionBinding,
 *       unlike a read-only exec seed tool that declares none).
 *   (3) VALIDATION — `binding.argSchema.safeParse(tc.args ?? {})` succeeds. A failure => `undefined` (the
 *       effect would deny the call anyway; we never hand unvalidated args to the projector).
 *
 * Only then: `actionProjector(validated)` — built from the BINDING-VALIDATED args; it emits ONLY safe
 * derived fields (operationClass / networkHosts / destructiveFlags), NEVER the params. So the projection
 * is credential-blind by construction; the helper never touches a raw param value.
 *
 * VENDOR / COHESION: lives in the hermes adapter zone because it consumes the hermes-adapter
 * `ActionBinding` type. It is otherwise vendor-neutral: a neutral `ToolManifest` LOOKUP + the neutral
 * `GovernanceProjection` return. A surface with NO action bindings passes `bindings: undefined`, so the
 * helper degrades to `undefined` (no projection attached) — byte-identical for that surface.
 */
import type { GovernanceProjection } from "../../../../policy/index.js";
import type { ToolManifest, ToolSideEffect } from "../../../../tools/index.js";
import type { ActionBinding } from "./action-closed-loop.js";
import type {
  AgtScope,
  ManifestLookup,
  ProjectableCall,
} from "./governance-projection-for-call.js";

// Re-export the neutral scope/lookup/call types so a consumer of the ACTION helper need not also import
// the exec helper barrel. These are vendor-neutral, family-agnostic types (no ExecToolBinding edge).
export type { AgtScope, ManifestLookup, ProjectableCall };

/** IN-SCOPE iff the tool's side-effect / approval / containment class is consulted for the given scope. */
function isInScope(manifest: ToolManifest, scope: AgtScope): boolean {
  if (scope === "all") return true;
  const effectful: ReadonlySet<ToolSideEffect> = new Set<ToolSideEffect>(["write", "destructive"]);
  // A seal-PUNCHING containment (network-egress / host-fs-write) is ALWAYS in-scope under `effectful`,
  // regardless of sideEffect — a network READ (drive.read) still punches the seal to the network, so its
  // projection (networkHosts) MUST be built so the egress fold can GATE it (the CAP6 rule, mirrored from
  // the exec helper's `isInScope`). gmail.send (destructive) is in-scope by sideEffect too.
  if (manifest.containment !== "in-sandbox") return true;
  return effectful.has(manifest.sideEffect) || manifest.requiresApproval;
}

/**
 * Build the OPTIONAL credential-blind {@link GovernanceProjection} for a proposed ACTION call, or
 * `undefined` when the call is out-of-scope / has no projector / fails arg validation / has no binding.
 * PURE: no I/O, no throw on normal input (a throwing projector is caught -> `undefined`, fail-closed).
 */
export function buildActionProjectionForCall(
  tc: ProjectableCall,
  bindings: ReadonlyMap<string, ActionBinding> | undefined,
  lookupManifest: ManifestLookup,
  scope: AgtScope,
): GovernanceProjection | undefined {
  // No bindings (a surface without action bindings) => no projection -> byte-identical degrade.
  if (bindings === undefined) return undefined;

  // (1) SCOPE — needs the manifest. An unregistered tool (no manifest) is out-of-scope.
  const manifest = lookupManifest(tc.tool);
  if (manifest === undefined || !isInScope(manifest, scope)) return undefined;

  // (2) PROJECTOR — the binding must exist (every ActionBinding declares an actionProjector).
  const binding = bindings.get(tc.tool);
  if (binding === undefined) return undefined;

  // (3) VALIDATION — only hand VALIDATED args to the projector (else the effect would deny anyway).
  const parsed = binding.argSchema.safeParse(tc.args ?? {});
  if (!parsed.success) return undefined;

  try {
    return binding.actionProjector(parsed.data);
  } catch {
    // Fail-closed: a throwing projector attaches NO projection, never crashes the loop.
    return undefined;
  }
}
