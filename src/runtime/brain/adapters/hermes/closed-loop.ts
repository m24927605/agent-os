/**
 * Multi-turn DRIVER — closes the desktop-Hermes agentic loop (SLICE-DHB3a, Design B).
 *
 * It sits ABOVE `runGovernedToolCall` (it does NOT duplicate governance, NEVER executes anything
 * itself, and does NOT touch pipeline.ts / the commit-before-effect guard). For each turn of a held
 * duplex ACP session it:
 *   1. takes the turn's proposal frames and maps each `tool_call` to a `GovernedCall` (reusing the DHB1
 *      `parseFrame` dialect mapping);
 *   2. runs EACH tool-call proposal through `runGovernedToolCall(deps, call)` on Agent OS's OWN injected
 *      deps (the effect is the caller's substrate — a Fake in DHB3a; commit-before-effect unchanged);
 *   3. serializes the `GovernedOutcome`s to a brief result text (executed -> "result of <tool>: <detail
 *      or receipt>"; denied -> "DENIED: <reason>");
 *   4. passes that text through `redactSecrets` BEFORE it egresses (credential-blind outbound — the
 *      symmetric counterpart to the inbound brain screen);
 *   5. feeds the redacted text back as the NEXT `session/prompt` and loops — until a terminal stopReason
 *      with NO further proposal, no proposal at all, an error, or the hard `maxTurns` cap.
 *
 * INVARIANTS preserved (each with a test): propose-only across the loop (transport answers
 * request_permission -> cancelled every turn); deny-not-executed-and-reported (a `denied` outcome runs
 * no effect and is fed back as "DENIED: …"); credential-blind outbound (redactSecrets before egress);
 * brain-untrusted (every next proposal re-enters the full PDP pipeline; raw args are never echoed back —
 * only status/detail/receipt-id); commit-before-effect (guard.ts unmodified, an aborted commit => deny,
 * never a fabricated result); fail-closed + a hard maxTurns cap (no unbounded spin, child torn down).
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone. Imports ONLY in-module types + the
 * NEUTRAL orchestration barrel (`runGovernedToolCall`) + the audit barrel (`redactSecrets`) — both via
 * their public index, so no deep cross-module import. Exported via the hermes barrel.
 */
import { redactSecrets } from "../../../../audit/index.js";
import {
  type GovernedCall,
  type GovernedOutcome,
  type GovernedToolCallDeps,
  runGovernedToolCall,
} from "../../../../orchestration/index.js";
import type { AcpUpdateFrame, DuplexDesktopHermesTransport } from "./desktop.js";
import { parseFrame } from "./desktop.js";

/** Options for {@link runClosedLoop}. */
export interface ClosedLoopOptions {
  /** Hard upper bound on prompt turns — prevents an unbounded loop. Default: 12. */
  readonly maxTurns?: number;
}

/** Why the loop stopped (for assertions + diagnostics). */
export type ClosedLoopStop = "terminal" | "no-proposal" | "maxTurns" | "session-end";

/** Summary of a closed-loop run. */
export interface ClosedLoopResult<R> {
  /** How many prompt turns were driven. */
  readonly turns: number;
  /** Every governed outcome across all turns, in order. */
  readonly outcomes: ReadonlyArray<GovernedOutcome<R>>;
  /** The termination reason. */
  readonly stoppedBy: ClosedLoopStop;
}

const DEFAULT_MAX_TURNS = 12;

/** Map a turn's proposal frames to the tool-call proposals Agent OS governs (reusing DHB1 parseFrame). */
function toolCallsFromFrames(frames: readonly AcpUpdateFrame[]): {
  tool: string;
  args: Record<string, unknown>;
}[] {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  for (const frame of frames) {
    const turn = parseFrame(frame);
    for (const tc of turn?.toolCalls ?? []) {
      calls.push({ tool: tc.tool, args: tc.args });
    }
  }
  return calls;
}

/** Serialize one governed outcome to a brief result line (status/detail/receipt only — never raw args). */
function serializeOutcome<R>(tool: string, outcome: GovernedOutcome<R>): string {
  if (outcome.status === "executed") {
    const detail = outcome.detail ?? String(outcome.receipt);
    return `result of ${tool}: ${detail}`;
  }
  return `DENIED: ${tool} @${outcome.stage} — ${outcome.reason}`;
}

/**
 * Drive the closed agentic loop. The DRIVER takes the transport (held duplex ACP session), Agent OS's
 * own `GovernedToolCallDeps` (so governance is NOT duplicated), the AgentContext for the governed call,
 * the initial intent, and a `maxTurns` cap. It returns once the loop terminates.
 *
 * Fail-closed: if the transport throws (spawn/nonzero/malformed/EOF/JSON-RPC-error) it propagates out
 * and the session is torn down in `finally` (deny-by-default). An aborted commit is a `denied` outcome
 * fed back as "DENIED: …" — never a fabricated success.
 */
export async function runClosedLoop<R>(
  transport: DuplexDesktopHermesTransport,
  deps: GovernedToolCallDeps<GovernedCall, R>,
  context: unknown,
  intent: string,
  options: ClosedLoopOptions = {},
): Promise<ClosedLoopResult<R>> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const outcomes: GovernedOutcome<R>[] = [];
  let turns = 0;
  let stoppedBy: ClosedLoopStop = "session-end";

  const session = await transport.openSession(intent);
  try {
    for (;;) {
      if (turns >= maxTurns) {
        stoppedBy = "maxTurns";
        break;
      }
      const turn = await session.nextTurn();
      if (turn === null) {
        stoppedBy = "session-end";
        break;
      }
      turns += 1;

      const proposals = toolCallsFromFrames(turn.frames);
      if (proposals.length === 0) {
        // No tool-call proposal this turn. A terminal stopReason with nothing to govern => the loop is
        // done (do NOT feed a fabricated result). Non-terminal-with-nothing also ends — nothing to send.
        stoppedBy = turn.stopReason === "end_turn" ? "terminal" : "no-proposal";
        break;
      }

      // Govern EACH proposal through the SAME pipeline (commit-before-effect unchanged).
      const lines: string[] = [];
      for (const p of proposals) {
        const call: GovernedCall = { tool: p.tool, context };
        const outcome = await runGovernedToolCall(deps, call);
        outcomes.push(outcome);
        lines.push(serializeOutcome(p.tool, outcome));
      }

      // Credential-blind OUTBOUND: redact BEFORE the result text egresses to Hermes.
      const resultText = redactSecrets(lines.join("\n"));

      // If we've hit the cap, stop WITHOUT sending another prompt (no further turn would be read).
      if (turns >= maxTurns) {
        stoppedBy = "maxTurns";
        break;
      }
      await session.feed(resultText);
    }
  } finally {
    await session.close();
  }

  return { turns, outcomes, stoppedBy };
}
