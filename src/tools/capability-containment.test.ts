/**
 * SLICE-CAP3 — capability classifier + REFUSE-to-register gate: tests (RED-first).
 *
 * The spine of capability-breadth is "build the fail-closed primitive BEFORE you open the
 * capability". CAP3 turns that into an executable COMPOSITION-TIME gate: a capability that punches
 * the sandbox seal (network egress / host-fs write / a destructive effect) and whose fail-closed
 * governance primitive is NOT YET WIRED cannot even REGISTER. Today every shipped tool is
 * `containment:"in-sandbox"` so it needs NO primitive and registers unchanged (zero behavior change).
 *
 * These tests pin, by command:
 *   (1) the PURE classifier `requiredPrimitives(manifest)` — the (containment x destructive) -> primitive table;
 *   (2) the gate `assertRegisterable` + the `ToolRegistry` integration — a seal-punching tool whose
 *       primitive is unwired is REFUSED at registration (throws out of construct/register, never enters);
 *   (3) the NON-VACUITY mutation hook — skipping the gate would let a network-egress tool register (flips RED);
 *   (4) WIRED injection — once a primitive IS in the wired set, the same tool registers (gated-on-wired, not a ban);
 *   (5) WIRED_PRIMITIVES is EMPTY today (a composition-time fact later slices extend).
 *
 * This module imports ONLY the neutral `tools` surface (vendor-neutral core).
 */
import { describe, expect, it } from "vitest";
import {
  type Primitive,
  WIRED_PRIMITIVES,
  assertRegisterable,
  requiredPrimitives,
} from "./capability-containment.js";
import type { ToolManifest } from "./manifest.js";
import { ToolRegistry } from "./registry.js";

/** A base in-sandbox read manifest; tweak `containment`/`sideEffect` per case via spread. */
const base: ToolManifest = {
  name: "cap.tool",
  version: "1.0.0",
  description: "a synthetic capability for the classifier/gate tests",
  action: "tool:invoke",
  resourcePattern: "cap/tool",
  sideEffect: "read",
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox",
};

describe("requiredPrimitives — the (containment x destructive) -> primitive classifier (pure)", () => {
  it("in-sandbox read => [] (lives in the seal; rides pipeline+sandbox; no primitive)", () => {
    expect(requiredPrimitives({ ...base, containment: "in-sandbox" })).toEqual([]);
  });

  it("network-egress => [egress-allowlist]", () => {
    expect(requiredPrimitives({ ...base, containment: "network-egress" })).toEqual([
      "egress-allowlist",
    ]);
  });

  it("host-fs-write => [host-write-target]", () => {
    expect(requiredPrimitives({ ...base, containment: "host-fs-write" })).toEqual([
      "host-write-target",
    ]);
  });

  it("destructive in-sandbox => [approval] (destructive always needs approval)", () => {
    // A destructive manifest must declare requiresApproval:true (schema guardrail B).
    const m: ToolManifest = {
      ...base,
      containment: "in-sandbox",
      sideEffect: "destructive",
      idempotent: false,
      requiresApproval: true,
    };
    expect(requiredPrimitives(m)).toEqual(["approval"]);
  });

  it("destructive network-egress => [egress-allowlist, approval] (deduped, order-insensitive)", () => {
    const m: ToolManifest = {
      ...base,
      containment: "network-egress",
      sideEffect: "destructive",
      idempotent: false,
      requiresApproval: true,
    };
    const got = requiredPrimitives(m);
    expect([...got].sort()).toEqual(["approval", "egress-allowlist"]);
    // deduped: no primitive appears twice
    expect(new Set(got).size).toBe(got.length);
  });

  it("is pure: same input => same output, returns a fresh array each call (no shared mutable state)", () => {
    const m: ToolManifest = { ...base, containment: "network-egress" };
    const a = requiredPrimitives(m);
    const b = requiredPrimitives(m);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe("WIRED_PRIMITIVES — composition-time fact (EMPTY today; later slices extend)", () => {
  it("is empty: no governance primitive is wired yet (egress[S5]/host-write[S9]/approval[S4])", () => {
    expect(WIRED_PRIMITIVES.size).toBe(0);
  });
});

describe("assertRegisterable — the deny-by-default registration gate", () => {
  it("in-sandbox read => does NOT throw (no required primitive)", () => {
    expect(() => assertRegisterable({ ...base, containment: "in-sandbox" })).not.toThrow();
  });

  it("in-sandbox write => does NOT throw (write inside the seal needs no primitive)", () => {
    const m: ToolManifest = {
      ...base,
      containment: "in-sandbox",
      sideEffect: "write",
      idempotent: false,
    };
    expect(() => assertRegisterable(m)).not.toThrow();
  });

  it("network-egress => THROWS (egress-allowlist not wired)", () => {
    expect(() => assertRegisterable({ ...base, containment: "network-egress" })).toThrow();
  });

  it("host-fs-write => THROWS (host-write-target not wired)", () => {
    expect(() => assertRegisterable({ ...base, containment: "host-fs-write" })).toThrow();
  });

  it("destructive in-sandbox => THROWS (approval not wired)", () => {
    const m: ToolManifest = {
      ...base,
      containment: "in-sandbox",
      sideEffect: "destructive",
      idempotent: false,
      requiresApproval: true,
    };
    expect(() => assertRegisterable(m)).toThrow();
  });

  it("the refuse error is STATIC + value-free: names the capability + the unwired primitive(s), no arg/value leak", () => {
    const m: ToolManifest = {
      ...base,
      name: "net.fetch",
      containment: "network-egress",
      resourcePattern: "net/fetch",
    };
    let caught: unknown;
    try {
      assertRegisterable(m);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("net.fetch");
    expect(msg).toContain("egress-allowlist");
    expect(msg).toContain("refused");
    // value-free: the resourcePattern / args are NOT leaked into the reason.
    expect(msg).not.toContain("net/fetch");
  });

  it("WIRED injection: assertRegisterable(networkManifest, Set([egress-allowlist])) does NOT throw", () => {
    const m: ToolManifest = { ...base, containment: "network-egress" };
    const wired: ReadonlySet<Primitive> = new Set(["egress-allowlist"]);
    expect(() => assertRegisterable(m, wired)).not.toThrow();
  });

  it("WIRED injection is per-primitive: a destructive network tool needs BOTH wired to pass", () => {
    const m: ToolManifest = {
      ...base,
      containment: "network-egress",
      sideEffect: "destructive",
      idempotent: false,
      requiresApproval: true,
    };
    // only egress wired -> still refused (approval missing)
    expect(() => assertRegisterable(m, new Set(["egress-allowlist"]))).toThrow();
    // both wired -> passes
    expect(() => assertRegisterable(m, new Set(["egress-allowlist", "approval"]))).not.toThrow();
  });
});

describe("ToolRegistry — the gate is wired into registration (fail-closed)", () => {
  it("an in-sandbox read manifest registers fine (constructor + register)", () => {
    const r = new ToolRegistry([{ ...base, containment: "in-sandbox" }]);
    expect(r.has("cap.tool")).toBe(true);
    r.register({ ...base, name: "cap.tool2", containment: "in-sandbox" });
    expect(r.has("cap.tool2")).toBe(true);
  });

  it("an in-sandbox write manifest registers fine", () => {
    const m = {
      ...base,
      name: "cap.write",
      containment: "in-sandbox",
      sideEffect: "write",
      idempotent: false,
    };
    const r = new ToolRegistry();
    expect(() => r.register(m)).not.toThrow();
    expect(r.has("cap.write")).toBe(true);
  });

  it("⚠️ GATE: new ToolRegistry([<network-egress manifest>]) THROWS (egress-allowlist not wired)", () => {
    // NON-VACUITY: if ToolRegistry skipped assertRegisterable (register without the gate), this
    // seal-punching tool would REGISTER instead of being refused — flipping this test RED.
    expect(() => new ToolRegistry([{ ...base, containment: "network-egress" }])).toThrow();
  });

  it("⚠️ GATE: a synthetic destructive (seal-punch) manifest is REFUSED at registration (approval not wired)", () => {
    const destructive = {
      ...base,
      name: "fs.seal_punch",
      containment: "in-sandbox",
      sideEffect: "destructive",
      idempotent: false,
      requiresApproval: true,
    };
    const r = new ToolRegistry();
    expect(() => r.register(destructive)).toThrow();
    // fail-closed: the refused manifest did NOT enter the registry.
    expect(r.has("fs.seal_punch")).toBe(false);
  });

  it("⚠️ GATE: a synthetic host-fs-write manifest is REFUSED at registration (host-write-target not wired)", () => {
    expect(() => new ToolRegistry([{ ...base, containment: "host-fs-write" }])).toThrow();
  });

  it("⚠️ GATE atomicity: a refused manifest in a seed leaves NO half registry (in-sandbox sibling not admitted)", () => {
    expect(
      () =>
        new ToolRegistry([
          { ...base, name: "cap.ok", containment: "in-sandbox" },
          { ...base, name: "cap.bad", containment: "network-egress" },
        ]),
    ).toThrow();
  });

  it("WIRED injection at the registry seam is OUT OF SCOPE today: registry uses WIRED_PRIMITIVES (empty)", () => {
    // The registry gate uses the default WIRED_PRIMITIVES (empty) — a network tool cannot register
    // today. Later slices extend WIRED_PRIMITIVES; the per-call WIRED-injection escape hatch lives on
    // `assertRegisterable` (proven above), not on the registry.
    expect(() => new ToolRegistry([{ ...base, containment: "network-egress" }])).toThrow();
  });
});
