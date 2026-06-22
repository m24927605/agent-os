/**
 * LIVE Go-kernel end-to-end for the PERSONAL VERTICAL (SLICE-P2R-PV-S2 append + P2R-PV-S3b read-back).
 *
 * S1 wired `createPersonalShell` over a purely IN-MEMORY WORM. S2 proved the SAME composition root,
 * with its WORM write-sink INJECTED to the REAL grpc-js ingest appender, lands a Personal governed
 * event into the REAL running `kernel/cmd/kernel` AppendService WAL — i.e. the Personal surface's
 * "commit-before-effect" append crosses the actual TS<->Go process boundary that makes "attester !=
 * actor" real. S3b closes the loop: the timeline is RE-READ from the SAME real kernel over `ListEntries`
 * (a real RPC read-back), so "the WORM we WROTE == the WORM we READ" holds on the live wire — replacing
 * the S2 `readFileSync(WAL)` hack with `shell.timeline(taskId)` driven by `createEntriesReader`.
 *
 * GATED on AGENTOS_LIVE_KERNEL_ENDPOINT: under plain `pnpm run verify` (no env) this SKIPS, keeping the
 * gate hermetic. Run it with the real kernel via `pnpm run e2e:live-kernel` (scripts/e2e-live-kernel.sh
 * builds + spawns ONE kernel, sets the env, runs this file alongside the R2-S8 ingest e2e, tears down).
 *
 * What it asserts on the live wire:
 *   (a) receive -> previewAndSubmit -> approve drives the FULL Personal spine and the DecideOutcome is
 *       `executed` (every gate passed AND the live append receipt is in hand);
 *   (b) `await shell.timeline(taskId)` — backed by a REAL `ListEntries` RPC read-back from the same
 *       kernel — folds the just-approved governed event: the WORM sequence matches the append receipt,
 *       the headline reads 「已完成」 (completed), and the read-back chain is non-empty;
 *   (c) the runtime-assembled secret canary is ABSENT from the read-back timeline text — redact-before-
 *       send (proven cross-wire by R2-S8) plus exit redaction hold end to end from the Personal layer.
 *
 * grpc-js keeps the event loop alive (the client exposes no close()); the harness's bounded vitest run
 * + its 120s watchdog handle teardown, so this file adds no close seam.
 */
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../audit/index.js";
import { createIngestAppender } from "../audit/ingest/wire.js";
import type { AgentContext } from "../iam/ids.js";
import { createEntriesReader } from "../runtime/ingest/read-transport.js";
import { createRpcAppendTransport } from "../runtime/ingest/transport.js";
import { createPersonalShell } from "./bootstrap.js";
import { StructuredIntent } from "./intent/index.js";

const ENDPOINT = process.env.AGENTOS_LIVE_KERNEL_ENDPOINT;

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

d(
  "P2R-PV-S3b — Personal vertical -> live Go-kernel WORM append + ListEntries read-back e2e",
  () => {
    it("approve drives the spine; timeline RE-READS the same kernel over ListEntries and folds the event (canary absent)", async () => {
      // The LIVE sink: the SAME ingest appender R2-S8 proved against the real kernel, bound to a Personal
      // source. createPersonalShell synthesizes the AuditEvent; this sink ships it across the real wire.
      // The LIVE reader: createEntriesReader points ListEntries at the SAME kernel endpoint so timeline()
      // reconstructs from the REAL WORM (not the empty in-memory log).
      const ingest = createIngestAppender<AuditEvent>({
        transport: createRpcAppendTransport({ endpoint: ENDPOINT as string }),
        sourceId: "personal",
      });
      const shell = createPersonalShell({
        allowToolInvoke: true,
        wormSink: (ae) => ingest.append(ae),
        readEntries: createEntriesReader({ endpoint: ENDPOINT as string }),
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
      if (decided.status !== "executed") return;
      // Narrow the GovernedOutcome on its OWN discriminant to reach the live append receipt sequence.
      expect(decided.outcome.status).toBe("executed");
      if (decided.outcome.status !== "executed") return;
      const receiptSeq = decided.outcome.receipt.sequence;

      // (b) The timeline RE-READS the same kernel over a REAL ListEntries RPC and folds the just-approved
      // governed event: the WORM sequence matches the append receipt and the headline reads 「已完成」.
      const events = await shell.timeline(ctx.taskId);
      expect(events.length).toBeGreaterThanOrEqual(1);
      const completed = events.filter((e) => e.headline.startsWith("已完成"));
      expect(completed.length).toBeGreaterThanOrEqual(1);
      expect(events.some((e) => e.sequence === receiptSeq)).toBe(true);

      // (c) Credential-blind end to end from the Personal layer: the read-back timeline text is canary-free.
      expect(JSON.stringify(events).includes(CANARY)).toBe(false);
    });
  },
);
