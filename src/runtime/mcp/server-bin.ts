#!/usr/bin/env node
/**
 * Agent OS — vendor-neutral governed MCP server entry (ADO-B3). Bin: `agent-os-mcp`.
 *
 * Any MCP host (Hermes, Claude Desktop, Cursor, a custom client) spawns this over stdio:
 *   `node <agent-os>/dist/runtime/mcp/server-bin.js`  (or `agent-os-mcp` once installed).
 *
 * It delegates to the host-agnostic exec MCP server (which lives under the hermes adapter dir for
 * historical reasons — an internal detail; this file is in the same `runtime` module, so the deep import
 * is intra-module and the published path carries no vendor name). EVERY `tools/call` still routes through
 * the single governed edge `runGovernedToolCall` — the host controls stdin/stdout/lifecycle but cannot
 * touch the governance (fail-closed). This file is only ever a process entry point (never imported), so it
 * calls `main` directly; importing the delegate does NOT re-run it (its entry guard sees a different entry).
 */
import { main } from "../brain/adapters/hermes/mcp/exec-mcp-server-bin.js";

main().catch((e) => {
  process.stderr.write(`agent-os-mcp: fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
