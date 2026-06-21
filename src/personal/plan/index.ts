/**
 * Personal `plan` module — public surface (the depth-1 barrel siblings import through).
 *
 * Slice P2R-R7-S3: plain-language PlanPreview projection of a StructuredIntent. The downstream
 * ApprovalInbox (S4) consumes `renderPlanPreview` + the `PlanPreview` shape from here, never the
 * module internals (dependency-cruiser `not-to-internal`).
 */
export type { PlanPreview, PlanPreviewDeps } from "./preview.js";
export { renderPlanPreview } from "./preview.js";
