import { describe, expect, it } from "vitest";
import { type ToolManifest, parseToolManifest } from "./manifest.js";

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
};

describe("parseToolManifest", () => {
  it("accepts a well-formed 9-field manifest and returns all fields", () => {
    const parsed = parseToolManifest({ ...valid });
    expect(parsed).toEqual(valid);
  });

  it("rejects unknown fields (.strict, fail-closed)", () => {
    expect(() => parseToolManifest({ ...valid, evil: "x" })).toThrow();
  });

  it("rejects a missing required field", () => {
    const { version: _omit, ...missing } = valid;
    expect(() => parseToolManifest(missing)).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() => parseToolManifest({ ...valid, name: "" })).toThrow();
  });

  it("rejects a sideEffect that is not in the enum", () => {
    expect(() => parseToolManifest({ ...valid, sideEffect: "nuke" })).toThrow();
  });

  it("guardrail A: sideEffect none implies idempotent true", () => {
    expect(() => parseToolManifest({ ...valid, sideEffect: "none", idempotent: false })).toThrow();
    expect(parseToolManifest({ ...valid, sideEffect: "none", idempotent: true })).toMatchObject({
      sideEffect: "none",
      idempotent: true,
    });
  });

  it("guardrail B: sideEffect destructive implies requiresApproval true", () => {
    expect(() =>
      parseToolManifest({
        ...valid,
        sideEffect: "destructive",
        requiresApproval: false,
      }),
    ).toThrow();
    expect(
      parseToolManifest({
        ...valid,
        sideEffect: "destructive",
        requiresApproval: true,
      }),
    ).toMatchObject({ sideEffect: "destructive", requiresApproval: true });
  });

  it("is fail-closed on non-object input", () => {
    expect(() => parseToolManifest(undefined)).toThrow();
    expect(() => parseToolManifest(null)).toThrow();
    expect(() => parseToolManifest("fs.read")).toThrow();
    expect(() => parseToolManifest([valid])).toThrow();
  });
});
