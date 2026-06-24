#!/usr/bin/env bash
# install-hermes-desktop (SLICE-HDI1) — register Agent OS's governed exec MCP bin into a real Hermes
# Desktop user's `~/.hermes/config.yaml` `mcp_servers` map, by DELEGATING to Hermes's own `hermes mcp add`
# CLI (Hermes owns the config.yaml format; we never hand-edit YAML, only touch the `agentos-exec` key).
#
# WHAT THIS DOES (the last mile for a real Hermes Desktop user):
#   1. Resolve the BUILT bin's ABSOLUTE path (dist/.../exec-mcp-server-bin.js). Missing -> instruct
#      `pnpm run build` and exit non-zero (the bin a real Hermes spawns must exist).
#   2. If `hermes` is NOT on PATH -> CLEAN BLOCK (exit 0) + print the MANUAL config.yaml mcp_servers
#      snippet so the user can paste it themselves. (No Hermes = nothing to drive; never a hard failure.)
#   3. Otherwise IDEMPOTENT install: `hermes mcp remove agentos-exec` (tolerate failure — first run has
#      nothing to remove) then `hermes mcp add agentos-exec --command node --env <endpoints> --args <bin>`
#      then `hermes mcp list` to verify. NON-DESTRUCTIVE: only the `agentos-exec` key is touched; Hermes
#      itself performs the edit.
#
# CREDENTIAL-BLIND: the argv is built by the repo's PURE `buildHermesMcpAddArgv` (single source of truth,
# unit-tested), which THROWS on any secret-shaped env value — so a literal secret can NEVER be written
# into config.yaml. Only NON-secret inputs flow in: the bin path + OpenShell/kernel host:port endpoints +
# an mTLS DIR path (overridable via env/args; sane local defaults). The REAL credential boundary stays a
# sandbox provisioned with ZERO credentials + NO egress — this install just keeps secrets out of the file.
#
# It NEVER reads the user's Hermes secrets / `.env`; it only asks Hermes to upsert one mcp_servers entry.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- Non-secret endpoints (env-overridable; sane local defaults matching the bin's own fallbacks). -----
NAME="${AGENTOS_MCP_NAME:-agentos-exec}"
OPENSHELL_ENDPOINT="${AGENTOS_OPENSHELL_ENDPOINT:-127.0.0.1:17670}"
OPENSHELL_MTLS="${AGENTOS_OPENSHELL_MTLS:-$HOME/.config/openshell/gateways/openshell/mtls}"
KERNEL_ENDPOINT="${AGENTOS_KERNEL_INGEST_ENDPOINT:-127.0.0.1:50543}"
# OpenShell image is optional (the bin has a pinned default); only thread it when explicitly provided.
OPENSHELL_IMAGE="${AGENTOS_OPENSHELL_IMAGE:-}"

# --- (1) Resolve the BUILT bin's absolute path. ------------------------------------------------------
BUILT_BIN="$ROOT/dist/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js"
HELPER="$ROOT/dist/runtime/brain/adapters/hermes/hermes-desktop-install.js"
if [ ! -f "$BUILT_BIN" ] || [ ! -f "$HELPER" ]; then
  echo "install-hermes-desktop: FAIL — the built bin/helper is missing (expected $BUILT_BIN). Run \`pnpm run build\` first (it compiles the bin a real Hermes spawns + the install helper)." >&2
  exit 1
fi

# --- Build the env list (NON-secret only) the bin runs under, as a JSON object for the pure helper. ---
# We pass values through the SAME pure builder used by the unit tests + the live test (single source of
# truth) so the argv shape + the credential-blind guard are identical everywhere.
ENV_JSON="$(
  AGENTOS_OPENSHELL_ENDPOINT="$OPENSHELL_ENDPOINT" \
  AGENTOS_OPENSHELL_MTLS="$OPENSHELL_MTLS" \
  AGENTOS_KERNEL_INGEST_ENDPOINT="$KERNEL_ENDPOINT" \
  AGENTOS_OPENSHELL_IMAGE="$OPENSHELL_IMAGE" \
  node -e '
    const env = {
      AGENTOS_OPENSHELL_ENDPOINT: process.env.AGENTOS_OPENSHELL_ENDPOINT,
      AGENTOS_OPENSHELL_MTLS: process.env.AGENTOS_OPENSHELL_MTLS,
      AGENTOS_KERNEL_INGEST_ENDPOINT: process.env.AGENTOS_KERNEL_INGEST_ENDPOINT,
    };
    if (process.env.AGENTOS_OPENSHELL_IMAGE) env.AGENTOS_OPENSHELL_IMAGE = process.env.AGENTOS_OPENSHELL_IMAGE;
    process.stdout.write(JSON.stringify(env));
  '
)"

# --- Render the install argv + the manual snippet via the PURE helper (credential-blind THROWS abort). -
# Run the helper with the resolved inputs. The helper THROWS on a secret-shaped env value -> the node
# process exits non-zero and we abort BEFORE touching Hermes (fail-closed; never persist a secret).
HELPER_OUT="$(
  AGENTOS_HELPER="$HELPER" \
  AGENTOS_NAME="$NAME" \
  AGENTOS_BIN="$BUILT_BIN" \
  AGENTOS_ENV_JSON="$ENV_JSON" \
  node --input-type=module -e '
    const { buildHermesMcpAddArgv, renderHermesConfigYamlSnippet } = await import(process.env.AGENTOS_HELPER);
    const opts = {
      name: process.env.AGENTOS_NAME,
      binPath: process.env.AGENTOS_BIN,
      env: JSON.parse(process.env.AGENTOS_ENV_JSON),
    };
    // Credential-blind: this THROWS (non-zero exit) if any env value is secret-shaped — abort before Hermes.
    const argv = buildHermesMcpAddArgv(opts);
    const snippet = renderHermesConfigYamlSnippet(opts);
    process.stdout.write(JSON.stringify({ argv, snippet }));
  '
)"
HELPER_RC=$?
if [ "$HELPER_RC" != 0 ]; then
  echo "install-hermes-desktop: FAIL — refusing to install: the credential-blind guard rejected a secret-shaped endpoint value (a secret must NEVER be written into config.yaml). Provide ONLY non-secret host:port endpoints." >&2
  exit 1
fi

# Extract the argv (as a NUL-safe array) + the manual snippet from the helper's JSON.
mapfile -t ADD_ARGV < <(printf '%s' "$HELPER_OUT" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    for (const a of JSON.parse(s).argv) process.stdout.write(a + "\n");
  });
')
MANUAL_SNIPPET="$(printf '%s' "$HELPER_OUT" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ process.stdout.write(JSON.parse(s).snippet); });
')"

# --- (2) No `hermes` on PATH -> CLEAN BLOCK (exit 0) + print the manual snippet. ----------------------
if ! command -v hermes >/dev/null 2>&1; then
  echo "install-hermes-desktop: BLOCKED — the desktop 'hermes' CLI is not on PATH; nothing to install."
  echo "install-hermes-desktop: to register manually, add this to your ~/.hermes/config.yaml (Hermes auto-reloads it):"
  echo "----------------------------------------------------------------"
  printf '%s' "$MANUAL_SNIPPET"
  echo "----------------------------------------------------------------"
  exit 0
fi

# --- (3) Idempotent, non-destructive install via Hermes's own CLI. ------------------------------------
echo "install-hermes-desktop: registering '$NAME' into Hermes config.yaml via 'hermes mcp add' (delegating; Hermes owns the YAML)..."
echo "install-hermes-desktop: bin = $BUILT_BIN"
echo "install-hermes-desktop: endpoints = OPENSHELL=$OPENSHELL_ENDPOINT KERNEL=$KERNEL_ENDPOINT MTLS=$OPENSHELL_MTLS (NON-secret)"

# Idempotent: remove a prior entry first (tolerate failure — first run has nothing to remove).
hermes mcp remove "$NAME" >/dev/null 2>&1 || true

# Upsert: `hermes mcp add …` with the pure-helper argv (--args LAST; --env KEY=VALUE; non-secret only).
if ! hermes "${ADD_ARGV[@]}"; then
  echo "install-hermes-desktop: FAIL — 'hermes mcp add' exited non-zero (see Hermes's output above)." >&2
  exit 1
fi

# Verify the entry landed.
echo "install-hermes-desktop: verifying via 'hermes mcp list'..."
hermes mcp list || true

echo "install-hermes-desktop: ok — '$NAME' registered. Hermes Desktop auto-reloads config.yaml; the bin will be spawned the next time Hermes discovers MCP servers. Remove later with: hermes mcp remove $NAME"
exit 0
