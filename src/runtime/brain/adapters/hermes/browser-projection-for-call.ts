/**
 * SLICE-ACT5a+b — the PARALLEL scope/projection helper for the BROWSER family, typed to
 * {@link BrowserBinding}. The SIBLING of `buildActionProjectionForCall` (action-projection-for-call.ts).
 * It is a SEPARATE function — it does NOT widen / modify the exec or action helpers, keeping the families
 * low-coupled and the exec seam untouched.
 *
 * `buildBrowserProjectionForCall(tc, bindings, lookupManifest, scope)` composes the SAME three gates IN
 * ORDER and returns `undefined` unless ALL pass:
 *   (1) SCOPE — the tool's manifest is IN-SCOPE for `scope`. A seal-PUNCHING containment (network-egress)
 *       is ALWAYS in-scope under `effectful` (CAP6) — `browser.navigate` is network-egress, so its
 *       projection (host-only networkHosts) is ALWAYS built so the per-navigation egress fold can gate it.
 *       `browser.read` is in-sandbox + read => NOT in-scope under `effectful` => `undefined` (it has no
 *       host to gate; the data-OUT sanitizer in the effect governs its content, not the projection).
 *   (2) PROJECTOR — the binding exists (every BrowserBinding declares a governanceProjector).
 *   (3) VALIDATION — `binding.argSchema.safeParse(tc.args ?? {})` succeeds. A failure => `undefined`.
 *
 * Only then: `governanceProjector(validated)` — built from the BINDING-VALIDATED args; it emits ONLY safe
 * derived fields (host-only networkHosts / operationClass), NEVER the params. Credential-blind by
 * construction; the helper never touches a raw param value.
 *
 * VENDOR / COHESION: lives in the hermes adapter zone because it consumes the hermes-adapter
 * `BrowserBinding` type. Otherwise vendor-neutral: a neutral `ToolManifest` LOOKUP + the neutral
 * `GovernanceProjection` return. A surface with NO browser bindings passes `bindings: undefined`, so the
 * helper degrades to `undefined` (byte-identical for that surface).
 */
import type { GovernanceProjection } from "../../../../policy/index.js";
import type { ToolManifest, ToolSideEffect } from "../../../../tools/index.js";
import type { BrowserBinding } from "./browser-closed-loop.js";
import type {
  AgtScope,
  ManifestLookup,
  ProjectableCall,
} from "./governance-projection-for-call.js";

// Re-export the neutral scope/lookup/call types so a consumer of the BROWSER helper need not also import
// the exec/action helper barrels. These are vendor-neutral, family-agnostic types.
export type { AgtScope, ManifestLookup, ProjectableCall };

/** IN-SCOPE iff the tool's side-effect / approval / containment class is consulted for the given scope. */
function isInScope(manifest: ToolManifest, scope: AgtScope): boolean {
  if (scope === "all") return true;
  const effectful: ReadonlySet<ToolSideEffect> = new Set<ToolSideEffect>(["write", "destructive"]);
  // A seal-PUNCHING containment (network-egress / host-fs-write) is ALWAYS in-scope under `effectful`,
  // regardless of sideEffect — browser.navigate is a network READ that still punches the seal to the
  // network, so its projection (networkHosts) MUST be built so the egress fold can GATE it (the CAP6
  // rule). browser.read is in-sandbox + read => NOT in-scope (no host to gate).
  if (manifest.containment !== "in-sandbox") return true;
  return effectful.has(manifest.sideEffect) || manifest.requiresApproval;
}

/**
 * Build the OPTIONAL credential-blind {@link GovernanceProjection} for a proposed BROWSER call, or
 * `undefined` when out-of-scope / no projector / fails arg validation / has no binding. PURE: no I/O, no
 * throw on normal input (a throwing projector is caught -> `undefined`, fail-closed).
 */
export function buildBrowserProjectionForCall(
  tc: ProjectableCall,
  bindings: ReadonlyMap<string, BrowserBinding> | undefined,
  lookupManifest: ManifestLookup,
  scope: AgtScope,
): GovernanceProjection | undefined {
  if (bindings === undefined) return undefined;

  // (1) SCOPE — needs the manifest. An unregistered tool (no manifest) is out-of-scope.
  const manifest = lookupManifest(tc.tool);
  if (manifest === undefined || !isInScope(manifest, scope)) return undefined;

  // (2) PROJECTOR — the binding must exist (every BrowserBinding declares a governanceProjector).
  const binding = bindings.get(tc.tool);
  if (binding === undefined) return undefined;

  // (3) VALIDATION — only hand VALIDATED args to the projector (else the effect would deny anyway).
  const parsed = binding.argSchema.safeParse(tc.args ?? {});
  if (!parsed.success) return undefined;

  try {
    return binding.governanceProjector(parsed.data);
  } catch {
    // Fail-closed: a throwing projector attaches NO projection, never crashes the loop.
    return undefined;
  }
}
