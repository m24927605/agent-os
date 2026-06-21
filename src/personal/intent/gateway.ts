/**
 * IntentGateway (text-first) — converge natural language + AgentContext into a StructuredIntent,
 * or deny / ask for clarification. Deny-by-default, deterministic (schema-driven, NOT an LLM).
 *
 * Design §2.1 / §3.3: the gateway is the zero-skill user's text input contract. Entry-redaction
 * runs FIRST (so a secret never reaches rawText / the parsed intent), then a deterministic parse
 * resolves an action + targets. Ambiguity is never guessed:
 *   - empty / unparseable text, or a malformed AgentContext → `denied`
 *   - parseable verb but a required field is absent → `needs-clarification` (lists the field;
 *     the clarify Q&A loop itself is S2, out of scope here)
 *   - otherwise → `intent`
 *
 * Low coupling (design §2.2): pure function + injected redactor. The default redactor is consumed
 * through the audit module's public barrel, never its internals.
 */
import { redactSecrets } from "../../audit/index.js";
import { type AgentContext, parseAgentContext } from "../../iam/ids.js";
import { type StructuredIntent, StructuredIntent as StructuredIntentSchema } from "./schema.js";

export type ReceiveOutcome =
  | { status: "intent"; intent: StructuredIntent }
  | { status: "needs-clarification"; missing: string[] }
  | { status: "denied"; reason: string };

export interface ReceiveDeps {
  /** Entry redactor. Defaults to the audit module's `redactSecrets` (consumed via its barrel). */
  redact?: (s: string) => string;
}

// A small, deterministic verb lexicon. This is intentionally NOT an LLM: RED tests must be
// reproducible and deny-by-default must be deterministic (design §5, capability gate G1 inactive).
// Unknown verbs fall through to `denied`, never a guessed action.
const KNOWN_ACTIONS = ["backup", "restore", "move", "copy", "delete", "share", "open"] as const;
const STOPWORDS = new Set([
  "my",
  "the",
  "a",
  "an",
  "to",
  "from",
  "into",
  "using",
  "with",
  "folder",
]);

function defaultRedact(s: string): string {
  return redactSecrets(s);
}

export function receiveText(
  text: string,
  ctx: AgentContext,
  deps: ReceiveDeps = {},
): ReceiveOutcome {
  const redact = deps.redact ?? defaultRedact;

  // 1) Entry-redaction FIRST — the raw secret must never reach parsing, rawText, or any return.
  const rawText = redact(text).trim();
  if (rawText.length === 0) {
    return { status: "denied", reason: "empty or unparseable text" };
  }

  // 2) Fail-closed identity: a malformed AgentContext is denied (never coerced).
  let context: AgentContext;
  try {
    context = parseAgentContext(ctx);
  } catch {
    return { status: "denied", reason: "invalid caller identity" };
  }

  // 3) Deterministic parse: resolve the verb, then the targets.
  const tokens = rawText.split(/\s+/).filter((t) => t.length > 0);
  const lower = tokens.map((t) => t.toLowerCase());
  const action = KNOWN_ACTIONS.find((a) => lower.includes(a));
  if (action === undefined) {
    return { status: "denied", reason: "no recognized action in text" };
  }

  const actionIdx = lower.indexOf(action);
  const targets = tokens
    .slice(actionIdx + 1)
    .filter((t) => !STOPWORDS.has(t.toLowerCase()))
    .filter((t) => /[A-Za-z0-9]/.test(t));

  if (targets.length === 0) {
    return { status: "needs-clarification", missing: ["targets"] };
  }

  // 4) Strict parse — fail-closed. Anything the schema rejects (incl. an unscrubbed secret shape
  //    in rawText) is denied rather than returned.
  const parsed = StructuredIntentSchema.safeParse({ action, targets, context, rawText });
  if (!parsed.success) {
    return { status: "denied", reason: "intent failed strict validation" };
  }
  return { status: "intent", intent: parsed.data };
}
