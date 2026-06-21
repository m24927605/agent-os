/**
 * Personal `intent` module — public surface (the depth-1 barrel siblings import through).
 *
 * Slice P2R-R7-S1: text-first IntentGateway + StructuredIntent schema. Downstream Personal-surface
 * modules (plan preview S3, approval S4) consume the StructuredIntent shape and `receiveText`
 * outcome from here, never the module internals (dependency-cruiser `not-to-internal`).
 */
export type { ClarifyStep } from "./clarify.js";
export { CLARIFY_MAX_QUESTIONS, answerClarify, startClarify } from "./clarify.js";
export type { ReceiveDeps, ReceiveOutcome } from "./gateway.js";
export { receiveText } from "./gateway.js";
export { StructuredIntent } from "./schema.js";
