/**
 * ToolRegistry — the single authoritative source for "which tools exist and what is each one's
 * side-effect contract". An in-memory `Map<name, ToolManifest>`.
 *
 * Registration is deny-by-default / fail-closed: every input goes through S1 `parseToolManifest`
 * (malformed => throw), then the CAP3 REFUSE-to-register gate `assertRegisterable` (a seal-punching
 * capability whose fail-closed primitive is unwired => throw, never enters the registry), and a
 * duplicate `name` is rejected (throw, never silently overwritten). This module owns ONLY existence +
 * duplicate-rejection + the composition-time admission gate; it makes NO RUNTIME policy decisions (the
 * PDP / `authorizeToolInvoke` remains the sole runtime DENY authority). It imports nothing but the
 * neutral S1 contract + the CAP3 classifier/gate within the same `tools` module.
 */
import { type Primitive, WIRED_PRIMITIVES, assertRegisterable } from "./capability-containment.js";
import { type ToolManifest, parseToolManifest } from "./manifest.js";

export class ToolRegistry {
  readonly #byName = new Map<string, ToolManifest>();
  /**
   * SLICE-CAP4b — the governance primitives this registry's COMPOSITION has actually WIRED. The CAP3 gate
   * (`assertRegisterable(manifest, wired)`) was already parameterized on `wired`; this instance-held set is
   * threaded into BOTH the constructor staging loop AND `register()`, so a composition that injected a
   * wiring for a primitive (e.g. an `approve` seam => "approval") can register a capability that requires it.
   * DEFAULT = `WIRED_PRIMITIVES` (empty today) => byte-identical to pre-CAP4b: an approval-requiring tool is
   * refused unless the composition explicitly passes a wired set containing its required primitive.
   */
  readonly #wired: ReadonlySet<Primitive>;

  /**
   * Optionally seed initial manifests. Atomic: any failure throws and leaves no half registry. `wired`
   * (SLICE-CAP4b) is the set of governance primitives this composition has wired; it defaults to
   * `WIRED_PRIMITIVES` (empty) so the omitted-arg path is byte-identical to today.
   */
  constructor(seed?: readonly unknown[], wired: ReadonlySet<Primitive> = WIRED_PRIMITIVES) {
    this.#wired = wired;
    if (seed === undefined) return;
    const staged = new Map<string, ToolManifest>();
    for (const input of seed) {
      const manifest = parseToolManifest(input);
      // CAP3 — composition-time deny-by-default: a seal-punching capability whose primitive is unwired
      // is refused BEFORE it can enter the (staged) registry. Throws out of construction (atomic: no
      // half registry, since #byName is only populated after the whole seed stages cleanly). `#wired`
      // is the composition's wired set (CAP4b) — default empty => identical to pre-CAP4b.
      assertRegisterable(manifest, this.#wired);
      if (staged.has(manifest.name)) {
        throw new Error(`ToolRegistry: duplicate tool name "${manifest.name}"`);
      }
      staged.set(manifest.name, manifest);
    }
    for (const [name, manifest] of staged) this.#byName.set(name, manifest);
  }

  /**
   * Register one manifest. Fail-closed: throws on malformed input, on a CAP3 refusal (a seal-punching
   * capability whose governance primitive is unwired in THIS registry's `#wired` set), or on a duplicate
   * name. A refused manifest never enters the registry (the throw precedes the `#byName.set`).
   */
  register(input: unknown): void {
    const manifest = parseToolManifest(input);
    assertRegisterable(manifest, this.#wired);
    if (this.#byName.has(manifest.name)) {
      throw new Error(`ToolRegistry: duplicate tool name "${manifest.name}"`);
    }
    this.#byName.set(manifest.name, manifest);
  }

  has(name: string): boolean {
    return this.#byName.has(name);
  }

  lookup(name: string): ToolManifest | undefined {
    return this.#byName.get(name);
  }

  list(): readonly ToolManifest[] {
    return [...this.#byName.values()];
  }
}
