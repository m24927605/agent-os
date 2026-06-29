# Adopting Agent OS

How to start using Agent OS, by where you're starting from. Pick the row that fits you.

| You are… | Path | Status |
|---|---|---|
| **Not using any AI agent yet** — you want a complete, turnkey thing | [A · Turnkey](#a--turnkey-no-agent-yet) | Not yet one-click; closest path below |
| **Already using Hermes** (Desktop/TUI) — or any MCP-capable agent | [B · Connect an existing agent](#b--connect-an-existing-agent-mcp) | **Hermes Desktop: verified** |
| **Using a different agent framework** and want to embed Agent OS as a library | [C · Embed as a library](#c--embed-as-a-library) | Source/tarball today (no npm yet) |

> **The one idea that makes B and most of C the same:** Agent OS exposes its governed tools as a
> **standard MCP server**. Any MCP-capable host (Hermes, Claude Desktop, Cursor, your own client) can
> point at it. The governance lives in the server — see the [Safety contract](#safety-contract) below.

---

## A · Turnkey (no agent yet)

**Honest status:** there is **no single one-click executable yet**. The experience surface today is
**Hermes Desktop** (Path B), and a fully bundled turnkey app (a default brain + a provisioned sandbox +
the kernel, in one runnable) is still in progress — parts of it are deployment-gated (zero-credential
sandbox provisioning, an operator-unforgeable trust root). Tracked in
[`docs/slices/adoption`](./slices/adoption/INDEX.md) (ADO-A1).

**Closest thing you can run today:**

```bash
pnpm install
pnpm run example:personal   # a governed intent flows end to end, in-memory
```

Then connect a real brain via **Path B**. Background: [Agent OS in 5 Minutes](./concepts.md) ·
[Personal Quickstart](./personal-quickstart.md).

---

## B · Connect an existing agent (MCP)

Your agent keeps being the brain; Agent OS becomes the governed layer every tool call passes through.
You add **one MCP server entry** to your agent's config.

### Prerequisites

```bash
pnpm install
pnpm run build     # compiles the MCP server bin your agent will spawn (must exist)
```

Optional — point at your infrastructure (all **non-secret**; the installer's helpers throw on any
secret-shaped value, so a credential can never land in the config):

```bash
export AGENTOS_OPENSHELL_ENDPOINT=127.0.0.1:17670
export AGENTOS_OPENSHELL_MTLS="$HOME/.config/openshell/gateways/openshell/mtls"
export AGENTOS_KERNEL_INGEST_ENDPOINT=127.0.0.1:50051   # your kernel (the Go kernel binds 127.0.0.1:7777 by default)
```

### Hermes Desktop — **verified** (`pnpm run e2e:live-desktop-hermes`)

```bash
bash scripts/install-hermes-desktop.sh
```

- **At a terminal (TTY):** it delegates to `hermes mcp add` — answer “Enable all tools?” once.
- **Headless / no `hermes` CLI:** it prints the complete, credential-blind `config.yaml` body and the
  target path (`~/.hermes/config.yaml`); paste it under `mcp_servers`. Hermes auto-discovers it.

The body it writes (run the script to get **your** absolute paths — this is the authoritative source,
don't hand-edit it to diverge):

```yaml
mcp_servers:
  agentos-exec:
    command: node
    args:
      - <AGENT_OS_DIR>/dist/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js
    env:
      AGENTOS_OPENSHELL_ENDPOINT: "127.0.0.1:17670"
      AGENTOS_OPENSHELL_MTLS: "<HOME>/.config/openshell/gateways/openshell/mtls"
      AGENTOS_KERNEL_INGEST_ENDPOINT: "127.0.0.1:50051"
```

Then: Hermes `tools/list` discovers Agent OS's governed tools (incl. `exec.run`); every call routes
through the single governed edge → real OpenShell exec → the WORM evidence chain. Verify the whole
loop: `pnpm run e2e:live-desktop-hermes`.

### Any other MCP host — **example, unverified**

Claude Desktop, Cursor, a custom MCP client, Hermes **TUI** — the mechanism is identical (spawn the same
bin over stdio). These are **documented examples we have not yet verified end to end**; treat the
plumbing as untested (the *safety* still holds — see the [Safety contract](#safety-contract)). Add to
that host's MCP-servers config:

```jsonc
// generic MCP host config (shape varies by host) — UNTESTED EXAMPLE
{
  "command": "node",
  "args": ["<AGENT_OS_DIR>/dist/runtime/mcp/server-bin.js"],
  "env": { "AGENTOS_OPENSHELL_ENDPOINT": "127.0.0.1:17670", "AGENTOS_KERNEL_INGEST_ENDPOINT": "127.0.0.1:50051" }
}
```

Minimum assumptions: **stdio** transport · Node on PATH · quote paths containing spaces · the env above.

> **Vendor-neutral entry:** the governed MCP server is exposed at `dist/runtime/mcp/server-bin.js` (bin
> `agent-os-mcp`) — a host-agnostic entry, so a non-Hermes host doesn't point at a `hermes`-named path.
> (The Hermes Desktop installer above still uses its own historical path internally; same server.)

### Host support matrix

| Host | Config | Transport | Launch | Status |
|---|---|---|---|---|
| **Hermes Desktop** | `~/.hermes/config.yaml` → `mcp_servers` | stdio | `hermes mcp add` or direct-write | ✅ **verified** (`e2e:live-desktop-hermes`) |
| Hermes TUI | TBD (likely same `config.yaml`) | stdio | TBD | ⚠️ unverified |
| Claude Desktop / Cursor / custom MCP client | host-specific | stdio | `node …/exec-mcp-server-bin.js` | ⚠️ example, unverified |

---

## C · Embed as a library

For building your **own** surface with a different/custom brain, embed Agent OS as a library and route
every effect through `runGovernedToolCall`. Start here:

- [Composition Root Guide](./sdk/composition-root-guide.md) — from “cloned the repo” to “a governed
  surface running in my process.”
- [Build a Tool Family](./sdk/build-a-tool-family.md) — author and expose your own tools (use the
  **Developer** surface, `createDeveloperKit` from `agent-os/developer`).

**Honest status:** Agent OS is **not published to npm yet**. Today you consume it from source — clone +
`pnpm run build`, then depend on it via a **tarball (`pnpm pack`) or a pnpm workspace**. Import the
factories from their **subpaths** (`createPersonalShell` from `agent-os/personal`, `createDeveloperKit`
from `agent-os/developer`), not the package root. A frictionless `npm install agent-os` is planned —
tracked in [`docs/slices/publishable-package`](./slices/publishable-package/INDEX.md).

---

## Safety contract

The four invariants are enforced **server-side**, by the governed MCP server — so they hold for **any**
MCP host, because a host only *calls* the server and cannot bypass `runGovernedToolCall`:

- **Deny by default** — unknown / malformed / errored calls are refused.
- **Credential-blind** — the host and agent only ever see a placeholder; the real secret is resolved at
  the network egress, never in the agent or the config or any log.
- **Commit before effect** — the tamper-evident record is sealed before the effect runs.
- **Attester ≠ actor** — a separate process signs the evidence chain.
- **Approval** — tools that require it are gated server-side; with no approver, they are `denied@approval`.

“**Unverified**” for a non-Hermes host means **we haven't tested that host's config/discovery plumbing
yet** — it does **not** mean the safety is weaker. The governance is the server's, not the host's.

### Config hygiene

- Never put a real token/secret in the MCP config (YAML/JSON), shell history, logs, or screenshots — the
  examples above are all non-secret (a bin path + `host:port` endpoints + an mTLS directory path). The
  real credential boundary is a sandbox provisioned with zero credentials and no egress.
- `chmod 600 ~/.hermes/config.yaml` is reasonable.
- Missing build / missing endpoint / malformed config → fail closed (a clear error), never a silent
  fallback to ungoverned.

---

## Troubleshooting

- **`install-hermes-desktop: FAIL — built bin missing`** → run `pnpm run build` first.
- **`hermes mcp list` shows nothing after a headless run** → the no-TTY path can't answer the
  “Enable all tools?” prompt; use the printed `config.yaml` direct-write instead.
- **Name collision** → `hermes mcp remove agentos-exec` then re-add.
- **Paths with spaces** → quote the `args` path.
- **macOS / Linux / Windows** → paths and the Hermes config location differ; use your platform's
  `~/.hermes` (or `$HERMES_HOME`) location.
- **Running from a source checkout vs an installed package** → the bin path points into the built
  `dist/` of your checkout; rebuild after pulling.
- **Uninstall / rollback** → `hermes mcp remove agentos-exec` (or delete the `mcp_servers` entry).
