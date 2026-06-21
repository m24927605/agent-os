/**
 * RED-first: per-model deny-by-default + fail-closed + credential-blind structural assertions.
 *
 * SLICE-P2R-R6-S1 (see docs/slices/phase-2-remaining/P2R-R6-S1-per-model-deny-by-default-gate.md,
 * docs/design/inference-routing-gate.md §5,§7). `isModelAllowed` is the FIRST chokepoint gate:
 * only an explicitly-allowlisted (model, providerType) pair may pass; everything else denies.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isModelAllowed } from "./model-allowlist.js";
import type { ModelAllowlist } from "./types.js";

const ctx = {
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

const allowlist: ModelAllowlist = [
  { model: "m1", providerType: "p1" },
  { model: "m2", providerType: "p2" },
];

const validReq = (over: Record<string, unknown> = {}) => ({
  model: "m1",
  providerType: "p1",
  egressHost: "api.example.local",
  estimatedTokens: 100,
  ...ctx,
  ...over,
});

describe("isModelAllowed — per-model deny-by-default (first chokepoint)", () => {
  it("ALLOW: an allowlisted (model, providerType) passes and returns the parsed request", () => {
    const out = isModelAllowed(validReq(), allowlist);
    expect(out.allowed).toBe(true);
    if (out.allowed) {
      expect(out.request.model).toBe("m1");
      expect(out.request.providerType).toBe("p1");
    }
  });

  it("deny-by-default: an unknown model denies", () => {
    const out = isModelAllowed(validReq({ model: "unknown" }), allowlist);
    expect(out.allowed).toBe(false);
  });

  it("deny-by-default: model on allowlist but providerType mismatch denies", () => {
    const out = isModelAllowed(validReq({ model: "m1", providerType: "p2" }), allowlist);
    expect(out.allowed).toBe(false);
  });

  it("deny-by-default: an empty allowlist denies every model", () => {
    expect(isModelAllowed(validReq(), []).allowed).toBe(false);
    expect(isModelAllowed(validReq({ model: "m2", providerType: "p2" }), []).allowed).toBe(false);
  });
});

describe("isModelAllowed — fail-closed on malformed input (never throw, never allow)", () => {
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ["missing model", validReqWithout("model")],
    ["missing providerType", validReqWithout("providerType")],
    ["non-string model", validReq({ model: 123 })],
    ["null request", null],
    ["array request", []],
    ["string request", "m1"],
    ["extra unexpected field (strict)", validReq({ surprise: "x" })],
    ["empty string model (non-empty trim)", validReq({ model: "   " })],
  ];

  for (const [label, input] of malformed) {
    it(`denies and does not throw: ${label}`, () => {
      let out: ReturnType<typeof isModelAllowed>;
      expect(() => {
        out = isModelAllowed(input, allowlist);
      }).not.toThrow();
      // biome-ignore lint/style/noNonNullAssertion: assigned synchronously above
      expect(out!.allowed).toBe(false);
    });
  }
});

function validReqWithout(field: string) {
  const r = validReq() as Record<string, unknown>;
  delete r[field];
  return r;
}

describe("credential-blind: InferenceRequest schema has NO credential-bearing field", () => {
  it("types.ts source contains no apiKey/api_key/secret/bearer/password/credential field name", () => {
    const typesPath = fileURLToPath(new URL("./types.ts", import.meta.url));
    const src = readFileSync(typesPath, "utf8")
      // strip line + block comments so doc prose mentioning credentials does not trip the assertion
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const forbidden = /\b(api[_-]?key|secret|bearer|password|credential)\b/i;
    expect(forbidden.test(src)).toBe(false);
  });
});

describe("reason does not leak the request payload (static gate text only)", () => {
  it("a deny reason names the gate / static text and does not echo the whole request object", () => {
    const out = isModelAllowed(
      validReq({ model: "leak-me", egressHost: "h.secret.host" }),
      allowlist,
    );
    expect(out.allowed).toBe(false);
    if (!out.allowed) {
      expect(out.reason.length).toBeGreaterThan(0);
      expect(out.reason).not.toContain("h.secret.host");
      expect(out.reason).not.toContain("egressHost");
    }
  });
});
