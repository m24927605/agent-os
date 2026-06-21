/**
 * Agent OS SDK — ToolManifest authoring template (SLICE-P2R-R9-S4).
 *
 * This module's SOLE responsibility is to provide a legal, author-copyable ToolManifest example and a
 * programmatic way to load it. It adds NO schema logic and performs NO I/O on the hot path — the
 * schema and its two consistency guardrails live in R3 (`src/tools`), consumed here ONLY via the SDK
 * author barrel (`../index.js`), exactly as a third-party author would consume it. Keeping the export
 * in lockstep with the on-disk `tool-manifest.example.json` (proven by `templates.test.ts`) means the
 * file an author copies, the file `agentos manifest lint` reads, and this programmatic export can
 * never drift apart.
 *
 * Dependency direction (low coupling; no cycle):
 *   templates/index.ts ──▶ ../index.js (SDK barrel: parseToolManifest, R3 contract)
 *   templates/index.ts ──▶ ./tool-manifest.example.json (same-module asset, inlined below)
 *
 * The canonical manifest is declared inline (not JSON-imported) so this barrel needs no JSON module
 * resolution and ships cleanly to `dist`; the on-disk JSON is the authoring/CLI artifact and the test
 * pins the two to be byte-equivalent.
 */
import { type ToolManifest, parseToolManifest } from "../index.js";

/**
 * The canonical, author-copyable ToolManifest example. A legal 9-field manifest that satisfies R3's
 * two consistency guardrails:
 *   - Guardrail A (sideEffect "none" => idempotent: true): N/A here (sideEffect is "write").
 *   - Guardrail B (sideEffect "destructive" => requiresApproval: true): N/A here (not destructive).
 *
 * `bundleRefOnly: true` declares that this tool references credentials by reference (a bundleRef such
 * as "github:PAT:prod"), never inline — the SDK is credential-blind by construction.
 */
export const exampleToolManifest: unknown = {
  name: "github-create-issue",
  version: "1.0.0",
  description: "Open a new issue in a GitHub repository the agent has been leased access to.",
  action: "github.issues.create",
  resourcePattern: "github:repo:acme/*",
  sideEffect: "write",
  idempotent: false,
  requiresApproval: false,
  bundleRefOnly: true,
};

/** Load the example as a validated `ToolManifest` (fail-closed via R3 `parseToolManifest`). */
export function loadExampleToolManifest(): ToolManifest {
  return parseToolManifest(exampleToolManifest);
}
