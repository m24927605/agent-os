/**
 * SLICE-CAP3 — capability classifier + REFUSE-to-register gate (pure governance, no new tool).
 *
 * The capability-breadth spine is: build the fail-closed governance PRIMITIVE before you open the
 * capability that needs it. This module turns that ordering into an executable COMPOSITION-TIME gate:
 *
 *   1. `requiredPrimitives(manifest)` — a PURE classifier mapping a manifest's declared `containment`
 *      (+ destructive `sideEffect`) to the governance primitive(s) it requires to be safe.
 *   2. `WIRED_PRIMITIVES` — the set of primitives that are ACTUALLY WIRED today. EMPTY: egress (Slice 5),
 *      host-write (Slice 9), and approval (Slice 4) are all not-yet-built. Later slices extend this set.
 *   3. `assertRegisterable(manifest, wired)` — deny-by-default: if ANY required primitive is NOT in the
 *      wired set, it THROWS (refuses registration) with a STATIC, value-free reason. No throw when all
 *      required primitives are wired (or none are required).
 *
 * The `ToolRegistry` calls `assertRegisterable` at every registration seam, so a seal-punching tool
 * whose primitive is unwired CANNOT enter any registry. This is a REGISTRATION ADMISSION gate, NOT a
 * runtime DENY path — the PDP (`authorizeToolInvoke` + `evaluatePolicy`) remains the sole runtime DENY
 * authority. Today every shipped tool is `containment:"in-sandbox"` => requires [] => registers
 * unchanged (zero behavior change). The value is structural: Slice 4/5/6/9's tools become impossible to
 * register BEFORE their primitive exists.
 *
 * Pure, vendor-neutral core: imports ONLY the neutral `manifest` contract within the same `tools`
 * module. No state, no I/O, no vendor name.
 */
import type { ToolManifest } from "./manifest.js";

/**
 * The fail-closed governance primitives a seal-punching (or destructive) capability depends on:
 *   - `egress-allowlist`   — a per-sandbox outbound network allowlist (deny-all by default). Slice 5.
 *   - `host-write-target`  — a canonical, prefix-anchored host write-target allowlist. Slice 9.
 *   - `approval`           — `requiresApproval` actually wired into the pipeline approval stage. Slice 4.
 */
export type Primitive = "egress-allowlist" | "host-write-target" | "approval";

/**
 * Classify a manifest into the governance primitives it requires (PURE — same input, fresh array out):
 *   - `in-sandbox`     -> []                      (lives in the seal; rides pipeline + sandbox)
 *   - `network-egress` -> ["egress-allowlist"]    (punches the seal to the network)
 *   - `host-fs-write`  -> ["host-write-target"]   (punches the seal to the host disk)
 *   - AND if `sideEffect === "destructive"`, add `"approval"` (deduped) — a destructive effect must go
 *     through approval regardless of where it is contained (mirrors the manifest's destructive guardrail).
 */
export function requiredPrimitives(manifest: ToolManifest): readonly Primitive[] {
  const required: Primitive[] = [];
  switch (manifest.containment) {
    case "in-sandbox":
      break;
    case "network-egress":
      required.push("egress-allowlist");
      break;
    case "host-fs-write":
      required.push("host-write-target");
      break;
  }
  if (manifest.sideEffect === "destructive" && !required.includes("approval")) {
    required.push("approval");
  }
  return required;
}

/**
 * The governance primitives WIRED today. EMPTY by construction: none of egress-allowlist (Slice 5),
 * host-write-target (Slice 9), or approval (Slice 4) is built yet, so any capability that requires one
 * cannot register. This is a COMPOSITION-TIME FACT, not a permanent ban: a later slice that wires a
 * primitive adds it here, after which that primitive's tools become registerable.
 */
export const WIRED_PRIMITIVES: ReadonlySet<Primitive> = new Set();

/**
 * REFUSE-to-register gate (deny-by-default, fail-closed). Throws iff ANY primitive the manifest
 * requires is NOT in `wired`. The reason is STATIC and VALUE-FREE: it names the capability and the
 * unwired primitive name(s) only — never the manifest's args/resource/values. No throw when every
 * required primitive is wired (or the manifest requires none — e.g. an in-sandbox tool).
 *
 * `wired` defaults to `WIRED_PRIMITIVES` (empty today). It is an explicit parameter so a future slice
 * can prove "once the primitive is wired, the tool registers" by injecting an extended set.
 */
export function assertRegisterable(
  manifest: ToolManifest,
  wired: ReadonlySet<Primitive> = WIRED_PRIMITIVES,
): void {
  const missing = requiredPrimitives(manifest).filter((p) => !wired.has(p));
  if (missing.length > 0) {
    throw new Error(
      `capability "${manifest.name}" requires unwired governance primitive(s) [${missing.join(", ")}] — refused (deny-by-default at registration)`,
    );
  }
}
