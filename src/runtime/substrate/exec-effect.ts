/**
 * exec-backed governed effect — turns the substrate exec primitive into a pipeline `EffectResult`
 * (commit-before-effect's injected effect), with three HARD safety properties:
 *
 *  1. CREDENTIAL-BLIND INPUT  — before any exec, the derived `env` is screened; if ANY env VALUE is
 *     secret-shaped (the injected detector — the repo wires `redactSecrets`-changed), the effect DENIES
 *     fail-closed and `execSandbox` is NEVER called, so a raw secret never reaches the substrate/process.
 *  2. CREDENTIAL-BLIND OUTPUT — stdout AND stderr are `redactSecrets`'d BEFORE they enter the result, so
 *     a secret a command echoes never lands in the audit-bound `EffectResult.detail`.
 *  3. OUTPUT CAP             — the redacted combined output is truncated to `maxOutputBytes` (default
 *     64KB) with a clear `[truncated]` marker, bounding what flows downstream.
 *
 * Fail-closed mapping: an `ExecResult{ok:false}` (Null adapter / unknown sandbox / no-terminal-exit /
 * launch failure) maps to `EffectResult{ok:false}` — a failed exec is NEVER reported as a successful
 * exit 0. The effect itself never throws: any unexpected error resolves to a denied `EffectResult`.
 *
 * Decoupling: the secret detector is INJECTED (default uses the audit barrel's `redactSecrets`), exactly
 * like the brain credential guard — this file consumes `redactSecrets` through the audit PUBLIC barrel,
 * never an internal path, so dependency-cruiser `not-to-internal` holds. It is the ONLY substrate file
 * that touches audit; port/null/fake stay at the cohesion chokepoint (zod + identity primitives only).
 */
import { redactSecrets } from "../../audit/index.js";
import type { EffectResult } from "../../orchestration/index.js";
import type { ExecCapableSandboxAdapter, ExecCommandSpec } from "./port.js";

/**
 * The credential-blind detector contract for the exec env INPUT guard: returns true if `value`
 * (recursively) contains a secret-shaped value or secret-keyed field.
 *
 * Exported under a substrate-local name `ExecSecretDetector` (NOT the brain's `SecretDetector`) so the
 * top-level aggregator carries no duplicate public name and substrate keeps a single inward dependency
 * edge (audit + orchestration types only — no brain edge). It is structurally identical to the brain's
 * detector, so a caller wiring the brain's `redactSecrets`-based detector satisfies it directly. The
 * detector is INJECTED by the composition root, exactly like the brain credential guard.
 */
export type ExecSecretDetector = (value: unknown) => boolean;

/** Default detector: a value is secret-shaped iff `redactSecrets` changes it (same as every bootstrap). */
const defaultDetectSecret: ExecSecretDetector = (v) =>
  JSON.stringify(redactSecrets(v)) !== JSON.stringify(v);

/** Default buffered-output cap applied to the redacted combined stdout/stderr summary (64 KiB). */
export const DEFAULT_MAX_OUTPUT_BYTES = 65_536;

const TRUNCATION_MARKER = "\n…[truncated]";

export interface MakeExecEffectOptions {
  /** Cap (in UTF-8 bytes) for the redacted combined output written to `EffectResult.detail`. */
  readonly maxOutputBytes?: number;
  /** Secret detector for the credential-blind INPUT guard. Defaults to the `redactSecrets`-changed test. */
  readonly detectSecret?: ExecSecretDetector;
}

/**
 * The minimal shape the effect derives the exec command from. Kept structural (NOT a brain `ToolCall`
 * import) so substrate stays decoupled from any brain port — the composition root passes its real
 * ToolCall, which structurally satisfies this. `args.argv` is the program + arguments; `args.env` is the
 * placeholder/bundleRef environment (raw secrets are rejected by the credential-blind input guard).
 */
export interface ExecToolCall {
  readonly context: unknown;
  readonly args: {
    readonly argv: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  };
}

/** Truncate `s` to at most `maxBytes` UTF-8 bytes, appending a [truncated] marker if it was cut. */
function capUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  // Slice on a byte budget, then drop any partial trailing multi-byte char the slice may have split.
  const head = Buffer.from(s, "utf8").subarray(0, budget).toString("utf8").replace(/�+$/u, "");
  return head + TRUNCATION_MARKER;
}

/**
 * Build the exec-backed governed effect for a specific `(substrate, sandboxId)`. The returned function is
 * the pipeline's injected `effect` (it runs ONLY after the audit receipt is in hand — commit-before-effect).
 */
export function makeExecEffect(
  substrate: ExecCapableSandboxAdapter,
  sandboxId: string,
  opts: MakeExecEffectOptions = {},
): (toolCall: ExecToolCall) => Promise<EffectResult> {
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const detectSecret = opts.detectSecret ?? defaultDetectSecret;

  return async (toolCall: ExecToolCall): Promise<EffectResult> => {
    try {
      const env = toolCall.args?.env;

      // (1) CREDENTIAL-BLIND INPUT — reject a raw secret in any env VALUE BEFORE calling execSandbox.
      // Fail-closed: a detector that throws is treated as "secret present" (deny), never let through.
      if (env !== undefined) {
        for (const value of Object.values(env)) {
          let flagged: boolean;
          try {
            flagged = detectSecret(value);
          } catch {
            flagged = true;
          }
          if (flagged) {
            return {
              ok: false,
              detail:
                "credential-blind: raw secret in exec env — use a bundleRef/placeholder, not a literal",
            };
          }
        }
      }

      const spec: ExecCommandSpec = {
        argv: toolCall.args.argv,
        ...(env !== undefined ? { env } : {}),
        ...(toolCall.args.timeoutMs !== undefined ? { timeoutMs: toolCall.args.timeoutMs } : {}),
      };

      const result = await substrate.execSandbox(toolCall.context, sandboxId, spec);

      // (Fail-closed) a failed exec is NEVER a fabricated exit 0.
      if (!result.ok) {
        return { ok: false, detail: result.reason };
      }

      // (2) CREDENTIAL-BLIND OUTPUT — redact stdout AND stderr BEFORE they go anywhere.
      const redactedStdout = redactSecrets(result.stdout);
      const redactedStderr = redactSecrets(result.stderr);
      const truncationNote = result.truncated ? " (substrate-truncated)" : "";
      const body =
        redactedStderr.length > 0
          ? `${redactedStdout}\n--- stderr ---\n${redactedStderr}`
          : redactedStdout;

      // (3) OUTPUT CAP — cap the redacted summary to maxOutputBytes (header counts toward the cap).
      const header = `exit=${result.exitCode}${truncationNote}\n`;
      const detail = capUtf8(`${header}${body}`, maxOutputBytes);

      return { ok: true, detail };
    } catch {
      // The effect must never throw across the pipeline boundary — fail closed.
      return { ok: false, detail: "exec effect error (fail-closed)" };
    }
  };
}
