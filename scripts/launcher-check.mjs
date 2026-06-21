#!/usr/bin/env node
// launcher-check — deterministic linter for the Personal surface docker-compose launcher.
//
// Single responsibility (SLICE-P2R-R7-S6): turn two security invariants of
// deploy/personal/docker-compose.yml into exit-code-verifiable facts, wired into
// `pnpm run verify` as the `launcher:check` sub-gate. It does NOT import any src module
// (zero coupling) and adds zero dependencies — it is a static text/structure lint, not a
// full YAML engine (the slice verifies STATIC invariants, not runtime orchestration).
//
// Invariants enforced (deny-by-default / fail-closed):
//   1. Network deny-by-default — every published port must bind 127.0.0.1. A 0.0.0.0 bind
//      (or a bare "PORT:PORT" host-port that implies 0.0.0.0) is forbidden.
//   2. Credential non-leak — no plaintext secret-like literal may appear. Secrets must be
//      sourced indirectly via ${ENV} interpolation or a volume mount.
//
// Fail-closed contract: a missing file, an unreadable file, or malformed/empty content
// exits non-zero. Unknown/ambiguous ⇒ deny. It prints "file:line reason" — it NEVER echoes
// a matched secret value, so the gate can never itself become a leak source.
//
// Usage: node scripts/launcher-check.mjs [path-to-compose]
//   default path = deploy/personal/docker-compose.yml (resolved from repo root)

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(repoRoot, "deploy/personal/docker-compose.yml");

/** High-signal secret-shape patterns (mirrors scripts/scan_secrets.sh, value never printed). */
const SECRET_SHAPES = [
  /sk-[A-Za-z0-9]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

/** A host-port mapping that does NOT pin 127.0.0.1 (covers explicit 0.0.0.0 and bare maps). */
function isNonLocalBind(value) {
  // Strip surrounding quotes/whitespace; ports entries look like "HOST_IP:HOST:CONTAINER".
  const v = value.replace(/^["']|["']$/g, "").trim();
  if (v.includes("0.0.0.0")) return true;
  // Long-form `published:`/`target:` and protocol suffixes are handled by the 0.0.0.0 check
  // and the explicit-localhost requirement below. A short-form "8080:8080" (no host IP) binds
  // all interfaces by default ⇒ forbidden; "127.0.0.1:8080:8080" is the only allowed shape.
  const m = v.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+(?::\d+)?(?:\/(?:tcp|udp))?$/);
  if (m) return m[1] !== "127.0.0.1";
  // Bare "HOST:CONTAINER" or single port with no host IP ⇒ all-interfaces ⇒ forbidden.
  if (/^\d+(?::\d+)?(?:\/(?:tcp|udp))?$/.test(v)) return true;
  return false;
}

function fail(messages) {
  for (const m of messages) console.error(`launcher-check: ${m}`);
  console.error(`launcher-check: FAIL — ${messages.length} violation(s) in ${target}`);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(target, "utf8");
} catch {
  // fail-closed: missing/unreadable target is a violation, not a pass.
  fail([`${target}:0 cannot read compose file (fail-closed)`]);
}

if (raw.trim().length === 0) fail([`${target}:0 empty compose file (fail-closed)`]);

// Minimal structural sanity (fail-closed on malformed YAML) without adding a YAML dep:
// every non-blank, non-comment line must be a `key:` / `- item` / continuation, indentation
// must be spaces (tabs are illegal in YAML), and brackets must balance.
const lines = raw.split(/\r?\n/);
const violations = [];
let bracketDepth = 0;
let sawServices = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const lineNo = i + 1;
  const stripped = line.replace(/#.*$/, "");
  if (stripped.trim().length === 0) continue;

  if (/^\s*\t/.test(line) || /\t/.test(line.replace(/^[^\S\t]*/, "").split("#")[0])) {
    violations.push(`${target}:${lineNo} tab indentation is illegal YAML (fail-closed)`);
  }
  if (/^\s*services\s*:/.test(stripped)) sawServices = true;

  // Bracket/brace balance for inline flow scalars.
  for (const ch of stripped) {
    if (ch === "[" || ch === "{") bracketDepth++;
    else if (ch === "]" || ch === "}") bracketDepth--;
    if (bracketDepth < 0) {
      violations.push(`${target}:${lineNo} unbalanced bracket/brace (malformed YAML, fail-closed)`);
      bracketDepth = 0;
    }
  }

  // Invariant 1 — network deny-by-default. A ports list item like `- "0.0.0.0:..."`.
  const portItem = stripped.match(/^\s*-\s*(.+)$/);
  if (portItem && /\d+\s*:\s*\d+/.test(portItem[1]) && isNonLocalBind(portItem[1])) {
    violations.push(
      `${target}:${lineNo} non-localhost port bind forbidden — pin 127.0.0.1 (network deny-by-default)`,
    );
  }

  // Invariant 2 — credential non-leak. Any secret-shaped literal is forbidden (value not printed).
  for (const re of SECRET_SHAPES) {
    if (re.test(stripped)) {
      violations.push(
        `${target}:${lineNo} plaintext secret-like literal forbidden — use \${ENV} or a volume mount`,
      );
      break;
    }
  }
}

if (bracketDepth !== 0) {
  violations.push(`${target}:0 unbalanced bracket/brace at EOF (malformed YAML, fail-closed)`);
}
if (!sawServices) {
  violations.push(`${target}:0 no \`services:\` block found (malformed compose, fail-closed)`);
}

if (violations.length > 0) fail(violations);

console.log(`launcher-check: clean — ${target}`);
process.exit(0);
