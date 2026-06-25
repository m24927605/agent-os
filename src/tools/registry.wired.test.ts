/**
 * SLICE-CAP4b — `ToolRegistry` gains an OPTIONAL `wired` constructor param so a composition that has
 * actually WIRED a governance primitive (e.g. injected an `approve` seam => "approval") can register a
 * capability that requires it. The CAP3 gate (`assertRegisterable(manifest, wired)`) is already
 * parameterized on `wired`; CAP4b threads an INSTANCE-held `wired` through BOTH the constructor staging
 * loop AND `register()`.
 *
 * DEFAULT BYTE-IDENTICAL: omit `wired` => `WIRED_PRIMITIVES` (empty today) => identical to pre-CAP4b — a
 * destructive (approval-requiring) tool is REFUSED (CAP3 gate: "approval" is unwired). The existing
 * `registry.test.ts` (which never passes `wired`) stays green, proving the default path is unchanged.
 *
 * What this file pins (RED-first; the `wired` param does not exist yet):
 *  - `new ToolRegistry([<destructive in-sandbox manifest>], new Set(["approval"]))` REGISTERS OK (the
 *    composition wired "approval", so the destructive tool's required primitive is satisfied);
 *  - `register(<that destructive manifest>)` after constructing with `new Set(["approval"])` ALSO OK
 *    (the instance-held wired flows through register, not just the constructor staging loop);
 *  - `new ToolRegistry([<that destructive manifest>])` (DEFAULT empty wired) THROWS (CAP3 gate: approval
 *    unwired) and the refused manifest does NOT enter the registry;
 *  - a NON-destructive in-sandbox tool registers under EITHER wired set (requires no primitive).
 *
 * NON-VACUITY: a mutation that ignores the `wired` param (always uses the default WIRED_PRIMITIVES) flips
 * the "wired allows registration" tests RED — the destructive tool would be refused even WITH
 * `new Set(["approval"])`.
 */
import { describe, expect, it } from "vitest";
import type { Primitive } from "./capability-containment.js";
import type { ToolManifest } from "./manifest.js";
import { ToolRegistry } from "./registry.js";

/** A SYNTHETIC destructive in-sandbox tool: requires the "approval" primitive (CAP3 classifier). */
const destructive: ToolManifest = {
  name: "synthetic.destructive",
  version: "1.0.0",
  description: "a synthetic destructive tool (requires approval)",
  action: "tool:invoke",
  resourcePattern: "synthetic/destructive",
  sideEffect: "destructive",
  idempotent: false,
  requiresApproval: true,
  bundleRefOnly: false,
  containment: "in-sandbox",
};

const APPROVAL_WIRED: ReadonlySet<Primitive> = new Set<Primitive>(["approval"]);

describe("CAP4b ToolRegistry — optional `wired` param unlocks approval-requiring tools", () => {
  it("constructor seed + wired {approval}: a destructive tool REGISTERS (approval wired)", () => {
    const reg = new ToolRegistry([{ ...destructive }], APPROVAL_WIRED);
    expect(reg.has("synthetic.destructive")).toBe(true);
    expect(reg.lookup("synthetic.destructive")?.requiresApproval).toBe(true);
  });

  it("register() honors the INSTANCE-held wired {approval} (not just the constructor staging loop)", () => {
    // Construct empty (no seed) but WITH wired {approval}; the instance-held wired must flow into register.
    const reg = new ToolRegistry(undefined, APPROVAL_WIRED);
    expect(() => reg.register({ ...destructive })).not.toThrow();
    expect(reg.has("synthetic.destructive")).toBe(true);
  });

  it("DEFAULT empty wired: the SAME destructive tool is REFUSED (CAP3 gate — approval unwired)", () => {
    // NON-VACUITY twin of the first test: omit `wired` => default WIRED_PRIMITIVES (empty) => refused.
    expect(() => new ToolRegistry([{ ...destructive }])).toThrow();
    const reg = new ToolRegistry(undefined); // default wired
    expect(() => reg.register({ ...destructive })).toThrow();
    expect(reg.has("synthetic.destructive")).toBe(false);
  });

  it("a NON-destructive in-sandbox tool registers under EITHER wired set (requires no primitive)", () => {
    const readOnly: ToolManifest = {
      ...destructive,
      name: "synthetic.read",
      sideEffect: "read",
      idempotent: true,
      requiresApproval: false,
    };
    expect(() => new ToolRegistry([{ ...readOnly }])).not.toThrow();
    expect(() => new ToolRegistry([{ ...readOnly }], APPROVAL_WIRED)).not.toThrow();
  });
});
