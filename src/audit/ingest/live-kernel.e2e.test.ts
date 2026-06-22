/**
 * LIVE Go-kernel end-to-end (R2-S8): the REAL grpc-js ingest appender appending real AuditEvents to a
 * REAL running `kernel/cmd/kernel` AppendService process (cross-process, cross-language TS<->Go). Proves
 * the commit path, the hash chain, fail-closed replay, and credential-blindness hold on the process
 * boundary that makes "attester != actor" real.
 *
 * GATED on AGENTOS_LIVE_KERNEL_ENDPOINT: under plain `pnpm run verify` (no env) this SKIPS, keeping the
 * gate hermetic. Run it with the real kernel via `pnpm run e2e:live-kernel` (scripts/e2e-live-kernel.sh
 * builds + spawns the kernel, sets the env, then tears down).
 *
 * Chain integrity is proven IN-TEST by independently RECOMPUTING the kernel's receipts with the TS
 * reference (`computeEntryHash`/`contentAddress`, same canonicalizer the client sends) — a stronger,
 * cross-language check than the offline verifier binary, which consumes a SignedChain JSON (+pubkey)
 * rather than the raw append WAL and whose checkpoint/export path is not wired here (R10-S3).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRpcAppendTransport } from "../../runtime/ingest/transport.js";
import { contentAddress } from "../canonical.js";
import { type AuditEvent, createAuditEvent } from "../event.js";
import { GENESIS_PREV_HASH, computeEntryHash } from "../kernel/log.js";
import { createIngestAppender } from "./wire.js";

const ENDPOINT = process.env.AGENTOS_LIVE_KERNEL_ENDPOINT;
const CHAIN_WAL = process.env.AGENTOS_LIVE_KERNEL_CHAIN;
const SHA = /^sha256:[0-9a-f]{64}$/;

// Skip cleanly when not driven by the harness -> `pnpm run verify` stays hermetic (no spawn/build).
const d = ENDPOINT ? describe : describe.skip;

function mkEvent(action: string, reason = "ok"): AuditEvent {
  return createAuditEvent({
    actorId: "agent:e2e",
    tenantId: "tenant-e2e",
    projectId: "proj-1",
    taskId: "task-1",
    requestId: `req-${action}`,
    action,
    resource: "res-prod",
    policyDecision: { effect: "allow", reason },
    result: "success",
  });
}

function appenderFor(sourceId: string) {
  return createIngestAppender<AuditEvent>({
    transport: createRpcAppendTransport({ endpoint: ENDPOINT as string }),
    sourceId,
  });
}

d("R2-S8 — live Go-kernel cross-process ingest e2e", () => {
  it("appends two events that form a valid hash chain the TS reference recomputes byte-for-byte", async () => {
    const a = appenderFor("e2e-chain");

    const e0 = mkEvent("create");
    const r0 = await a.append(e0);
    expect(r0.sequence).toBe(0);
    expect(r0.prevHash).toBe(GENESIS_PREV_HASH);
    expect(r0.contentHash).toMatch(SHA);
    expect(r0.entryHash).toMatch(SHA);
    // Cross-language: the Go kernel computed the SAME content/entry hashes as the TS reference.
    expect(r0.contentHash).toBe(contentAddress(e0));
    expect(r0.entryHash).toBe(computeEntryHash(e0, GENESIS_PREV_HASH, 0));

    const e1 = mkEvent("update");
    const r1 = await a.append(e1);
    expect(r1.sequence).toBe(1);
    expect(r1.prevHash).toBe(r0.entryHash); // chain linkage across the real wire
    expect(r1.entryHash).toBe(computeEntryHash(e1, r0.entryHash, 1));
  });

  it("FAIL-CLOSED: a replayed sequence is DENIED by the kernel and the appender rejects", async () => {
    const a1 = appenderFor("e2e-replay");
    await a1.append(mkEvent("first")); // settles sequence 0

    // A fresh appender on the SAME source restarts its counter at 0 -> resends a settled position.
    const a2 = appenderFor("e2e-replay");
    await expect(a2.append(mkEvent("conflict"))).rejects.toThrow(/SEQUENCE_REPLAY/);
  });

  it("CREDENTIAL-BLIND: a secret in the event is redacted before the bytes reach the kernel WAL", async () => {
    const canary = `sk-${"x".repeat(24)}`; // runtime-assembled; never a source literal (secret-scan stays clean)
    const a = appenderFor("e2e-cred");
    await a.append(mkEvent("secret-bearing", canary));

    expect(CHAIN_WAL).toBeDefined();
    const wal = readFileSync(CHAIN_WAL as string, "latin1");
    expect(wal.includes(canary)).toBe(false); // redact-before-send held across the real wire
  });
});
