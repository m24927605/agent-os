/**
 * SLICE-DHB2b GATED LIVE harness — drive the REAL local desktop `hermes acp` as the Agent OS brain.
 *
 * This is the live half of SLICE-DHB2 (DHB2a proved the `AcpStdioTransport` protocol/parse/propose-only/
 * fail-closed/credential-blind against an in-tree FAKE `hermes acp` subprocess, inside `pnpm run verify`,
 * spending NO credits). DHB2b binds that same transport to the user's REAL, authenticated desktop Hermes
 * over ACP (Agent Client Protocol: JSON-RPC 2.0, newline-delimited over the child's stdio) and proves the
 * full chain end-to-end:
 *
 *   intent
 *     -> new AcpStdioTransport({ command: ["hermes", "acp"], cwd: <throwaway temp dir> })   (DHB2a, reused)
 *     -> new DesktopHermesTurnSource(transport)                                              (DHB1, reused)
 *     -> new HermesBrainShim(turnSource)                                                     (R11-S2, reused)
 *     -> governBrainStream(shim.execute(CTX, intent), detectSecret)                          (brain guard, reused)
 *
 * and ASSERTS the four live invariants:
 *   (a) >=1 REAL frame   — the real `hermes acp` produced at least one `session/update` -> BrainEvent.
 *   (b) GOVERNED PROPOSAL — a captured `tool-call` proposal OR at least a `plan-step` arrived (lenient:
 *       the model is nondeterministic, so we assert the chain produced governed events, not an exact tool).
 *   (c) PROPOSE-ONLY     — nothing executed on the host: the throwaway cwd has NO file the intent asked for
 *       (we declared NO fs/terminal client capability and the transport DENIES every permission request, so
 *       regardless of the intent Hermes can never self-execute a write/tool on the host).
 *   (d) CREDENTIAL-BLIND — no spurious secret denial; the chain completed (or failed closed) clean.
 *
 * DIALECT DIAGNOSTICS (the DHB2a M3/M4 confirm-or-reveal items, logged via console.info so the USER's run
 * confirms or surfaces divergence from DHB2a's wire assumptions):
 *   - M3: a cheap raw-wire `initialize`-only probe (NO `session/prompt`, so ~no model spend) logs the raw
 *     `initialize` RESULT shape AND whether `hermes acp` echoes the JSON-RPC `id` back as a NUMBER or a
 *     STRING. DHB2a only correlates NUMBER ids; a STRING id would make the real transport fail-closed (the
 *     prompt never resolves -> idle timeout) — this probe REVEALS that mismatch up front with a clear log.
 *   - M4: the live drive logs every `session/update` kind observed and the `tool_call` / permission shapes,
 *     so the `{outcome:{outcome:"cancelled"}}` deny + `agent_message_chunk`/`tool_call` assumptions are
 *     confirmed against the real dialect.
 *
 * If a dialect mismatch makes the real transport fail-closed, the test FAILS with a clear diagnostic (not a
 * hang — every wait is bounded): it tells the USER the DHB2a mapping needs a follow-up fix.
 *
 * GATED: runs ONLY when `AGENTOS_LIVE_DESKTOP_HERMES === "1"` (via `describe.skip`), so it is a NO-OP under
 * `pnpm run verify` (which stays hermetic + never spawns `hermes acp` + never spends credits). Run it via
 * the live harness — `AGENTOS_LIVE_DESKTOP_HERMES=1 pnpm run e2e:live-desktop-hermes` — which is the USER's
 * own opt-in run that spends THEIR Hermes model credits and touches THEIR authenticated account.
 *
 * CREDENTIAL-BLIND boundary (restated): this test NEVER reads `~/.hermes` (`.env`/`auth.json`), NEVER puts
 * an Agent OS secret on the child's stdin, and runs the child with the transport's MINIMAL env. Hermes
 * self-manages its own model key in its own config — never our concern, never touched here.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redactSecrets } from "../../../../audit/redact.js";
import { type BrainEvent, governBrainStream } from "../../index.js";
import { AcpStdioTransport, DesktopHermesTurnSource, HermesBrainShim } from "./index.js";

// GATE: the USER's opt-in flag. Unset -> describe.skip -> a NO-OP under `pnpm run verify`.
const LIVE = process.env.AGENTOS_LIVE_DESKTOP_HERMES === "1";
const d = LIVE ? describe : describe.skip;

/** A well-formed AgentContext for the live drive (plain non-empty strings; validates in the shim). */
const CTX = {
  actorId: "agent:dhb2b-live-desktop-hermes",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live",
  requestId: "req-live-dhb2b-1",
};

/**
 * A SAFE intent that nudges the real Hermes to PROPOSE a benign write/tool. Because we advertise NO
 * fs/terminal capability and the transport DENIES every permission request, the write can NEVER execute
 * on the host regardless of what the model proposes — so the temp cwd stays empty (invariant c).
 */
const INTENT = 'Create a file named hello.txt containing the text "hi". Do not do anything else.';

/** The basename the intent references — invariant (c) asserts it never lands in the throwaway cwd. */
const PROPOSED_FILE = "hello.txt";

// The repo's REAL secret detector (same one the shim + DHB1 tests + composition root wire): a value is
// secret-bearing iff redacting it changes its serialization. NOT re-implemented here — reused.
const detectSecret = (value: unknown): boolean =>
  JSON.stringify(redactSecrets(value)) !== JSON.stringify(value);

/** Real-LLM latency budget for the full prompt drive (handshake + a model turn + frames). */
const DRIVE_TIMEOUT_MS = 120_000;
/** The cheap M3 initialize-only probe budget (handshake only — no model turn). */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * M3 raw-wire probe: spawn `hermes acp`, send ONLY `initialize` (NO `session/new`/`session/prompt`, so it
 * does not start a model turn — ~no credit spend), capture the raw RESULT and whether the JSON-RPC `id`
 * came back as a NUMBER or a STRING. This is the dialect item DHB2a flagged (it only correlates NUMBER
 * ids). Bounded + guaranteed child cleanup. Returns null if the probe could not complete (logged, never
 * throws) so it never blocks the real invariants below.
 */
async function probeInitializeDialect(cwd: string): Promise<{
  idType: "number" | "string" | "other" | "absent";
  result: unknown;
} | null> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("hermes", ["acp"], {
      cwd,
      env: {
        ...(typeof process.env.PATH === "string" ? { PATH: process.env.PATH } : {}),
        ...(typeof process.env.HOME === "string" ? { HOME: process.env.HOME } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  child.stderr.resume();

  return await new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (
      value: { idType: "number" | "string" | "other" | "absent"; result: unknown } | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(value);
    };
    const guard = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    guard.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (line.length === 0) continue;
        let msg: { id?: unknown; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // skip non-JSON banner lines; keep reading for the response
        }
        // The response to our initialize (id === 1) — record id type + the raw result.
        if (msg.id === 1 || msg.result !== undefined || msg.error !== undefined) {
          const idType =
            msg.id === undefined
              ? "absent"
              : typeof msg.id === "number"
                ? "number"
                : typeof msg.id === "string"
                  ? "string"
                  : "other";
          finish({ idType, result: msg.result ?? { error: msg.error } });
          return;
        }
      }
    });
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));

    // Send ONLY initialize (NUMBER id 1, matching DHB2a's correlation), then wait for the response.
    if (child.stdin.writable) {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: 1, clientCapabilities: {} },
        })}\n`,
      );
    }
  });
}

d("DHB2b — Agent OS drives the REAL desktop `hermes acp` over ACP (live, propose-only)", () => {
  let cwd: string;

  beforeAll(() => {
    // A throwaway temp cwd given to the child as its working dir AND used for the propose-only assertion:
    // if anything actually executed a write on the host, hello.txt would land HERE. It must stay empty.
    cwd = mkdtempSync(join(tmpdir(), "dhb2b-live-desktop-hermes-"));
  });

  afterAll(() => {
    if (cwd !== undefined) rmSync(cwd, { recursive: true, force: true });
  });

  it(
    "intent -> real hermes acp proposal -> governed BrainEvents; propose-only + credential-blind hold",
    async () => {
      // ── M3 dialect diagnostic: cheap initialize-only probe (no model turn / ~no credits). ───────────
      const dialect = await probeInitializeDialect(cwd);
      if (dialect === null) {
        console.info(
          "[DHB2b/M3] initialize probe did not complete (timeout/spawn) — see the prompt drive below for the real failure mode",
        );
      } else {
        console.info(
          `[DHB2b/M3] initialize JSON-RPC id echoed back as: ${dialect.idType} (DHB2a correlates NUMBER ids only; a STRING id => the real transport fails-closed on the prompt)`,
        );
        console.info("[DHB2b/M3] raw initialize RESULT shape:", JSON.stringify(dialect.result));
        if (dialect.idType === "string") {
          console.info(
            "[DHB2b/M3] ⚠ DIVERGENCE: real `hermes acp` uses STRING JSON-RPC ids — DHB2a's number-only id " +
              "correlation will fail-closed (the prompt never resolves). The drive below will surface this " +
              "as zero frames / timeout; DHB2a's id matching needs a follow-up fix.",
          );
        }
      }

      // ── The REAL drive: production path, exactly as the composition root would wire it. ─────────────
      const transport = new AcpStdioTransport({
        command: ["hermes", "acp"],
        cwd,
        // Real-LLM latency: let a model turn complete before the idle guard fires. Bounded (never hangs).
        idleTimeoutMs: DRIVE_TIMEOUT_MS,
        startupTimeoutMs: PROBE_TIMEOUT_MS,
      });
      const turnSource = new DesktopHermesTurnSource(transport);
      const shim = new HermesBrainShim(turnSource);

      // Collect every governed screen result. governBrainStream stops on the FIRST credential-blind deny
      // (fail-closed); otherwise it drains the whole real session.
      const screened: Array<{ status: "ok" | "denied"; event: BrainEvent }> = [];
      for await (const r of governBrainStream(shim.execute(CTX, INTENT), detectSecret)) {
        screened.push(r);
      }

      // ── M4 dialect diagnostic: what governed events the real session actually produced. ─────────────
      const kinds = screened.map((r) => r.event.kind);
      console.info("[DHB2b/M4] governed BrainEvent kinds observed:", JSON.stringify(kinds));
      const toolCalls = screened
        .map((r) => r.event)
        .filter((e): e is Extract<BrainEvent, { kind: "tool-call" }> => e.kind === "tool-call");
      console.info(
        "[DHB2b/M4] tool-call proposals captured:",
        JSON.stringify(toolCalls.map((t) => ({ tool: t.tool, args: t.args }))),
      );

      // ── (a) >=1 REAL frame: the real `hermes acp` produced at least one governed event. ─────────────
      // A zero here is the loud failure mode of an UNCONFIRMED dialect (M3 string-id / wire mismatch ->
      // fail-closed): the transport stopped before yielding. The M3 log above tells the user which.
      expect(
        screened.length,
        "the real `hermes acp` produced NO governed events — likely a dialect mismatch (see the [DHB2b/M3] " +
          "log: a STRING JSON-RPC id or a wire-format divergence makes DHB2a's transport fail-closed). " +
          "DHB2a's mapping needs a follow-up fix.",
      ).toBeGreaterThan(0);

      // ── (b) GOVERNED PROPOSAL: a captured tool-call OR at least a plan-step (lenient: model is ───────
      // nondeterministic; we assert the chain produced governed events, not an exact tool).
      expect(
        kinds.includes("tool-call") || kinds.includes("plan-step"),
        "expected at least a governed tool-call PROPOSAL or a plan-step from the real session",
      ).toBe(true);

      // ── (d) CREDENTIAL-BLIND: no spurious secret denial; the chain completed clean (or failed closed ─
      // clean). A denial here would mean a real literal secret rode in a payload — which would be a real
      // finding, not a spurious one, given the benign intent.
      const denied = screened.filter((r) => r.status === "denied");
      expect(
        denied,
        "no governed event should be denied for the benign intent (credential-blind held; a deny would " +
          "mean a literal secret rode in a payload)",
      ).toEqual([]);

      // Every governed event carries the live AgentContext we passed (identity threaded end-to-end).
      for (const r of screened) {
        expect(`${r.event.context.tenantId}`).toBe("tenant-live");
        expect(`${r.event.context.actorId}`).toBe("agent:dhb2b-live-desktop-hermes");
      }

      // ── (c) PROPOSE-ONLY: nothing executed on the host. The throwaway cwd must NOT contain the file ──
      // the intent asked Hermes to write. We declared no fs/terminal capability and the transport DENIES
      // every `session/request_permission`, so Hermes can never have self-executed the write.
      const entries = readdirSync(cwd);
      console.info("[DHB2b] throwaway cwd contents after the drive:", JSON.stringify(entries));
      expect(
        entries.includes(PROPOSED_FILE),
        `PROPOSE-ONLY VIOLATION: "${PROPOSED_FILE}" was actually written to the host cwd — Hermes self-executed a tool. The transport must DENY every permission request.`,
      ).toBe(false);
    },
    // Generous timeout: real LLM latency + the M3 probe, with margin so a slow turn does not flake.
    DRIVE_TIMEOUT_MS + PROBE_TIMEOUT_MS + 30_000,
  );
});
