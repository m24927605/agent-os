/**
 * Personal `voice` module — public surface (the depth-1 barrel siblings import through).
 *
 * Slice P2R-R7-S7: vendor-neutral SpeechToTextPort + an inactive capability gate (G2). Voice is an
 * input adapter in front of the IntentGateway — transcribe→text then reuse the text path — so the
 * pipeline is unchanged. This slice ships only the port + fail-closed default; no real STT vendor.
 */
export type { SpeechToTextPort, TranscribeResult } from "./port.js";
export { InactiveSpeechToText, VOICE_INACTIVE_REASON, voiceToIntent } from "./port.js";
