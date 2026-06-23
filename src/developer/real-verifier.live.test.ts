/**
 * SLICE-DV2 — the Developer moat made REAL: the kit's signed WORM chain is INDEPENDENTLY verified by
 * the RELEASED Go verifier binary (cross-language byte-match), tampering is CAUGHT, and a wrong pubkey
 * is REJECTED.
 *
 * GATED (stays out of hermetic `pnpm run verify`): runs ONLY when BOTH `AGENTOS_LIVE_VERIFIER=1` AND
 * `AGENTOS_VERIFIER_BIN=<abs path>` are set — exactly what `scripts/e2e-live-developer.sh` exports after
 * it BUILDS the verifier (`verifier:release`) and CHECKSUM-VERIFIES it against `SHA-256SUMS`. Without the
 * env this `describe.skip`s, so `pnpm run verify` never builds a binary or spawns a process.
 *
 * Three live proofs against the REAL verifier:
 *   (a) INTACT — the cross-language byte-match moat: author + run a governed tool (the WORM gains a
 *       SIGNED entry), export the kit's pubkey PEM, and `verifyEvidenceChain(pem)` -> {ok:true}. This is
 *       the real proof that the Go verifier accepts a TS-produced signed chain byte-for-byte. (If TS
 *       canonicalization did NOT match Go's recompute, the verifier would report BROKEN here — a real
 *       gap the live run would surface, NOT a vacuous pass.)
 *   (b) TAMPER caught (non-vacuity): capture the kit's EXACT serialized chain (`{entries, checkpoint}`)
 *       via a record-only shim, MUTATE one entry's `entryHash` bytes, write the tampered JSON, and spawn
 *       the REAL verifier directly (`--pubkey pem --chain tampered`) -> exit 1 (broken). The kit's WORM
 *       is append-only, so tampering is applied at the chain-FILE level; this proves the verifier truly
 *       recomputes + catches the break (not a no-op accept-all).
 *   (c) WRONG pubkey: generate a SECOND ed25519 keypair, export its SPKI PEM, and
 *       `verifyEvidenceChain(otherPem)` on the INTACT chain -> {ok:false}. The trust-root binds
 *       verification to the AUTHOR's pubkey: a different key fails the checkpoint signature.
 *
 * HONEST SCOPE (mirrors the spec §3 Out-of-scope): DV2 verifies the KIT'S own ed25519-signed chain
 * (clean, not kernel-signed). Verifying the LIVE KERNEL's chain is blocked on kernel UNSIGNED read-back
 * (P2R-PV-S3a); externalizing the pubkey trust-root (KMS/pinning) is P4.
 */
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentContext } from "../iam/ids.js";
import { type DeveloperKit, createDeveloperKit } from "./bootstrap.js";

// GATE: both the explicit live flag AND a concrete verifier binary path must be present.
const VERIFIER_BIN = process.env.AGENTOS_VERIFIER_BIN;
const LIVE = process.env.AGENTOS_LIVE_VERIFIER === "1" && Boolean(VERIFIER_BIN);
const d = LIVE ? describe : describe.skip;

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
  };
}

function toolCall(tool: string, args: Record<string, unknown> = {}) {
  return { tool, context: ctx, args } as const;
}

/** Build an INTACT kit whose WORM has >=1 signed entry (author -> run a governed tool). */
async function intactKit(): Promise<DeveloperKit> {
  const kit = createDeveloperKit();
  kit.authorTool(validManifest("dev:echo"));
  const outcome = await kit.runTool(toolCall("dev:echo", { note: "for-the-real-verifier" }));
  expect(outcome.status).toBe("executed");
  return kit;
}

interface VerifierChain {
  entries: Array<Record<string, unknown> & { entryHash: string }>;
  checkpoint: Record<string, unknown>;
}

/**
 * Capture the kit's EXACT serialized verifier-chain bytes (`{entries, checkpoint}`) WITHOUT reaching
 * into its private WORM: point `verifyEvidenceChain` at a RECORD-ONLY shim that copies the `--chain`
 * file the kit writes to a known path, then exits 0. The kit writes the SAME bytes the real verifier
 * consumes, so the captured JSON is byte-identical to what the live verifier sees.
 */
async function captureKitChain(kit: DeveloperKit, dir: string): Promise<VerifierChain> {
  const captured = join(dir, "captured-chain.json");
  const shim = join(dir, "record-shim.sh");
  writeFileSync(
    shim,
    [
      "#!/usr/bin/env bash",
      "# Record-only shim: copy the --chain arg to the capture path, exit 0.",
      'chain=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --chain) chain="$2"; shift 2 ;;',
      "    *) shift ;;",
      "  esac",
      "done",
      `cp "$chain" "${captured}"`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(shim, 0o755);
  const pem = join(dir, "capture.pem");
  writeFileSync(pem, kit.publicKeyPem());
  // The kit serializes {entries, checkpoint} -> temp --chain file -> spawns the shim (which copies it).
  const res = await kit.verifyEvidenceChain(pem, { ...process.env, AGENTOS_VERIFIER_BIN: shim });
  expect(res.ok).toBe(true); // the shim exits 0, confirming the capture path ran
  return JSON.parse(readFileSync(captured, "utf8")) as VerifierChain;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dv2-real-verifier-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

d(
  "DV2 — kit's signed WORM chain verified by the REAL released Go verifier (cross-language)",
  () => {
    it("(a) INTACT: the REAL verifier accepts the TS-produced signed chain (byte-match) -> {ok:true}", async () => {
      const kit = await intactKit();

      // Write the AUTHOR's pubkey PEM — the trust-root the verifier binds verification to.
      const pemPath = join(tmp, "author.pem");
      writeFileSync(pemPath, kit.publicKeyPem());

      // verifyEvidenceChain SPAWNS the REAL verifier (AGENTOS_VERIFIER_BIN) across a process boundary and
      // relays its exit code. exit 0 == the Go verifier recomputed + verified the TS chain INTACT.
      const result = await kit.verifyEvidenceChain(pemPath, { ...process.env });
      expect(result.ok).toBe(true);
    });

    it("(b) TAMPER caught: mutating one entry's bytes -> the REAL verifier exits 1 (broken), non-vacuously", async () => {
      const kit = await intactKit();

      const pemPath = join(tmp, "author.pem");
      writeFileSync(pemPath, kit.publicKeyPem());

      // Capture the kit's EXACT intact chain, then TAMPER at the chain-FILE level (the kit's WORM is
      // append-only). Flip the last hex char of an entry's entryHash: the verifier recomputes the hash
      // from the event bytes and compares -> a guaranteed mismatch it MUST report as broken.
      const chain = await captureKitChain(kit, tmp);
      const entry0 = chain.entries[0];
      expect(entry0).toBeDefined();
      if (!entry0) return;
      const original = entry0.entryHash;
      const lastChar = original.slice(-1);
      const flipped = lastChar === "0" ? "1" : "0";
      entry0.entryHash = original.slice(0, -1) + flipped;
      expect(entry0.entryHash).not.toBe(original); // the mutation really changed the bytes

      const tamperedPath = join(tmp, "tampered-chain.json");
      writeFileSync(tamperedPath, JSON.stringify(chain));

      // Spawn the REAL verifier DIRECTLY against the tampered chain.
      const proc = spawnSync(
        VERIFIER_BIN as string,
        ["--pubkey", pemPath, "--chain", tamperedPath],
        {
          encoding: "utf8",
        },
      );
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(1); // 1 == broken (NOT 0 intact, NOT 2 bad-input)
    });

    it("(c) WRONG pubkey: verifying the intact chain with a DIFFERENT pubkey -> {ok:false} (trust-root)", async () => {
      const kit = await intactKit();

      // A SECOND, unrelated ed25519 keypair: its public PEM is NOT the author's trust-root.
      const { publicKey: otherPublic } = generateKeyPairSync("ed25519");
      const otherPemPath = join(tmp, "other.pem");
      writeFileSync(otherPemPath, otherPublic.export({ type: "spki", format: "pem" }) as string);

      // The chain is INTACT, but the checkpoint signature was made with the AUTHOR's private key. Verifying
      // against a different pubkey fails the Ed25519 checkpoint signature -> non-zero -> {ok:false}.
      const result = await kit.verifyEvidenceChain(otherPemPath, { ...process.env });
      expect(result.ok).toBe(false);
    });
  },
);
