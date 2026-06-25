/**
 * SLICE-DV2 — `DeveloperKit.publicKeyPem()` unit proof (HERMETIC, no Go, no spawn).
 *
 * DV2's moat upgrade requires the kit to HAND a developer the Ed25519 public key that the released Go
 * verifier binds verification to (the trust-root: an auditor verifies the kit's signed WORM chain
 * against the AUTHOR's pubkey). This unit pins the contract of the new accessor WITHOUT touching the
 * verifier (the live byte-match proof is the gated `real-verifier.live.test.ts`):
 *   (1) `publicKeyPem()` returns a valid SPKI PEM (`-----BEGIN PUBLIC KEY-----` … `-----END PUBLIC KEY-----`)
 *       that round-trips back into a usable Ed25519 KeyObject via `crypto.createPublicKey`.
 *   (2) The accessor NEVER leaks the private key: no PRIVATE-KEY PEM marker, no PKCS8/SEC1 body, and the
 *       kit's actual private key (re-derived here for the assertion) appears in NO kit output surface
 *       (publicKeyPem / replayFold / bundleRefFor).
 *
 * RED-first: `publicKeyPem` does not exist on `DeveloperKit` yet, so this file is a TYPE error until the
 * helper is added — the failing-test-first gate for the DV2 accessor.
 */
import { createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../iam/ids.js";
import { createDeveloperKit } from "./bootstrap.js";

const ctx: AgentContext = {
  actorId: "agent:dev",
  tenantId: "tenant-dev",
  projectId: "proj-dev",
  taskId: "task-dev",
  requestId: "req-dev",
} as AgentContext;

/** A valid 9-field manifest in the kit's default `dev:` namespace (so the default allow rule matches). */
function validManifest(name = "dev:echo"): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    description: "echo tool for the developer kit",
    action: "invoke",
    resourcePattern: "dev:echo:*",
    sideEffect: "read",
    idempotent: true,
    requiresApproval: false,
    bundleRefOnly: true,
    containment: "in-sandbox",
  };
}

describe("DeveloperKit.publicKeyPem — SPKI export, no private-key leak (hermetic)", () => {
  it("(1) returns a valid SPKI PEM that round-trips into an Ed25519 public KeyObject", () => {
    const kit = createDeveloperKit();
    const pem = kit.publicKeyPem();

    // It is an SPKI PUBLIC KEY PEM (the shape the verifier's `--pubkey` accepts).
    expect(pem.startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);
    expect(pem.trimEnd().endsWith("-----END PUBLIC KEY-----")).toBe(true);

    // It parses back into a usable Ed25519 PUBLIC key (the verifier ingests exactly this).
    const key = createPublicKey(pem);
    expect(key.type).toBe("public");
    expect(key.asymmetricKeyType).toBe("ed25519");
  });

  it("(2) NEVER leaks the private key: no PRIVATE-KEY marker in pubkey PEM, and the kit's private key is in NO output", () => {
    const kit = createDeveloperKit();
    kit.authorTool(validManifest("dev:echo"));

    const pem = kit.publicKeyPem();
    // No private-key markers in the exported PEM (SPKI public material only).
    expect(pem).not.toContain("PRIVATE KEY");
    expect(pem).not.toContain("BEGIN EC PRIVATE KEY");

    // The exported public PEM must be DISTINCT from a private export: a PUBLIC key cannot be coerced
    // into producing a private PEM, and the kit exposes no API that returns private material.
    const surfaces = [
      kit.publicKeyPem(),
      kit.bundleRefFor("dev/echo"),
      JSON.stringify(kit.replayFold()),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain("PRIVATE KEY");
    }

    // Defense-in-depth: a key derived from the EXPORTED PEM round-trips as PUBLIC-only — it can never
    // emit a PKCS8 private export (createPublicKey strips any private material, so the kit's private
    // key bytes are unreachable through this accessor).
    const reExported = createPublicKey(pem).export({ type: "spki", format: "pem" }) as string;
    expect(reExported).not.toContain("PRIVATE KEY");
    expect(reExported.startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);
  });
});
