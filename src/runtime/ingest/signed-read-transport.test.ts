/**
 * RED-first unit tests for the SIGNED-chain read-back reader (SLICE-K2).
 *
 * `createSignedChainReader` reconstructs the kernel's externally-verifiable `SignedChain`
 * ({entries, checkpoint{length, headEntryHash, signature}}) PLUS the kernel's public key as an SPKI
 * PEM, from TWO read-only RPCs over the SAME AppendService channel:
 *   - `ListEntries` -> entries (folded into LogEntry[], reusing the createEntriesReader contract),
 *   - `Checkpoint`  -> {headEntryHash, checkpointSignature, publicKey} (K1's signed anchor).
 *
 * These run with an IN-PROCESS injected `AppendService` stub — ZERO network, NO Go kernel. They lock
 * the reader's load-bearing invariants:
 *   (a) reconstruct a valid SignedChain + a PEM public key from a K1-style fixture,
 *   (b) FAIL-CLOSED: a missing/empty checkpointSignature OR publicKey -> reject (never present an
 *       UNSIGNED chain as signed),
 *   (c) HEAD/LENGTH SELF-CONSISTENCY (K1-review MINOR): a torn read where the checkpoint head does not
 *       match the read-back entries' head -> reject,
 *   (d) the publicKey DER -> SPKI PEM conversion round-trips to an Ed25519 public KeyObject and carries
 *       NO private material.
 */
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GENESIS_PREV_HASH, checkpointBytes, computeEntryHash } from "../../audit/kernel/log.js";
import type {
  AppendService,
  CheckpointResponse,
  ListEntriesResponse,
} from "../_generated/ingest/ingest.js";
import { createSignedChainReader } from "./signed-read-transport.js";

/** A K1-style synthetic AuditEvent (the already-redacted canonical object the kernel persists). */
const SYNTH = {
  eventId: "00000000-0000-4000-8000-000000000001",
  requestId: "req-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "tool:invoke",
  resource: "personal:backup",
  policyDecision: { effect: "allow", reason: "ok" },
  result: "success",
} as const;

const enc = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));

/**
 * Build a K1-style signed fixture: one real entry whose entryHash is computed with the SAME pinned
 * function the kernel uses, and a Checkpoint signed over CheckpointBytes(head, length=1) with a fresh
 * Ed25519 key. Returns the wired stub + the materials a test asserts against.
 */
function k1Fixture(
  overrides: {
    signatureOverride?: string;
    publicKeyOverride?: Uint8Array;
    headOverride?: string;
  } = {},
) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // entries: the single entry at sequence 0 (genesis prev), entryHash via the pinned definition.
  const entryHash = computeEntryHash(SYNTH as never, GENESIS_PREV_HASH, 0);
  const length = 1;
  const head = overrides.headOverride ?? entryHash;
  // The kernel signs CheckpointBytes(head, length); we sign over the REAL head (entryHash) so the
  // reconstructed chain verifies, unless a test overrides head to simulate a torn read.
  const signature = sign(null, checkpointBytes(entryHash, length), privateKey).toString("base64");
  // PKIX/SPKI DER of the public key (what the kernel returns over the wire as public_key).
  const publicKeyDer = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));

  const checkpoint: CheckpointResponse = {
    headEntryHash: head,
    headSequence: 0,
    perSourceNextSeq: { "src-a": 1 },
    checkpointSignature: overrides.signatureOverride ?? signature,
    publicKey: overrides.publicKeyOverride ?? publicKeyDer,
  };
  const list: ListEntriesResponse = {
    entries: [
      {
        sequence: 0,
        canonicalEvent: enc(SYNTH),
        prevHash: GENESIS_PREV_HASH,
        entryHash,
      },
    ],
  };

  const client: AppendService = {
    Append: () => Promise.reject(new Error("Append not exercised in this test")),
    Checkpoint: () => Promise.resolve(checkpoint),
    ListEntries: () => Promise.resolve(list),
  };
  return { client, publicKey, publicKeyDer, entryHash, signature };
}

describe("createSignedChainReader (K2) — reconstruct + fail-closed", () => {
  it("(a) reconstructs a valid SignedChain {entries, checkpoint{signature,headEntryHash,length}} + PEM pubkey", async () => {
    const f = k1Fixture();
    const { chain, publicKeyPem } = await createSignedChainReader({
      endpoint: "passthrough:fake",
      client: f.client,
    });

    expect(chain.entries.length).toBe(1);
    const e0 = chain.entries[0];
    expect(e0?.sequence).toBe(0);
    expect(e0?.prevHash).toBe(GENESIS_PREV_HASH);
    expect(e0?.entryHash).toBe(f.entryHash);
    expect(e0?.event.action).toBe("tool:invoke");

    // checkpoint: head + signature carried verbatim from the Checkpoint RPC; length = entry count.
    expect(chain.checkpoint.length).toBe(1);
    expect(chain.checkpoint.headEntryHash).toBe(f.entryHash);
    expect(chain.checkpoint.signature).toBe(f.signature);

    // The exported PEM is an Ed25519 SPKI public key matching the kernel's reported DER.
    expect(publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    const fromPem = createPublicKey(publicKeyPem);
    expect(fromPem.asymmetricKeyType).toBe("ed25519");
  });

  it("(b) FAIL-CLOSED: a missing checkpointSignature -> reject (never an UNSIGNED chain as signed)", async () => {
    const f = k1Fixture({ signatureOverride: "" });
    // Assert the GUARD's own message (not a generic throw): removing the explicit guard must flip this
    // RED, not pass via an incidental downstream crash (non-vacuity, K2-review F-1).
    await expect(
      createSignedChainReader({ endpoint: "passthrough:fake", client: f.client }),
    ).rejects.toThrow(/empty checkpoint signature/);
  });

  it("(b) FAIL-CLOSED: a missing publicKey -> reject", async () => {
    const f = k1Fixture({ publicKeyOverride: new Uint8Array() });
    // Pin the explicit empty-pubkey guard by its own message — without it, createPublicKey would throw
    // a DIFFERENT ("asymmetric key") error and the test would pass vacuously (K2-review F-1).
    await expect(
      createSignedChainReader({ endpoint: "passthrough:fake", client: f.client }),
    ).rejects.toThrow(/empty public key/);
  });

  it("(c) HEAD/LENGTH SELF-CONSISTENCY: checkpoint head != read-back entries' head -> reject (torn read)", async () => {
    // The checkpoint reports a DIFFERENT head than the entries' last entryHash: a torn read between the
    // two non-atomic RPCs. The reader MUST fail closed rather than hand a verifier an inconsistent chain.
    const f = k1Fixture({ headOverride: `sha256:${"f".repeat(64)}` });
    await expect(
      createSignedChainReader({ endpoint: "passthrough:fake", client: f.client }),
    ).rejects.toThrow();
  });

  it("(d) the exported PEM contains NO private material and round-trips to a public-only KeyObject", async () => {
    const f = k1Fixture();
    const { publicKeyPem } = await createSignedChainReader({
      endpoint: "passthrough:fake",
      client: f.client,
    });
    expect(publicKeyPem).not.toMatch(/PRIVATE KEY/);
    const ko = createPublicKey(publicKeyPem);
    expect(ko.type).toBe("public");
    // Re-export the DER and confirm it equals the kernel's reported SPKI DER (no leakage, exact match).
    const reDer = new Uint8Array(ko.export({ type: "spki", format: "der" }));
    expect(Buffer.from(reDer).equals(Buffer.from(f.publicKeyDer))).toBe(true);
  });
});
