// Direction B: the TS verifier (S0.5 verifyChain) verifies a chain PRODUCED BY the Go kernel, and
// detects tamper/reorder/gap/bad-sig in it. The only cross-plane coupling is the pure-data fixture
// (go-chain.json) — no TS<->Go code import. Regenerate go-chain.json with:
//   AGENTOS_GEN_FIXTURE=1 (cd kernel && go test -run TestGenerateGoFixture ./internal/conformance/)
import { createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type SignedChain, verifyChain } from "../../src/audit/kernel/verify.js";

interface Fixture {
  publicKey: string; // "ed25519:<base64(SPKI DER)>"
  entries: { sequence: number; event: unknown; prevHash: string; entryHash: string }[];
  checkpoint: { length: number; headEntryHash: string; signature: string };
}

const fixture = JSON.parse(
  readFileSync(new URL("testdata/go-chain.json", import.meta.url), "utf8"),
) as Fixture;

function publicKey(): KeyObject {
  const der = Buffer.from(fixture.publicKey.replace(/^ed25519:/, ""), "base64");
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

// deep clone so each mutation starts from the pristine Go-produced chain
function chain(): SignedChain {
  return JSON.parse(JSON.stringify({ entries: fixture.entries, checkpoint: fixture.checkpoint }));
}

describe("TS verifies the Go-produced chain (cross-language, direction B)", () => {
  it("verifies an intact Go chain", () => {
    const res = verifyChain(chain(), publicKey());
    expect(res).toEqual({ ok: true, length: fixture.entries.length });
  });

  it("detects tamper (changed event, unchanged entryHash)", () => {
    const c = chain();
    c.entries[1] = { ...c.entries[1], event: { action: "TAMPERED" } };
    const res = verifyChain(c, publicKey());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.brokenAt).toBe(1);
  });

  it("detects reorder (swap entries 0 and 1, keep their sequences)", () => {
    const c = chain();
    [c.entries[0], c.entries[1]] = [c.entries[1], c.entries[0]];
    const res = verifyChain(c, publicKey());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.brokenAt).toBe(0);
  });

  it("detects gap (drop the middle entry, keep original sequences 0,2)", () => {
    const c = chain();
    c.entries = [c.entries[0], c.entries[2]];
    const res = verifyChain(c, publicKey());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.brokenAt).toBe(1);
  });

  it("rejects under a wrong key (bad-sig)", () => {
    const wrong = generateKeyPairSync("ed25519").publicKey;
    const res = verifyChain(chain(), wrong);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.brokenAt).toBe(fixture.entries.length);
  });

  it("contains the redacted canary boundary event (no leak)", () => {
    const raw = readFileSync(new URL("testdata/go-chain.json", import.meta.url), "utf8");
    expect(raw).not.toMatch(/sk-a{16,}/);
    expect(raw).toContain("[REDACTED]");
  });

  it.each(["go-chain-single.json", "go-chain-empty.json"])(
    "verifies the Go-produced boundary chain %s (single / empty)",
    (name) => {
      const fx = JSON.parse(readFileSync(new URL(`testdata/${name}`, import.meta.url), "utf8")) as Fixture;
      const der = Buffer.from(fx.publicKey.replace(/^ed25519:/, ""), "base64");
      const pub = createPublicKey({ key: der, format: "der", type: "spki" });
      const res = verifyChain({ entries: fx.entries, checkpoint: fx.checkpoint }, pub);
      expect(res).toEqual({ ok: true, length: fx.entries.length });
    },
  );
});
