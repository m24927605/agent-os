/**
 * SIGNED-chain read-back reader (SLICE-K2) — the consumer-side seam that reconstructs the kernel's
 * externally-verifiable `SignedChain` from the REAL kernel WORM, so the SEPARATELY-RELEASED Go verifier
 * (DV2) can verify the operator's ACTUAL kernel chain (not just the kit's self-signed chain).
 *
 * Where `createEntriesReader` (read-transport.ts) returns only `LogEntry[]` (no signed checkpoint), this
 * reader composes the TWO read-only RPCs over the SAME grpc-js `AppendService` channel — `ListEntries`
 * (the entries) + `Checkpoint` (K1's SIGNED anchor: headEntryHash + checkpoint_signature + public_key) —
 * into a verifier-ready `{ chain: SignedChain, publicKeyPem }`:
 *   - entries: fold each `Entry` -> `LogEntry` exactly like createEntriesReader (JSON.parse the
 *     canonical_event into an AuditEvent; carry sequence/prevHash/entryHash verbatim),
 *   - checkpoint: { length = entries.length, headEntryHash + signature taken verbatim from Checkpoint }.
 *
 * WHY length = entries.length (NOT head_sequence): the kernel signs `CheckpointBytes(headEntryHash,
 * length)` where `length` is the chain's TOTAL ENTRY COUNT, and that count is NOT a wire field — it is
 * bound only inside the signature. The Go verifier reconstructs `CheckpointBytes` from the SignedChain's
 * `checkpoint.length` + `headEntryHash`, and FIRST asserts `checkpoint.length == len(entries)`. So the
 * only contract-faithful reconstruction of the signed count is the count of the entries we read back.
 * `head_sequence` is a PER-SOURCE sequence (it equals length-1 only in the single-source case); using it
 * to derive length would write a single-source coincidence into the contract and break multi-source.
 *
 * FAIL-CLOSED (load-bearing): we NEVER present an UNSIGNED chain as signed, and NEVER hand the verifier
 * a torn/inconsistent snapshot:
 *   - a `ListEntries`/`Checkpoint` RPC reject, a missing response, or a non-JSON canonical_event -> reject
 *     (inherited from the grpc-client + the fold; never a partial array),
 *   - an EMPTY checkpoint_signature OR an empty public_key -> reject (a signed read-back must be signed),
 *   - HEAD/LENGTH SELF-CONSISTENCY (adopted from the K1 review MINOR): the checkpoint's head must equal
 *     the read-back entries' head (genesis if empty). `ListEntries` and `Checkpoint` are two NON-ATOMIC
 *     RPCs; if an append lands between them the heads diverge — a torn read. We catch it here rather than
 *     hand the verifier an inconsistent chain (the verifier would also report it broken). We ALSO assert
 *     entries.length === checkpoint.length: that mirrors the verifier's first check and keeps the
 *     SignedChain object self-consistent (a defensive invariant; with length derived from entries it is
 *     structurally upheld, never silently violated).
 *
 * This module NEVER recomputes the chain hash in TS (that is the released verifier's job — reading !=
 * attesting) and names no vendor (the grpc-js boundary stays confined to grpc-client.ts).
 */
import { createPublicKey } from "node:crypto";
import type { AuditEvent, LogEntry, SignedChain } from "../../audit/index.js";
import { GENESIS_PREV_HASH } from "../../audit/index.js";
import type { AppendService } from "../_generated/ingest/ingest.js";
import { grpcAppendService } from "./grpc-client.js";

export interface SignedChainReaderOpts {
  /** Kernel AppendService endpoint (host:port). Used to build the grpc-js client when `client` is absent. */
  readonly endpoint: string;
  /**
   * Injected typed `AppendService` (the generated contract). Production omits it and a grpc-js client is
   * built from `endpoint`; tests inject an in-process stub (no network). Mirrors read-transport.ts.
   */
  readonly client?: AppendService;
}

/** The reconstructed, verifier-ready artifact: a SignedChain + the kernel's pubkey as an SPKI PEM. */
export interface SignedChainReadback {
  readonly chain: SignedChain;
  /** The kernel's Ed25519 public key as an SPKI PEM — the verifier's `--pubkey` trust-root input. */
  readonly publicKeyPem: string;
}

/**
 * Reconstruct the kernel's SIGNED chain from `ListEntries` + `Checkpoint`. Resolves a verifier-ready
 * `{ chain, publicKeyPem }`; REJECTS (fail-closed) on any RPC failure, a non-JSON canonical_event, a
 * missing signature/pubkey, or a head/length self-consistency violation — never an unsigned/partial/torn
 * chain. Reads the WHOLE log (fromSequence 0) so the reconstructed chain is verifier-compatible.
 */
export async function createSignedChainReader(
  opts: SignedChainReaderOpts,
): Promise<SignedChainReadback> {
  // Build the real grpc-js-backed client lazily ONLY when none is injected (keeps tests network-free).
  const client = opts.client ?? grpcAppendService(opts.endpoint);
  const dec = new TextDecoder();

  // 1. Read the WHOLE chain (fromSequence 0 => the entire log; a partial tail is NOT verifier-compatible).
  //    A throw here (a non-JSON canonical_event) propagates as a reject — the WHOLE read fails closed.
  // partitionId: "" — single-chain (Personal) reader; the partitioned (Enterprise) field stays empty
  // and is omitted on the wire (proto3 default), so this single-chain read is byte-identical (PK1).
  const listResp = await client.ListEntries({ fromSequence: 0, partitionId: "" });
  const entries: readonly LogEntry[] = listResp.entries.map((entry): LogEntry => {
    const event = JSON.parse(dec.decode(entry.canonicalEvent)) as AuditEvent;
    return {
      sequence: entry.sequence,
      event,
      prevHash: entry.prevHash,
      entryHash: entry.entryHash,
    };
  });

  // 2. Read the SIGNED checkpoint (K1's anchor: head + signature + pubkey).
  const checkpoint = await client.Checkpoint({ partitionId: "" });

  // 3. FAIL-CLOSED: a signed read-back MUST be signed. An empty signature or pubkey would let an
  //    UNSIGNED checkpoint masquerade as signed (e.g. a dropped wire field 4/5) — refuse it.
  if (checkpoint.checkpointSignature.length === 0) {
    throw new Error(
      "signedChainReader: kernel returned an empty checkpoint signature (fail-closed; refusing to present an unsigned chain as signed)",
    );
  }
  if (checkpoint.publicKey.length === 0) {
    throw new Error(
      "signedChainReader: kernel returned an empty public key (fail-closed; cannot establish the signing trust-root)",
    );
  }

  // 4. HEAD/LENGTH SELF-CONSISTENCY (K1-review MINOR): the checkpoint head must match the read-back
  //    entries' head (genesis if empty). ListEntries + Checkpoint are non-atomic; a divergence means an
  //    append landed between them (a torn read) — fail closed rather than hand the verifier an
  //    inconsistent snapshot it would also reject.
  const length = entries.length;
  const entriesHead = length > 0 ? (entries[length - 1] as LogEntry).entryHash : GENESIS_PREV_HASH;
  if (checkpoint.headEntryHash !== entriesHead) {
    throw new Error(
      "signedChainReader: checkpoint head does not match read-back entries' head (fail-closed; torn read between ListEntries and Checkpoint)",
    );
  }

  // 5. Build the verifier-ready SignedChain. Field names match the Go verifier's json tags
  //    (kernel/internal/chain/types.go), exactly like DV2's serialization. `length` = the entry COUNT
  //    the signature binds; `signature` is the kernel's verbatim base64 Ed25519 checkpoint signature.
  //    entries.length === checkpoint.length is upheld by construction (defensive invariant, mirrors the
  //    verifier's first check) — assert it so a future refactor cannot silently violate it.
  const chain: SignedChain = {
    entries,
    checkpoint: {
      length,
      headEntryHash: checkpoint.headEntryHash,
      signature: checkpoint.checkpointSignature,
    },
  };
  if (chain.entries.length !== chain.checkpoint.length) {
    throw new Error(
      "signedChainReader: entries.length != checkpoint.length (fail-closed; inconsistent reconstructed chain)",
    );
  }

  // 6. Convert the kernel's SPKI/PKIX DER public key -> SPKI PEM (the verifier's --pubkey input). This
  //    parses + re-serializes ONLY public material; there is no private key anywhere in this path.
  const publicKeyPem = createPublicKey({
    key: Buffer.from(checkpoint.publicKey),
    format: "der",
    type: "spki",
  }).export({ format: "pem", type: "spki" }) as string;

  return { chain, publicKeyPem };
}
