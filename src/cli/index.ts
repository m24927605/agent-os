/**
 * CLI module public surface — the single legal cross-module entry point for the `agentos` CLI
 * (SLICE-P2R-R9-S3). Re-exports the testable entrypoint `runCli`. The actual process bootstrap
 * (argv slicing + `process.exit`) lives in the bin wrapper, not here.
 */
export { runCli } from "./main.js";
