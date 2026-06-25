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
import { assertRegisterable } from "./capability-containment.js";
import { type ToolManifest, parseToolManifest } from "./manifest.js";

export class ToolRegistry {
  readonly #byName = new Map<string, ToolManifest>();

  /** Optionally seed initial manifests. Atomic: any failure throws and leaves no half registry. */
  constructor(seed?: readonly unknown[]) {
    if (seed === undefined) return;
    const staged = new Map<string, ToolManifest>();
    for (const input of seed) {
      const manifest = parseToolManifest(input);
      // CAP3 — composition-time deny-by-default: a seal-punching capability whose primitive is unwired
      // is refused BEFORE it can enter the (staged) registry. Throws out of construction (atomic: no
      // half registry, since #byName is only populated after the whole seed stages cleanly).
      assertRegisterable(manifest);
      if (staged.has(manifest.name)) {
        throw new Error(`ToolRegistry: duplicate tool name "${manifest.name}"`);
      }
      staged.set(manifest.name, manifest);
    }
    for (const [name, manifest] of staged) this.#byName.set(name, manifest);
  }

  /**
   * Register one manifest. Fail-closed: throws on malformed input, on a CAP3 refusal (a seal-punching
   * capability whose governance primitive is unwired), or on a duplicate name. A refused manifest never
   * enters the registry (the throw precedes the `#byName.set`).
   */
  register(input: unknown): void {
    const manifest = parseToolManifest(input);
    assertRegisterable(manifest);
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
