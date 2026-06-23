/**
 * SLICE-K2 — the consumer-side moat made REAL: the OPERATOR'S ACTUAL kernel chain (signed by the live
 * K1 kernel process, read back over gRPC) is INDEPENDENTLY verified by the SEPARATELY-RELEASED Go
 * verifier (cross-language byte-match), tampering is CAUGHT, and a wrong pubkey is REJECTED.
 *
 * This is the step beyond DV2: DV2 verified the kit's OWN ts-signed chain; K2 verifies the chain the
 * REAL Go kernel produced + SIGNED in a separate process, using the pubkey the kernel SELF-REPORTS.
 *
 * GATED (stays out of hermetic `pnpm run verify`): runs ONLY when ALL of
 *   AGENTOS_LIVE_KERNEL_VERIFY=1  AND  AGENTOS_LIVE_KERNEL_ENDPOINT  AND  AGENTOS_VERIFIER_BIN
 * are set — exactly what `scripts/e2e-live-kernel-verify.sh` exports after it BUILDS + starts the signed
 * kernel and BUILDS + CHECKSUM-VERIFIES the released verifier. Without the env this `describe.skip`s, so
 * `pnpm run verify` never builds a binary or spawns a process.
 *
 * Three live proofs against the REAL verifier + the REAL kernel chain:
 *   (a) INTACT — append >=1 governed/audit event via the REAL grpc-js ingest appender, reconstruct the
 *       SignedChain via `createSignedChainReader`, write the chain JSON + the kernel's SELF-REPORTED
 *       pubkey PEM, and spawn the released verifier (`--pubkey kernelPem --chain chainFile`) -> exit 0.
 *       This is the real proof that the Go verifier accepts the operator's ACTUAL kernel chain
 *       byte-for-byte (if the read-back reconstruction or canonicalization did NOT match Go's recompute,
 *       the verifier would report BROKEN here — a real gap the live run surfaces, NOT a vacuous pass).
 *   (b) TAMPER caught (non-vacuity): flip a char in an entry's bytes in the chain JSON -> the verifier
 *       recomputes the hash + catches the break -> exit 1 (broken). Strict: NOT 0, NOT 2.
 *   (c) WRONG pubkey: a freshly generated, UNRELATED ed25519 pubkey PEM (NOT the kernel's) -> non-zero.
 *       The trust-root binds verification to the KERNEL's attester key: a different key fails the
 *       checkpoint signature.
 *
 * HONEST BOUNDARY (mirrors the spec §3 Out-of-scope): the kernel signing key is OPERATOR-HELD
 * (in-memory generated or loaded from a file), so attester != actor holds TO THE PROCESS BOUNDARY (the
 * control plane can only Append and holds no key). The kernel SELF-REPORTS its pubkey, so the pubkey
 * trust-root distribution / endorsement (who vouches the pubkey is the real kernel's) and real key
 * externalization (HSM/KMS/remote attestation) are P4 — NOT solved here. K2 proves: GIVEN the kernel's
 * self-reported pubkey, the operator's real kernel chain is independently verifiable INTACT + tamper is
 * caught.
 */
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuditEvent, createAuditEvent, createIngestAppender } from "../../audit/index.js";
import { createSignedChainReader } from "./signed-read-transport.js";
import { createRpcAppendTransport } from "./transport.js";

// GATE: the explicit live flag AND a kernel endpoint AND a concrete verifier binary path must be present.
const ENDPOINT = process.env.AGENTOS_LIVE_KERNEL_ENDPOINT;
const VERIFIER_BIN = process.env.AGENTOS_VERIFIER_BIN;
const LIVE =
  process.env.AGENTOS_LIVE_KERNEL_VERIFY === "1" && Boolean(ENDPOINT) && Boolean(VERIFIER_BIN);
const d = LIVE ? describe : describe.skip;

function mkEvent(action: string, reason = "ok"): AuditEvent {
  return createAuditEvent({
    actorId: "agent:k2",
    tenantId: "tenant-k2",
    projectId: "proj-1",
    taskId: "task-1",
    requestId: `req-${action}`,
    action,
    resource: "res-prod",
    policyDecision: { effect: "allow", reason },
    result: "success",
  });
}

/** Append >=1 governed/audit event to the live kernel via the REAL grpc-js ingest appender. */
async function appendGovernedEvent(sourceId: string): Promise<void> {
  const appender = createIngestAppender<AuditEvent>({
    transport: createRpcAppendTransport({ endpoint: ENDPOINT as string }),
    sourceId,
  });
  await appender.append(mkEvent("create"));
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "k2-signed-readback-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

d(
  "K2 — the REAL kernel's signed chain verified by the RELEASED Go verifier (cross-language)",
  () => {
    it("(a) INTACT: the released verifier verifies the operator's ACTUAL kernel chain -> exit 0", async () => {
      // A UNIQUE source so re-runs against a persistent kernel WAL never replay a settled sequence.
      await appendGovernedEvent(`k2-intact-${Date.now()}`);

      const { chain, publicKeyPem } = await createSignedChainReader({
        endpoint: ENDPOINT as string,
      });
      expect(chain.entries.length).toBeGreaterThanOrEqual(1);
      expect(chain.checkpoint.signature.length).toBeGreaterThan(0);
      expect(chain.checkpoint.length).toBe(chain.entries.length);

      const chainPath = join(tmp, "kernel-chain.json");
      const pemPath = join(tmp, "kernel.pem");
      writeFileSync(chainPath, JSON.stringify(chain));
      writeFileSync(pemPath, publicKeyPem);

      // Spawn the RELEASED verifier across a PROCESS boundary (the verifier never imports kernel internals).
      const proc = spawnSync(VERIFIER_BIN as string, ["--pubkey", pemPath, "--chain", chainPath], {
        encoding: "utf8",
      });
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0); // 0 == INTACT: the real kernel chain verified byte-for-byte
    });

    it("(b) TAMPER caught: flipping a char in an entry's bytes -> the verifier exits 1 (broken), non-vacuously", async () => {
      await appendGovernedEvent(`k2-tamper-${Date.now()}`);

      const { chain, publicKeyPem } = await createSignedChainReader({
        endpoint: ENDPOINT as string,
      });
      const pemPath = join(tmp, "kernel.pem");
      writeFileSync(pemPath, publicKeyPem);

      // TAMPER at the chain-FILE level (the kernel WORM is append-only): flip the last hex char of an
      // entry's entryHash so the verifier's recompute-and-compare MUST mismatch.
      const tampered = JSON.parse(JSON.stringify(chain)) as {
        entries: Array<{ entryHash: string }>;
      };
      const e0 = tampered.entries[0];
      expect(e0).toBeDefined();
      if (!e0) return;
      const original = e0.entryHash;
      const lastChar = original.slice(-1);
      e0.entryHash = original.slice(0, -1) + (lastChar === "0" ? "1" : "0");
      expect(e0.entryHash).not.toBe(original); // the mutation really changed the bytes

      const tamperedPath = join(tmp, "tampered-chain.json");
      writeFileSync(tamperedPath, JSON.stringify(tampered));

      const proc = spawnSync(
        VERIFIER_BIN as string,
        ["--pubkey", pemPath, "--chain", tamperedPath],
        { encoding: "utf8" },
      );
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(1); // 1 == broken (NOT 0 intact, NOT 2 bad-input)
    });

    it("(c) WRONG pubkey: a DIFFERENT ed25519 pubkey (NOT the kernel's) -> non-zero", async () => {
      await appendGovernedEvent(`k2-wrong-${Date.now()}`);

      const { chain } = await createSignedChainReader({ endpoint: ENDPOINT as string });
      const chainPath = join(tmp, "kernel-chain.json");
      writeFileSync(chainPath, JSON.stringify(chain));

      // A SECOND, unrelated ed25519 keypair: its public PEM is NOT the kernel's attester trust-root.
      const { publicKey: otherPublic } = generateKeyPairSync("ed25519");
      const otherPemPath = join(tmp, "other.pem");
      writeFileSync(otherPemPath, otherPublic.export({ type: "spki", format: "pem" }) as string);

      // The chain is INTACT, but the checkpoint signature was made with the KERNEL's private key.
      // Verifying against a different pubkey fails the Ed25519 checkpoint signature -> non-zero.
      const proc = spawnSync(
        VERIFIER_BIN as string,
        ["--pubkey", otherPemPath, "--chain", chainPath],
        { encoding: "utf8" },
      );
      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
    });
  },
);
