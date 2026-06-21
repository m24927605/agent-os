/**
 * ToolRegistry — the single authoritative source for "which tools exist and what is each one's
 * side-effect contract". An in-memory `Map<name, ToolManifest>`.
 *
 * Registration is deny-by-default / fail-closed: every input goes through S1 `parseToolManifest`
 * (malformed => throw), and a duplicate `name` is rejected (throw, never silently overwritten).
 * This module owns ONLY existence + duplicate-rejection; it makes NO policy decisions (that is S3).
 * It imports nothing but S1's public surface within the same `tools` module.
 */
import { type ToolManifest, parseToolManifest } from "./manifest.js";

export class ToolRegistry {
  readonly #byName = new Map<string, ToolManifest>();

  /** Optionally seed initial manifests. Atomic: any failure throws and leaves no half registry. */
  constructor(seed?: readonly unknown[]) {
    if (seed === undefined) return;
    const staged = new Map<string, ToolManifest>();
    for (const input of seed) {
      const manifest = parseToolManifest(input);
      if (staged.has(manifest.name)) {
        throw new Error(`ToolRegistry: duplicate tool name "${manifest.name}"`);
      }
      staged.set(manifest.name, manifest);
    }
    for (const [name, manifest] of staged) this.#byName.set(name, manifest);
  }

  /** Register one manifest. Fail-closed: throws on malformed input or duplicate name. */
  register(input: unknown): void {
    const manifest = parseToolManifest(input);
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
