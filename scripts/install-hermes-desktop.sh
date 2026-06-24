#!/usr/bin/env bash
# install-hermes-desktop (SLICE-HDI1 / HDI1-FIX) — register Agent OS's governed exec MCP bin into a real
# Hermes Desktop user's `config.yaml` `mcp_servers` map.
#
# ⚠️ TWO PATHS — because a live run pinned that `hermes mcp add` is DISCOVERY-FIRST + INTERACTIVE: it
# spawns the server, lists its tools, and asks "Enable all N tools?". There is NO `--yes`/`--no-confirm`/
# `--force` flag (confirmed via `hermes mcp add --help`). With NO TTY the prompt CANCELS and nothing is
# persisted (`hermes mcp list` then shows "No MCP servers configured"). So:
#   • INTERACTIVE (a human at a TTY): delegate to `hermes mcp add` — Hermes owns the config.yaml format,
#     the user answers "Enable all" once, the entry persists. (Unchanged behavior.)
#   • HEADLESS / CI / non-TTY: there is no flag to bypass the prompt, so we ALWAYS print the complete,
#     credential-blind `config.yaml` body (rendered by the pure `renderHermesMcpServersConfigYaml`) + tell
#     the user exactly where to write it. Hermes auto-discovers `mcp_servers` from config.yaml with NO
#     enable-confirm (the EXEC4c-b ACP path proved this), so the direct-write is the headless install path.
#
# WHAT THIS DOES (the last mile for a real Hermes Desktop user):
#   1. Resolve the BUILT bin's ABSOLUTE path (dist/.../exec-mcp-server-bin.js). Missing -> instruct
#      `pnpm run build` and exit non-zero (the bin a real Hermes spawns must exist).
#   2. ALWAYS print the complete `config.yaml` body for the HEADLESS/CI direct-write path + the target
#      path ($HERMES_HOME/config.yaml or ~/.hermes/config.yaml).
#   3. If `hermes` is NOT on PATH -> CLEAN BLOCK (exit 0); the printed config.yaml body IS the install.
#   4. Otherwise, at a TTY, INTERACTIVE install: `hermes mcp remove agentos-exec` (tolerate failure) then
#      `hermes mcp add …` (a human answers the "Enable all tools?" prompt) then `hermes mcp list`.
#
# CREDENTIAL-BLIND: BOTH the `hermes mcp add` argv (`buildHermesMcpAddArgv`) AND the printed config.yaml
# body (`renderHermesMcpServersConfigYaml`) come from the repo's PURE, unit-tested helpers, which THROW on
# any secret-shaped env value — so a literal secret can NEVER be written into config.yaml. Only NON-secret
# inputs flow in: the bin path + OpenShell/kernel host:port endpoints + an mTLS DIR path (overridable via
# env; sane local defaults). The REAL credential boundary stays a sandbox provisioned with ZERO
# credentials + NO egress — this install just keeps secrets out of the file.
#
# It NEVER reads the user's Hermes secrets / `.env`; it only registers one mcp_servers entry.
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
    const { buildHermesMcpAddArgv, renderHermesMcpServersConfigYaml } = await import(process.env.AGENTOS_HELPER);
    const opts = {
      name: process.env.AGENTOS_NAME,
      binPath: process.env.AGENTOS_BIN,
      env: JSON.parse(process.env.AGENTOS_ENV_JSON),
    };
    // Credential-blind: BOTH builders THROW (non-zero exit) if any env value is secret-shaped — abort
    // BEFORE touching Hermes / printing anything (fail-closed; never persist or print a secret).
    const argv = buildHermesMcpAddArgv(opts);
    // The COMPLETE, standalone config.yaml body for the HEADLESS/CI direct-write path (top-level
    // `mcp_servers:` key) — the path that does NOT need the interactive "Enable all tools?" prompt.
    const configBody = renderHermesMcpServersConfigYaml(opts);
    process.stdout.write(JSON.stringify({ argv, configBody }));
  '
)"
HELPER_RC=$?
if [ "$HELPER_RC" != 0 ]; then
  echo "install-hermes-desktop: FAIL — refusing to install: the credential-blind guard rejected a secret-shaped endpoint value (a secret must NEVER be written into config.yaml). Provide ONLY non-secret host:port endpoints." >&2
  exit 1
fi

# Extract the argv (as a NUL-safe array) + the complete config.yaml body from the helper's JSON.
mapfile -t ADD_ARGV < <(printf '%s' "$HELPER_OUT" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    for (const a of JSON.parse(s).argv) process.stdout.write(a + "\n");
  });
')
CONFIG_BODY="$(printf '%s' "$HELPER_OUT" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ process.stdout.write(JSON.parse(s).configBody); });
')"

# Where Hermes reads its config root: HERMES_HOME if set, else ~/.hermes.
HERMES_HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
CONFIG_PATH="$HERMES_HOME_DIR/config.yaml"

# --- (2) ALWAYS print the HEADLESS/CI config.yaml direct-write path. ----------------------------------
# `hermes mcp add` is INTERACTIVE (asks "Enable all tools?" with no flag to bypass), so it cannot be
# driven headlessly. The complete config.yaml body below IS the headless install — Hermes auto-discovers
# mcp_servers from it with NO enable-confirm. On a FRESH config.yaml this is the whole file; for an EXISTING
# config.yaml, merge the `mcp_servers:` block into your file (do not clobber other top-level keys).
echo "install-hermes-desktop: HEADLESS/CI path — write this complete config.yaml to: $CONFIG_PATH"
echo "install-hermes-desktop: (Hermes auto-reloads config.yaml + auto-discovers mcp_servers; NO 'Enable all tools?' prompt on this path)"
echo "----------------------------------------------------------------"
printf '%s' "$CONFIG_BODY"
echo "----------------------------------------------------------------"

# --- (3) No `hermes` on PATH -> CLEAN BLOCK (exit 0); the printed config.yaml body above IS the install.
if ! command -v hermes >/dev/null 2>&1; then
  echo "install-hermes-desktop: BLOCKED — the desktop 'hermes' CLI is not on PATH; nothing to drive. Write the config.yaml body above to $CONFIG_PATH (it is the complete headless install)."
  exit 0
fi

# --- (4) At a TTY -> INTERACTIVE install via Hermes's own CLI (a human answers "Enable all tools?"). ---
# ⚠️ `hermes mcp add` is DISCOVERY-FIRST + INTERACTIVE (no `--yes`/`--no-confirm`/`--force`). With NO TTY
# it CANCELS and persists nothing — so we only run it when stdin is a terminal; otherwise the config.yaml
# body printed above is the headless install path.
if [ ! -t 0 ]; then
  echo "install-hermes-desktop: non-interactive shell (no TTY) — skipping 'hermes mcp add' (it would prompt 'Enable all tools?' and CANCEL headlessly). Use the config.yaml direct-write above."
  exit 0
fi

echo "install-hermes-desktop: registering '$NAME' into Hermes config.yaml via 'hermes mcp add' (Hermes owns the YAML; it will ask 'Enable all tools?' — answer yes to persist)..."
echo "install-hermes-desktop: bin = $BUILT_BIN"
echo "install-hermes-desktop: endpoints = OPENSHELL=$OPENSHELL_ENDPOINT KERNEL=$KERNEL_ENDPOINT MTLS=$OPENSHELL_MTLS (NON-secret)"

# Idempotent: remove a prior entry first (tolerate failure — first run has nothing to remove).
hermes mcp remove "$NAME" >/dev/null 2>&1 || true

# Upsert: `hermes mcp add …` with the pure-helper argv (--args LAST; --env KEY=VALUE; non-secret only).
if ! hermes "${ADD_ARGV[@]}"; then
  echo "install-hermes-desktop: FAIL — 'hermes mcp add' exited non-zero (see Hermes's output above). If it CANCELLED at the 'Enable all tools?' prompt, use the config.yaml direct-write printed above." >&2
  exit 1
fi

# Verify the entry landed.
echo "install-hermes-desktop: verifying via 'hermes mcp list'..."
hermes mcp list || true

echo "install-hermes-desktop: ok — '$NAME' registered. Hermes Desktop auto-reloads config.yaml; the bin will be spawned the next time Hermes discovers MCP servers. Remove later with: hermes mcp remove $NAME"
exit 0
