/**
 * Tools module public surface — the agent-agnostic, vendor-neutral ToolManifest contract (R3) plus
 * the registry + authorize layers. Cross-module consumers (e.g. the SDK author barrel `src/sdk`) MUST
 * import ONLY from here, never deep into a module-internal file (enforced by dep-cruiser
 * `not-to-internal`). This barrel is the single legal entry point for the `tools` module.
 *
 * Added by SLICE-P2R-R9-S2 (spec §8 option B): R3-S1 shipped `parseToolManifest` only via the ROOT
 * `src/index.ts` and never built this module barrel; the SDK barrel has no legal path to R3 without it.
 */
export * from "./manifest.js";
export * from "./capability-containment.js";
export * from "./registry.js";
export * from "./authorize.js";
