/**
 * Voice input adapter — vendor-neutral SpeechToTextPort + the default inactive capability gate.
 *
 * Design §2.1 / §5 (capability gate G2): voice is NOT a new pipeline. It is an input adapter that
 * sits in FRONT of the IntentGateway — transcribe(audio)→text, then the result flows through the
 * exact same text path (`receiveText`). The pipeline (clarify/plan/approval/timeline) is unchanged.
 *
 * This slice ships ONLY the port + a fail-closed `InactiveSpeechToText` default: calling it always
 * denies (deny-by-default), it never silently pretends to transcribe. Enabling real voice requires
 * a STT vendor adapter that passes a contract test (landed under `runtime/<vendor>` or injected) —
 * deliberately out of scope here, so this core file carries NO vendor name.
 *
 * Low coupling (design §2.2): the STT implementation is an injected port; `voiceToIntent` consumes
 * the `intent` module only through its public barrel (`receiveText` / `ReceiveOutcome`) and `iam`
 * via `ids.ts` (the dependency-cruiser interim exception). Dependencies point inward, acyclic.
 */
import type { AgentContext } from "../../iam/ids.js";
import { type ReceiveOutcome, receiveText } from "../intent/index.js";

/** Discriminated transcription result — success carries text, failure carries a reason. */
export type TranscribeResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Vendor-neutral speech-to-text port. A concrete adapter (Whisper, a cloud STT, …) is injected at
 * runtime; the core only ever sees this interface — no vendor name reaches this module.
 */
export interface SpeechToTextPort {
  transcribe(audio: Uint8Array): Promise<TranscribeResult>;
}

/** The fail-closed reason returned by the inactive gate; asserted by the contract test. */
export const VOICE_INACTIVE_REASON = "voice capability inactive";

/**
 * Default STT implementation: the inactive capability gate (G2). It ALWAYS denies — never
 * inspects the audio, never returns text. Voice stays off until a real adapter is injected.
 */
export const InactiveSpeechToText: SpeechToTextPort = {
  transcribe: async (): Promise<TranscribeResult> => ({
    ok: false,
    reason: VOICE_INACTIVE_REASON,
  }),
};

/**
 * Voice input adapter: transcribe the audio, then — on success — hand the transcript to the SAME
 * text path the zero-skill user already uses (`receiveText`). Voice adds no pipeline behaviour.
 *
 *   - transcribe failure (incl. the inactive gate) → pass the deny through, never guess an intent.
 *   - transcribe success → `receiveText(text, ctx)`, identical to typing that text.
 *
 * Note: the transcript flows through `receiveText`, whose entry-redaction (design §3.3) screens
 * secrets — so voice never bypasses the text path's redaction.
 */
export async function voiceToIntent(
  stt: SpeechToTextPort,
  audio: Uint8Array,
  ctx: AgentContext,
): Promise<ReceiveOutcome> {
  const result = await stt.transcribe(audio);
  if (!result.ok) {
    return { status: "denied", reason: result.reason };
  }
  return receiveText(result.text, ctx);
}
