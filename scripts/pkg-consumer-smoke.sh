#!/usr/bin/env bash
# PKG2 — third-party consumer resolution proof. Builds, packs for real, installs the tarball into a
# throwaway project OUTSIDE the repo, and from there: (a) imports every public subpath via the package
# name, (b) runs a governed call end to end (mirrors examples/surfaces/run-personal-shell.ts) and asserts
# `executed`, (c) asserts an internal deep path is BLOCKED by `exports`. A publish-time gate (needs
# registry/cache for the tarball's deps; not in the 14-leg `verify`). Self-cleaning.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

pnpm run build >/dev/null 2>&1 || { echo "pkg-consumer-smoke: FAIL — build" >&2; exit 1; }
TGZ="$(npm pack --silent 2>/dev/null | tail -1)"
[ -n "$TGZ" ] && [ -f "$ROOT/$TGZ" ] || { echo "pkg-consumer-smoke: FAIL — npm pack produced no tarball" >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$ROOT/$TGZ"' EXIT

cd "$TMP"
printf '%s\n' '{"name":"agent-os-consumer-smoke","version":"0.0.0","type":"module","private":true}' > package.json
if ! npm i --prefer-offline --no-audit --no-fund "$ROOT/$TGZ" >install.log 2>&1; then
  echo "pkg-consumer-smoke: FAIL — installing the tarball failed (needs registry/cache for deps)" >&2
  tail -6 install.log >&2; exit 1
fi

cat > consumer.mjs <<'JS'
// Runs from the throwaway project: `import "agent-os/<subpath>"` resolves via the package `exports`.
const SUBPATHS = [
  "agent-os", "agent-os/personal", "agent-os/developer", "agent-os/enterprise",
  "agent-os/tools", "agent-os/sdk/templates", "agent-os/runtime/spendguard", "agent-os/policy/adapters/agt",
];
const FACTORY = {
  "agent-os/personal": "createPersonalShell",
  "agent-os/developer": "createDeveloperKit",
  "agent-os/enterprise": "createEnterpriseFleet",
  "agent-os/runtime/spendguard": "integrationsFromEnv",
  "agent-os/policy/adapters/agt": "AgtSecondaryPolicy",
};
let fail = 0;
const note = (m) => { console.error("  consumer: " + m); fail = 1; };

// (a) every public subpath resolves by package name + exposes its documented factory.
for (const s of SUBPATHS) {
  try {
    const m = await import(s);
    const f = FACTORY[s];
    if (f && typeof m[f] !== "function") note(`${s} resolved but missing ${f}`);
  } catch (e) { note(`${s} did NOT resolve: ${e.message}`); }
}

// (b) run a governed call end to end (mirror run-personal-shell.ts) -> "executed".
try {
  const { createPersonalShell, StructuredIntent } = await import("agent-os/personal");
  const shell = createPersonalShell({ allowToolInvoke: true });
  const ctx = StructuredIntent.shape.context.parse({
    actorId: "agent:smoke", tenantId: "t", projectId: "p", taskId: "task-smoke", requestId: "r",
  });
  const received = shell.receive("backup notes archive", ctx);
  if (received.status !== "intent") note(`expected intent, got ${received.status}`);
  else {
    const submitted = shell.previewAndSubmit(received.intent);
    if (submitted.status !== "pending") note(`expected pending, got ${submitted.status}`);
    else {
      const decided = await shell.approve(submitted.id);
      if (decided.status !== "executed") note(`expected executed, got ${decided.status}`);
      else console.log("  consumer: governed call -> executed");
    }
  }
} catch (e) { note(`personal flow threw: ${e.message}`); }

// (c) negative — an internal deep path must be BLOCKED by the exports allowlist.
try {
  await import("agent-os/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js");
  note("deep internal import was NOT blocked by exports");
} catch (e) {
  if (e?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") note(`deep import blocked with wrong error: ${e?.code} ${e?.message}`);
  else console.log("  consumer: internal deep path correctly blocked (ERR_PACKAGE_PATH_NOT_EXPORTED)");
}

if (fail) { console.error("pkg-consumer-smoke: FAIL"); process.exit(1); }
console.log("pkg-consumer-smoke: clean — 8 subpaths resolve, governed call executed, deep internal path blocked.");
JS

node consumer.mjs
