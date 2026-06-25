/**
 * SLICE-AGT1-A — the bin reason redact: an advisory secondary's `reason` cannot leak a secret into the
 * bin's authorize decision (the necessary precursor before ANY advisory secondary is wired into the bin).
 *
 * THE GAP THIS CLOSES (mirrors the IT1a three-surface fix): SETUP1a wired advisory secondaries into the
 * bin's `buildDeps.authorize` via `combineDecisions(pdp, evaluateSecondaries(secondaries, req))`, but
 * returned `combined.reason` RAW. An untrusted advisory secondary's `reason` therefore flowed unredacted
 * out of the authorize boundary into `runGovernedToolCall`'s commit-before-effect AuditEvent
 * (`decisionReason: decision.reason`, src/orchestration/pipeline.ts). The three surfaces
 * (personal/enterprise/developer bootstrap) already `redactSecrets(combined.reason)` after the fold;
 * AGT1-A mirrors that on the bin. The one-line production change is exactly:
 *   `return { effect: combined.effect, reason: redactSecrets(combined.reason) };`
 *
 * ── HONEST NON-VACUITY POSTURE (load-bearing — read before trusting the assertions) ──
 * The IT1a developer-surface test proved the authorize-redact load-bearing via `replayFold()` because the
 * developer surface's WORM is `InMemoryAppendOnlyLog`, whose `append()` stores the RAW event object (only
 * the hash uses redacted canonical bytes) — so the RAW `decisionReason` survives into `worm.entries()`
 * unless authorize redacts. THE BIN IS DIFFERENT: its REAL appender is
 * `createPartitionedIngestSink(transport, binding)` -> `createIngestClient.append`, which runs
 * `canonicalizeAuditEvent(event)` — and `canonicalizeAuditEvent` redacts (the SAME `redactSecrets`) BEFORE
 * canonicalizing — and only THEN ships `{sourceId, sequence, canonicalEvent}` over the transport. So the
 * injectable Fake `ingestTransport` ONLY ever observes the ALREADY-REDACTED `canonicalEvent` bytes.
 * Consequently a test that inspects the committed `canonicalEvent` for the canary is NOT an independent
 * non-vacuity proof of the AGT1-A wrap: removing the authorize-redact leaves the canonicalize-layer redact
 * in place, so the canonical WORM bytes stay canary-free and such an assertion would stay GREEN.
 *
 * THE GENUINELY NON-VACUOUS PROOF (NON-LEAK-AUTHORIZE below): test the authorize boundary DIRECTLY — the
 * exact contract the one-line fix lives on. Build the bin's REAL deps with a SecretLeakingSecondary
 * injected, call `deps.authorize({ tool: 'exec.echo', context: deps.context })`, and assert the returned
 * `reason` does NOT contain the runtime-built `sk-` canary. Remove the `redactSecrets(...)` wrap (return
 * the raw `combined.reason`) and THIS flips RED — the secondary's secret-bearing reason surfaces verbatim.
 *
 * THE END-TO-END REGRESSION (WORM-NO-LEAK below, clearly labeled): drive a governed `exec.echo` through
 * the full bin path and assert the call EXECUTED and the committed `canonicalEvent` bytes are canary-free.
 * This guards the canonical-WORM defense and the executed-path (so the secret-bearing ALLOW secondary does
 * not also break the happy path), but — per the posture above — it is NOT the AGT1-A non-vacuity proof
 * (canonicalize also redacts), so it is documented as canonical-bytes defense coverage only.
 *
 * CLEAN-REASON IDENTITY: `redactSecrets` on a secret-free reason is the identity. AGT1-A only wraps the
 * ALREADY-combined reason (SETUP1a's `combineDecisions(pdp, [])`, which rewraps the text but is byte-stable
 * for a fixed pdp) in `redactSecrets`; on a clean reason that wrap is a no-op, so the no-secondary default
 * path is byte-identical to pre-AGT1-A — the EXEC4c + SETUP1a tests stay green by construction.
 *
 * TEST POSTURE (same as SETUP1a): a Fake substrate (in-repo, no real OpenShell) + a Fake AppendTransport
 * (no real kernel). The `sk-` canary is RUNTIME-BUILT (never a source literal), so secret-scan stays clean.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  AppendRequestShape,
  AppendResponseShape,
  AppendTransport,
} from "../../../../../audit/index.js";
import { redactSecrets } from "../../../../../audit/index.js";
import type {
  PolicyDecision,
  PolicyRequest,
  SecondaryPolicyAdapter,
} from "../../../../../policy/index.js";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
} from "../../../../substrate/index.js";
import { buildBinDeps } from "./exec-mcp-server-bin.js";
import { runExecMcpStdio } from "./exec-mcp-stdio.js";

// A runtime-ASSEMBLED secret canary — NEVER a literal in source (keeps secret-scan clean). The `sk-`
// shape (>=16 alnum chars) is a high-signal SECRET_VALUE the audit `redactSecrets` scrubs to [REDACTED].
const SECRET_CANARY = `sk-${"x".repeat(20)}`;
// A non-sensitive prefix the secondary embeds AROUND the canary — survives redaction (asserts the
// redact is surgical: it scrubs the secret SUBSTRING, not the whole reason).
const SECONDARY_PREFIX = "advisory leaked a credential:";

/**
 * A hostile/buggy advisory whose `reason` carries a SECRET. It ALLOWS (so the combined reason is the
 * fold of the PDP allow + this secret-bearing reason, and the governed call proceeds to commit/effect —
 * exercising the WRITE path). The bin's authorize MUST scrub the secondary-derived reason before it
 * leaves the authorize boundary into the committed AuditEvent.
 */
class SecretLeakingSecondary implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): PolicyDecision {
    return {
      effect: "allow",
      reason: `${SECONDARY_PREFIX} ${SECRET_CANARY}`,
      auditRequired: true,
    };
  }
}

/** A spying Fake substrate: counts exec calls so a test can assert the substrate actually ran the effect. */
class SpyFakeSandboxAdapter extends FakeSandboxAdapter {
  readonly execCalls: ExecCommandSpec[] = [];
  override createSandbox(ctx: unknown, spec: SandboxSpec): Promise<AdapterResult> {
    return super.createSandbox(ctx, spec);
  }
  override execSandbox(
    ctx: unknown,
    sandboxId: string,
    spec: ExecCommandSpec,
  ): Promise<ExecResult> {
    this.execCalls.push(spec);
    return super.execSandbox(ctx, sandboxId, spec);
  }
}

/**
 * A FakeKernelTransport that returns a well-formed receipt (so commit-before-effect treats every append
 * as durable) AND records every `AppendRequestShape` it forwards (so the WORM regression can inspect the
 * committed `canonicalEvent` bytes for the canary).
 */
interface RecordingKernelTransport extends AppendTransport {
  readonly requests: AppendRequestShape[];
}
function recordingKernelTransport(): RecordingKernelTransport {
  const requests: AppendRequestShape[] = [];
  let sequence = 0;
  return {
    requests,
    append(req: AppendRequestShape): Promise<AppendResponseShape> {
      requests.push(req);
      sequence += 1;
      return Promise.resolve({
        receipt: {
          sequence,
          contentHash: `content-${sequence}`,
          prevHash: sequence === 1 ? "GENESIS" : `content-${sequence - 1}`,
          entryHash: `entry-${sequence}`,
        },
      });
    },
  };
}

// ==================================================================================================
// AGT1-A NON-LEAK-AUTHORIZE — the GENUINELY NON-VACUOUS proof of the one-line fix. The bin's authorize
//   boundary (the SAME contract the three surfaces redact on) scrubs an untrusted advisory secondary's
//   secret-bearing reason BEFORE returning the decision that flows into the committed AuditEvent.
//   NON-VACUITY: remove the `redactSecrets(...)` wrap (return raw `combined.reason`) -> the returned
//   reason contains the canary verbatim -> this test flips RED.
// ==================================================================================================
describe("AGT1-A NON-LEAK-AUTHORIZE — the bin authorize redacts an advisory secondary's secret-bearing reason", () => {
  it("a secret in an ALLOW advisory's reason is SCRUBBED from the authorize decision the bin returns", async () => {
    const { deps } = await buildBinDeps(false, {
      ingestTransport: recordingKernelTransport(),
      substrate: new SpyFakeSandboxAdapter(),
      secondaries: [new SecretLeakingSecondary()],
    });

    // Call the authorize boundary DIRECTLY with the bin's own context (the authorize reads c.requestId
    // etc. off `deps.context`, which is the bin's BIN_CONTEXT). exec.echo is PDP-allowed, and the
    // secondary ALLOWS, so the combined effect is "allow" and the combined reason folds in the secret.
    // SLICE-R9a: the bin authorize closure is now async (it awaits evaluateSecondaries) — `await` it.
    const decision = await deps.authorize({ tool: "exec.echo", context: deps.context });

    // The fold did not relax the allow (PDP allow + advisory allow).
    expect(decision.effect).toBe("allow");
    // The secret SUBSTRING is scrubbed — the canary never leaves the authorize boundary.
    // NON-VACUITY: drop the `redactSecrets(...)` wrap and `decision.reason` contains SECRET_CANARY -> RED.
    expect(decision.reason).not.toContain(SECRET_CANARY);
    // Surgical, not nuking: the non-sensitive prefix survives (only the secret shape is replaced).
    expect(decision.reason).toContain(SECONDARY_PREFIX);
  });
});

// ==================================================================================================
// AGT1-A CLEAN-REASON-IDENTITY — `redactSecrets` on a secret-free reason is the IDENTITY, so the
//   no-secondary default path is byte-identical to pre-AGT1-A (the EXEC4c/SETUP1a invariant). With NO
//   injected secondaries, `combineDecisions(pdp, [])` === the PDP decision and `redactSecrets(pdp.reason)
//   === pdp.reason`, so the bin's authorize returns EXACTLY the PDP reason — no spurious change.
// ==================================================================================================
describe("AGT1-A CLEAN-REASON-IDENTITY — redact is identity on a secret-free reason (no-secondary path byte-identical)", () => {
  it("with NO secondaries the authorize reason equals the un-redacted PDP reason (clean-reason identity)", async () => {
    const { deps } = await buildBinDeps(false, {
      ingestTransport: recordingKernelTransport(),
      substrate: new SpyFakeSandboxAdapter(),
      // no `secondaries` => combineDecisions(pdp, []) === pdp.
    });

    const decision = await deps.authorize({ tool: "exec.echo", context: deps.context });
    expect(decision.effect).toBe("allow");
    // The PDP's reason is secret-free, so redactSecrets is the identity: the returned reason equals
    // exactly what redactSecrets(reason) yields — i.e. no change vs. the un-wrapped value.
    expect(decision.reason).toBe(redactSecrets(decision.reason));
    expect(decision.reason).not.toContain("[REDACTED]");
  });
});

// ==================================================================================================
// AGT1-A WORM-NO-LEAK (end-to-end REGRESSION — canonical-bytes defense, NOT the AGT1-A non-vacuity proof).
//   Drive a governed exec.echo through the full bin path with the secret-bearing ALLOW secondary injected;
//   assert the call EXECUTED (the secret-bearing reason did not break the happy path) AND the committed
//   `canonicalEvent` bytes are canary-free. PER THE FILE-HEADER POSTURE: because `canonicalizeAuditEvent`
//   ALSO redacts, removing ONLY the authorize-redact wrap leaves this GREEN — so this is NOT an independent
//   non-vacuity proof of AGT1-A; it guards the canonical-WORM defense + the executed path.
// ==================================================================================================
describe("AGT1-A WORM-NO-LEAK — the committed canonical WORM bytes carry no canary (canonical-bytes regression)", () => {
  it("a governed exec.echo executes and the committed canonicalEvent contains no secret canary", async () => {
    const transport = recordingKernelTransport();
    const spy = new SpyFakeSandboxAdapter();
    const { deps } = await buildBinDeps(false, {
      ingestTransport: transport,
      substrate: spy,
      secondaries: [new SecretLeakingSecondary()],
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    const done = runExecMcpStdio(deps, { input, output });
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "exec.echo", arguments: { text: "hello" } },
      })}\n`,
    );
    input.end();
    await done;

    const responses = Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const result = responses[0]?.result as { isError: boolean; content: { text: string }[] };

    // The ALLOW secondary did not break the happy path — the governed call EXECUTED.
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("echo hello");
    expect(spy.execCalls.length).toBe(1);

    // The committed canonical WORM bytes carry no secret (canonical-bytes defense — canonicalize redacts).
    expect(transport.requests.length).toBe(1);
    const committed = new TextDecoder().decode(transport.requests[0]?.canonicalEvent);
    expect(committed).not.toContain(SECRET_CANARY);
  });
});
