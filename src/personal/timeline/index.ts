/**
 * Personal `timeline` module — public surface (the depth-1 barrel siblings import through).
 *
 * Slice P2R-R7-S5: read-only plain-language projection of the WORM audit chain (design invariant 3).
 * The launcher view (S6) consumes `buildTaskTimeline` + the `TimelineEvent` shape from here, never
 * the module internals (dependency-cruiser `not-to-internal`).
 */
export type { BuildTimelineOptions, TimelineEvent } from "./timeline.js";
export { buildTaskTimeline } from "./timeline.js";
