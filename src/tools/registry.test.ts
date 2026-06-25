import { describe, expect, it } from "vitest";
import type { ToolManifest } from "./manifest.js";
import { ToolRegistry } from "./registry.js";

const valid: ToolManifest = {
  name: "fs.read",
  version: "1.0.0",
  description: "Read a file",
  action: "tool:invoke",
  resourcePattern: "fs://**",
  sideEffect: "read",
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
  containment: "in-sandbox",
};

describe("ToolRegistry", () => {
  it("registers a valid manifest: has/lookup/list reflect it", () => {
    const reg = new ToolRegistry();
    reg.register({ ...valid });
    expect(reg.has("fs.read")).toBe(true);
    expect(reg.lookup("fs.read")).toEqual(valid);
    expect(reg.list()).toContainEqual(valid);
  });

  it("unregistered name: has false, lookup undefined (paves S3 deny)", () => {
    const reg = new ToolRegistry();
    expect(reg.has("fs.write")).toBe(false);
    expect(reg.lookup("fs.write")).toBeUndefined();
  });

  it("duplicate name: second register throws (fail-closed, no overwrite)", () => {
    const reg = new ToolRegistry();
    reg.register({ ...valid });
    expect(() => reg.register({ ...valid, description: "shadow" })).toThrow();
    // original is preserved, not overwritten
    expect(reg.lookup("fs.read")).toEqual(valid);
  });

  it("malformed manifest: register throws (reuses S1 fail-closed)", () => {
    const reg = new ToolRegistry();
    expect(() => reg.register({ ...valid, evil: "x" })).toThrow();
    expect(() => reg.register({ ...valid, sideEffect: "nuke" })).toThrow();
    expect(reg.has("fs.read")).toBe(false);
  });

  it("seed atomicity: one malformed in seed => constructor throws (no half registry)", () => {
    expect(() => new ToolRegistry([{ ...valid }, { ...valid, evil: "x" }])).toThrow();
  });

  it("seed: a valid array constructs and is queryable", () => {
    const second: ToolManifest = { ...valid, name: "fs.write", sideEffect: "write" };
    const reg = new ToolRegistry([{ ...valid }, { ...second }]);
    expect(reg.has("fs.read")).toBe(true);
    expect(reg.has("fs.write")).toBe(true);
    expect(reg.list()).toHaveLength(2);
  });

  it("seed: duplicate names inside seed => constructor throws (fail-closed)", () => {
    expect(() => new ToolRegistry([{ ...valid }, { ...valid }])).toThrow();
  });

  it("CAP3 gate: a network-egress manifest is REFUSED at register (unwired primitive, fail-closed)", () => {
    const reg = new ToolRegistry();
    expect(() =>
      reg.register({ ...valid, name: "net.fetch", containment: "network-egress" }),
    ).toThrow();
    // fail-closed: the refused manifest did NOT enter the registry.
    expect(reg.has("net.fetch")).toBe(false);
  });

  it("CAP3 gate: a refused manifest in a seed aborts construction (no half registry)", () => {
    expect(
      () =>
        new ToolRegistry([
          { ...valid },
          { ...valid, name: "net.fetch", containment: "network-egress" },
        ]),
    ).toThrow();
  });

  it("adversarial lookup/has: empty/non-string => undefined/false, no crash", () => {
    const reg = new ToolRegistry();
    reg.register({ ...valid });
    expect(reg.lookup("")).toBeUndefined();
    expect(reg.has("")).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: deny-by-default probe with hostile input
    expect(reg.lookup(undefined as any)).toBeUndefined();
    // biome-ignore lint/suspicious/noExplicitAny: deny-by-default probe with hostile input
    expect(reg.has(123 as any)).toBe(false);
  });
});
