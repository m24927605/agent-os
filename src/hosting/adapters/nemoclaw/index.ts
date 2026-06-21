/**
 * NemoClaw hosting adapter — vendor barrel. Re-exports ONLY the adapter class and its injected
 * transport seam. Deliberately NOT re-exported from the hosting package barrel (src/hosting/index.ts):
 * a vendor adapter is wired by the composition root, never surfaced as part of the neutral port API.
 */
export { type CommandSink, NemoClawAgentHosting } from "./adapter.js";
