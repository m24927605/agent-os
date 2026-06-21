/**
 * Personal `approval` module — public surface (the depth-1 barrel siblings import through).
 *
 * Slice P2R-R7-S4: ApprovalInbox — the explicit-approve gate that is the SOLE effect entry into the
 * P2-I governed pipeline (design invariant 2). Downstream (S6 launcher) consumes `ApprovalInbox`,
 * `MAX_PENDING`, and the outcome types from here, never the module internals (dependency-cruiser
 * `not-to-internal`).
 */
export { ApprovalInbox, MAX_PENDING } from "./inbox.js";
export type { DecideOutcome, SubmitOutcome } from "./inbox.js";
