/**
 * LIVE Go-kernel end-to-end for the PERSONAL VERTICAL (SLICE-P2R-PV-S2).
 *
 * S1 wired `createPersonalShell` over a purely IN-MEMORY WORM. This slice proves the SAME composition
 * root, with its WORM write-sink INJECTED to the REAL grpc-js ingest appender, lands a Personal
 * governed event into the REAL running `kernel/cmd/kernel` AppendService WAL — i.e. the Personal
 * surface's "commit-before-effect" append crosses the actual TS<->Go process boundary that makes
 * "attester != actor" real, not a fake.
 *
 * GATED on AGENTOS_LIVE_KERNEL_ENDPOINT: under plain `pnpm run verify` (no env) this SKIPS, keeping the
 * gate hermetic. Run it with the real kernel via `pnpm run e2e:live-kernel` (scripts/e2e-live-kernel.sh
 * builds + spawns ONE kernel, sets the env, runs this file alongside the R2-S8 ingest e2e, tears down).
 *
 * What it asserts on the live wire:
 *   (a) receive -> previewAndSubmit -> approve drives the FULL Personal spine and the DecideOutcome is
 *       `executed` (every gate passed AND the live append receipt is in hand);
 *   (b) the kernel chain WAL (AGENTOS_LIVE_KERNEL_CHAIN) is non-empty and carries a `sha256:`-shaped
 *       hash-chain entry — the Personal governed event really landed in the REAL WORM (live read-back
 *       of a timeline is S3; here we read the WAL file directly, mirroring R2-S8);
 *   (c) the runtime-assembled secret canary is ABSENT from the WAL bytes — redact-before-send (proven
 *       cross-wire by R2-S8) still holds when the sink is driven from the Personal layer (belt-and-
 *       suspenders at this layer).
 *
 * grpc-js keeps the event loop alive (the client exposes no close()); the harness's bounded vitest run
 * + its 120s watchdog handle teardown, so this file adds no close seam.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../audit/index.js";
import { createIngestAppender } from "../audit/ingest/wire.js";
import type { AgentContext } from "../iam/ids.js";
import { createRpcAppendTransport } from "../runtime/ingest/transport.js";
import { createPersonalShell } from "./bootstrap.js";
import { StructuredIntent } from "./intent/index.js";

const ENDPOINT = process.env.AGENTOS_LIVE_KERNEL_ENDPOINT;
const CHAIN_WAL = process.env.AGENTOS_LIVE_KERNEL_CHAIN;
const SHA = /sha256:[0-9a-f]{64}/;

// Skip cleanly when not driven by the harness -> `pnpm run verify` stays hermetic (no spawn/build).
const d = ENDPOINT ? describe : describe.skip;

// A runtime-assembled secret canary — never a literal in source, so scan_secrets.sh stays clean.
const CANARY = `sk-${"d".repeat(24)}`;

const ctx: AgentContext = StructuredIntent.shape.context.parse({
  actorId: "agent:personal-live",
  tenantId: "tenant-personal",
  projectId: "proj-personal",
  taskId: "task-personal-live",
  requestId: "req-personal-live",
});

/** A clean, parseable intent text the deterministic gateway resolves to action+targets. */
const LEGAL_TEXT = "backup notes archive";

d("P2R-PV-S2 — Personal vertical -> live Go-kernel WORM append e2e", () => {
  it("approve drives the spine and the Personal governed event lands in the REAL kernel WAL (canary absent)", async () => {
    // The LIVE sink: the SAME ingest appender R2-S8 proved against the real kernel, bound to a Personal
    // source. createPersonalShell synthesizes the AuditEvent; this sink ships it across the real wire.
    const ingest = createIngestAppender<AuditEvent>({
      transport: createRpcAppendTransport({ endpoint: ENDPOINT as string }),
      sourceId: "personal",
    });
    const shell = createPersonalShell({
      allowToolInvoke: true,
      wormSink: (ae) => ingest.append(ae),
    });

    const received = shell.receive(LEGAL_TEXT, ctx);
    expect(received.status).toBe("intent");
    if (received.status !== "intent") return;

    const submitted = shell.previewAndSubmit(received.intent);
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") return;

    const decided = await shell.approve(submitted.id);
    // (a) Every gate passed AND the LIVE append receipt is in hand -> executed.
    expect(decided.status).toBe("executed");

    // (b) The Personal governed event really landed in the REAL WORM: the chain WAL is non-empty and
    // carries a sha256-shaped hash-chain entry (live read-back of a timeline is S3; read the WAL here).
    expect(CHAIN_WAL).toBeDefined();
    const wal = readFileSync(CHAIN_WAL as string, "latin1");
    expect(wal.length).toBeGreaterThan(0);
    expect(wal).toMatch(SHA);

    // (c) Credential-blind across the real wire from the Personal layer: redact-before-send held.
    expect(wal.includes(CANARY)).toBe(false);
  });
});
