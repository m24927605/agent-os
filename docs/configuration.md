# Environment & Configuration Reference

> The authoritative, code-derived list of every runtime switch Agent OS reads. Without setting
> these, the system stays in its safe default state — **deny-by-default**: unset / blank / malformed
> almost always resolves to the *off* / *deny-all* path.

This document is the reference for **what each switch gates, its accepted values, its default, and
what happens when it is unset, blank, or invalid**. It does **not** teach you how to stand up a
surface — for that, read the [Composition Root Guide](./sdk/composition-root-guide.md). For the
config-file onboarding flow (`agentos setup --init` / `setup --explain` / `agentos doctor`) and the
config **compiler** (`agentos config render` / `config check`), see the
[config file section](#agent-osconfigjson-the-onboarding-config-file) below.

## How to read this reference

Agent OS is **deny-by-default and fail-closed** (`AGENTS.md` is the operating contract). That shapes
every default in this table:

- **Boolean master switches** (`AGENTOS_ACTION_LIVE`, `AGENTOS_ADVERTISE_ACTIONS`,
  `AGENTOS_ADVERTISE_BROWSER`) are ON **only** when the value is *exactly* the string `"true"` or
  `"1"`. Anything else — unset, blank, `"false"`, `"TRUE"`, `"yes"`, even `"true "` with a trailing
  space — resolves to **off**.
  (`src/runtime/brain/adapters/hermes/action-guard.ts:148`, `:155`;
  `src/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.ts:333`, `:342`, `:363`.)
- **Allowlists** (egress hosts, host-write roots, test accounts, pre-auth tool names) are
  comma-separated; each entry is trimmed and blanks are dropped. Unset / blank / whitespace-only
  resolves to an **empty list ⇒ deny-all**.
- **Conditional config blocks** (SpendGuard, AGT) distinguish *absent* (the legitimate "off" state)
  from *present-but-malformed* (a misconfiguration). Absent ⇒ silently off. Present-but-incomplete
  ⇒ **throws at startup** — it never silently degrades to a no-governance fallback
  (`src/runtime/spendguard/config-root.ts:16`, `:124`, `:144`).
- **Credential-blind:** none of the switches below is a credential, *except* the explicitly-flagged
  token-carrying vars used only by the gated live demo scripts. Never put a secret in a config file,
  a log, or a committed env file.

> **Package status (honest):** `agent-os` is currently an **in-repo / private package** — an
> external `npm install agent-os` does **not** resolve yet. Every example below assumes you are
> running inside a clone of the repo (`git clone … && pnpm install`) and invoking the repo's own
> `pnpm run …` scripts.

> **`verify` vs. live scripts.** The universal gate is `pnpm run verify`
> (`package.json:58` — typecheck, lint, build, test, proto/dep/secret checks). **None of the
> switches in this document are required by `pnpm run verify`** — it passes with a completely empty
> environment. Vars marked **🔴 live-script only** below are read *only* by an opt-in
> `pnpm run e2e:live-*` script (or by a `*.live.test.ts` that those scripts run); they are never part
> of the `verify` gate.

---

## 1. Action & Browser capability switches

These govern whether the runtime will **advertise** real-world capabilities to the brain and whether
it will actually **act**. They are the heaviest-posture switches in the system; all are off by
default.

| Variable | What it gates | Accepted values | Default | Unset / blank / invalid |
|----------|---------------|-----------------|---------|--------------------------|
| `AGENTOS_ADVERTISE_ACTIONS` | Whether the action family (e.g. `gmail.send`, file delete) is **advertised + governed** to the brain at all. Off ⇒ the bin is byte-identical to a no-action build (no manifests/bindings/descriptors/allow rules; an action `tools/call` is denied at authorize). | `"true"` or `"1"` (exactly) | **off** | off (deny-by-default) — `src/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.ts:330`–`:344` |
| `AGENTOS_ADVERTISE_BROWSER` | Whether the browser family (`browser.navigate/read/click/type`) is **advertised + governed**. Described in code as the heaviest security posture in the system. Off ⇒ byte-identical no-browser build. | `"true"` or `"1"` (exactly) | **off** | off (deny-by-default) — `:353`–`:365` |
| `AGENTOS_ACTION_LIVE` | The **master switch** for the action *guard*: even when an action is advertised, the real connector is **deny-all** until this is on. It is the WHETHER gate (the test-account allowlist is the ON-WHOSE-ACCOUNT gate). | `"true"` or `"1"` (exactly) | **off** | off ⇒ every live send refused before the inner connector is ever called — `src/runtime/brain/adapters/hermes/action-guard.ts:143`, `:148`–`:157`, `:111`–`:114` |
| `AGENTOS_ACTION_TEST_ACCOUNT` | The **non-secret** comma-separated allowlist of acting accounts the guard may send *as* (main-account protection). The resolved acting account must be a member, or the call is refused. | comma-separated account strings (e.g. `throwaway@example.test`) | **empty ⇒ deny-all** | empty list ⇒ deny-all (an unresolvable or non-listed account is refused) — `action-guard.ts:145`, `:161`–`:171`, `:128`–`:134` |
| `AGENTOS_APPROVE_PREAUTH` | The personal **pre-authorization** allowlist: a comma-separated list of tool **names** that are auto-approved at the approval gate. A proposed call is pre-authorized iff its tool name is in the set. | comma-separated tool names | **empty ⇒ deny-all** at approval | empty set ⇒ every approval-requiring tool is denied@approval (fail-closed) — `exec-mcp-server-bin.ts:282`, `:289`–`:301` |
| `AGENTOS_EGRESS_ALLOW` | The per-sandbox **egress host allowlist** — the single source folded into both the substrate `SandboxSpec.egressAllow` (primary network enforcement) and the in-repo PDP egress gate. A network call's host must match a list entry. **Host-only entries** (no port). | comma-separated hostnames (e.g. `api.allowed.example`, `gmail.googleapis.com`) | **empty ⇒ deny-all egress** | empty list ⇒ deny-all egress (fail-closed) — `exec-mcp-server-bin.ts:309`, `:316`–`:322`, `:374`–`:375` |
| `AGENTOS_HOST_WRITE_ALLOW` | The per-sandbox **host-write-target allowlist** — comma-separated **absolute roots** a sandbox may write to on the host. Single source folded into both `SandboxSpec.hostWriteAllow` and the PDP host-write gate. | comma-separated absolute path roots | **empty ⇒ deny-all host-write** | empty list ⇒ deny-all host-write (fail-closed) — `exec-mcp-server-bin.ts:385`, `:392`–`:398`, `:408`–`:409` |

### Optional credential-placeholder *key* names (not credentials)

These name an env **key** whose *value* OpenShell's SecretResolver resolves at the sandbox egress
boundary. Agent OS only ever assembles a placeholder in OpenShell's `openshell:resolve:env:<KEY>`
grammar — **never a literal secret**. The key itself is non-secret config.

| Variable | What it gates | Accepted values | Default | Unset / blank / invalid |
|----------|---------------|-----------------|---------|--------------------------|
| `AGENTOS_NET_FETCH_AUTH_KEY` | The env-key name under which `net.fetch` (curl) is given an auth credential placeholder. | an UPPERCASE C-identifier (`[A-Z][A-Z0-9_]*`) that is **not** a curl/proxy-control name | **unset ⇒ no auth env** (`net.fetch` is unauthenticated-to-allowlisted) | unset / blank / unsafe shape / a forbidden curl-control name (`HTTP_PROXY`, `HOME`, `CURL_CA_BUNDLE`, …) ⇒ `{}` (no auth env) — `src/runtime/brain/adapters/hermes/exec-seed-tools.ts:475`, `:484`–`:494`, `:509`–`:515` |
| `AGENTOS_GIT_PUSH_AUTH_KEY` | Same mechanism, for the `git.push` binding's auth placeholder. | same as above (reuses the same validator) | **unset ⇒ no auth env** | same fail-closed behavior — `exec-seed-tools.ts:667`, `:711` |

---

## 2. OpenShell substrate & kernel endpoints

Read by the `agentos-exec` MCP bin, the `agentos doctor`/`setup` CLI, and the
`install-hermes-desktop.sh` installer. All are **non-secret** host:port / path values.

> ⚠️ **Default skew (confirmed, flagged):** the *kernel* default differs between consumers. The CLI
> doctor defaults `AGENTOS_KERNEL_INGEST_ENDPOINT` to `127.0.0.1:50051`
> (`src/cli/doctor.ts:41`, `:200`), while `scripts/install-hermes-desktop.sh` defaults the same var
> to `127.0.0.1:50543` (`scripts/install-hermes-desktop.sh:41`). Set it explicitly to avoid relying
> on either default.

| Variable | What it gates | Accepted values | Default | Unset / blank / invalid |
|----------|---------------|-----------------|---------|--------------------------|
| `AGENTOS_OPENSHELL_ENDPOINT` | The OpenShell gateway the doctor TCP-probes and the installer threads into the bin's registration env. | `host:port` | `127.0.0.1:17670` (doctor `src/cli/doctor.ts:40`, `:188`; installer `install-hermes-desktop.sh:39`) | falls back to the default `127.0.0.1:17670` |
| `AGENTOS_OPENSHELL_MTLS` | Path to the OpenShell mTLS material directory. | absolute directory path | installer default `$HOME/.config/openshell/gateways/openshell/mtls` (`install-hermes-desktop.sh:40`) | installer falls back to that default; written into the bin env by `setup` from `openshell.mtlsDir` (`src/cli/setup.ts:393`) |
| `AGENTOS_OPENSHELL_IMAGE` | The sandbox container image OpenShell launches. | image reference string | **empty** (`install-hermes-desktop.sh:43`) — only injected into the bin env when non-empty (`:67`) | empty ⇒ key omitted from the bin env |
| `AGENTOS_KERNEL_INGEST_ENDPOINT` | The partitioned WORM kernel ingest endpoint (commit-before-effect needs it). Doctor TCP-probes it. | `host:port` | **see skew note above** | falls back to the consumer's default (doctor `50051`, installer `50543`) |
| `AGENTOS_MCP_NAME` | The MCP server name Hermes uses to namespace discovered tools. | string | `agentos-exec` (`install-hermes-desktop.sh:38`) | falls back to `agentos-exec` |
| `AGENTOS_EXEC_MCP_FAKE` | **Test/dev only.** Selects the in-memory `FakeSandboxAdapter` instead of the real OpenShell substrate, for the in-repo subprocess test. | `"1"` (exactly) selects fake mode | **unset ⇒ REAL substrate** | anything other than `"1"` ⇒ real OpenShell substrate — `exec-mcp-server-bin.ts:1114` |

---

## 3. SpendGuard (budget governance) — `SPENDGUARD_*`

Read by `src/runtime/spendguard/config-root.ts` (`integrationsFromEnv`). This block is
**all-or-nothing and fail-closed**: if `SPENDGUARD_UDS_PATH` is *absent*, SpendGuard is simply off
and the surface uses the in-memory budget gate. If `SPENDGUARD_UDS_PATH` is *present* but any
required topology field is missing/blank, startup **throws** rather than silently reverting to a
no-governance gate (the worst failure mode being an operator who *believes* SpendGuard is enforcing
when it is not). All values are non-secret identifiers.

| Variable | What it gates | Accepted values | Default | Unset / blank / invalid |
|----------|---------------|-----------------|---------|--------------------------|
| `SPENDGUARD_UDS_PATH` | The SpendGuard sidecar Unix-domain-socket path. **Presence is the enable switch.** | absolute UDS path | **absent ⇒ SpendGuard off** (in-memory gate) | **absent** ⇒ off (legitimate). **present-but-blank** ⇒ **throws** at startup — `config-root.ts:41`, `:119`–`:127` |
| `SPENDGUARD_BUDGET_ID` | Budget topology: the budget id in the reserve/commit claim. | non-blank id | required when UDS set | missing/blank while UDS set ⇒ **throws** (names the missing key) — `config-root.ts:42`, `:131`–`:147` |
| `SPENDGUARD_UNIT_ID` | Budget topology: the unit id. | non-blank id | required when UDS set | same fail-closed throw |
| `SPENDGUARD_WINDOW_INSTANCE_ID` | Budget topology: the window-instance id. | non-blank id | required when UDS set | same fail-closed throw |
| `SPENDGUARD_TENANT_ASSERTION` | Optional tenant assertion threaded into the decision transport. | id string | **optional** (omitted when blank) | absent/blank ⇒ omitted (no assertion) — `config-root.ts:45`, `:149`–`:153` |

---

## 4. AGT advisory (`AGT_*`)

The AGT (advisory governance) secondary is also **all-or-nothing, fail-closed**, mirroring
SpendGuard. `AGT_UDS_PATH` presence is the enable switch; an absent key means no AGT round-trip
(byte-identical to off). The repo bundles **no AGT engine** — the live path needs the operator's own
Python sidecar (see `pnpm run e2e:live-agt`). Read by `src/runtime/spendguard/config-root.ts` and
the per-call deadline by `src/runtime/agt/decision-transport.ts`.

| Variable | What it gates | Accepted values | Default | Unset / blank / invalid |
|----------|---------------|-----------------|---------|--------------------------|
| `AGT_UDS_PATH` | The AGT sidecar UDS. **Presence is the enable switch.** | absolute UDS path | **absent ⇒ AGT advisory off** | **absent** ⇒ off. **present-but-blank** ⇒ **throws** — `config-root.ts:48`, `:196`–`:202` |
| `AGT_SCOPE` | Which tools get a governance projection / AGT consult: `effectful` (effectful tools only) or `all`. | `"effectful"` \| `"all"` | `"effectful"` (when unset) | unset ⇒ defaults to `effectful`; an explicit **invalid** value ⇒ **throws** — `config-root.ts:49`, `:52`–`:53`, `:204`–`:210` |
| `AGT_TIMEOUT_MS` | Per-call AGT deadline override. On expiry the call **rejects** (fail-closed). Hard-capped at **2000 ms**. | positive integer (ms) | `750` ms when unset; clamped to `2000` ms max | unset ⇒ `750`; explicit **non-numeric / non-positive** ⇒ **throws** in `config-root`; the transport-level resolver independently clamps to ≤ 2000 ms — `config-root.ts:50`, `:213`–`:221`; `decision-transport.ts:37`, `:40`, `:65`–`:76` |

---

## 5. Verifier (Developer surface)

| Variable | What it gates | Accepted values | Default | Unset / blank / invalid |
|----------|---------------|-----------------|---------|--------------------------|
| `AGENTOS_VERIFIER_BIN` | Path to the released `agentos-verifier` binary the CLI / Developer bootstrap invokes (lets a test point at a fixture without mutating `PATH`). | path to an executable | `agentos-verifier` (resolved on `PATH`) | unset ⇒ `agentos-verifier` (must be on `PATH`) — `src/cli/main.ts:120`; `src/developer/bootstrap.ts:386` |

> See [Verifier release & checksum verification](./sdk/verifier-release.md) for how the binary is
> built and pinned, and [tool-manifest-authoring.md](./sdk/tool-manifest-authoring.md) for authoring
> the manifests it checks.

---

## 6. Live-demo / live-test gates (🔴 not part of `pnpm run verify`)

Every variable in this section is consumed **only** by an opt-in `pnpm run e2e:live-*` script or a
`*.live.test.ts` those scripts drive. They never affect `pnpm run verify`. Each script
**skips/blocks by default** (printing `SKIP` / `BLOCKED` and exiting cleanly) when its gate is unset
— it never fakes green.

| Variable | Gated script(s) | Role | Behavior when unset |
|----------|-----------------|------|---------------------|
| `AGENTOS_LIVE_OPENSHELL` | `e2e:live-substrate-exec`, `e2e:live-nemoclaw`, `e2e:live-hermes`, `e2e:live-capstone`, `e2e:live-exec-mcp[-stdio]`, `e2e:live-hermes-desktop` | `=1` opts in to REAL OpenShell sandbox side effects | absent ⇒ `BLOCKED`, exit 0 — `scripts/e2e-live-substrate-exec.sh:29`–`:30` |
| `AGENTOS_LIVE_DESKTOP_HERMES` | `e2e:live-desktop-hermes`, `e2e:live-capstone`, `e2e:live-exec-mcp[-stdio]`, `e2e:live-hermes-desktop` | `=1` opts in to a REAL Hermes brain (real model credits) | absent ⇒ `BLOCKED`, exit 0 — `scripts/e2e-live-desktop-hermes.sh:38`–`:39` |
| `AGENTOS_LIVE_HERMES_SANDBOX` | `e2e:live-hermes` | names the operator's existing Hermes sandbox | absent ⇒ `BLOCKED` — `scripts/e2e-live-hermes.sh:31`–`:32` |
| `AGENTOS_LIVE_HERMES_MODEL_ARGS` | `e2e:live-hermes-desktop` | optional provider/model args appended to the one-shot command (`"--provider <p> --model <m>"`) | absent ⇒ default model args — `scripts/e2e-live-hermes-desktop.sh:29` |
| `AGENTOS_LIVE_AGT` | `e2e:live-agt` | `=1` + `AGT_UDS_PATH` opts in to a real AGT sidecar drive | absent ⇒ `SKIPPED`, exit 0 — `scripts/e2e-live-agt.sh:21`–`:22` |
| `AGENTOS_LIVE_SPENDGUARD_UDS` | `spendguard-live-e2e.mjs` (run by `e2e:live-spendguard`) | UDS path the live probe connects to | absent ⇒ defaults to `/var/run/spendguard/adapter.sock` — `scripts/spendguard-live-e2e.mjs:13` |
| `AGENTOS_LIVE_VERIFIER`, `AGENTOS_LIVE_KERNEL`, `AGENTOS_LIVE_KERNEL_ENDPOINT`, `AGENTOS_LIVE_KERNEL_CHAIN`, `AGENTOS_LIVE_KERNEL_VERIFY`, `AGENTOS_LIVE_PARTITION_DIR`, `AGENTOS_LIVE_PARTITION_VERIFY` | `e2e:live-developer`, `e2e:live-kernel[-verify]`, `e2e:live-restore`, `e2e:live-enterprise`, `e2e:live-partition-verify` | These are **set by the scripts themselves** after they stand up a local kernel/verifier; the gated `*.e2e.test.ts` reads them to know it may run against a live endpoint. Under `pnpm run verify` (no env) those tests **skip**. | unset ⇒ the gated test skips — `scripts/e2e-live-enterprise.sh:57`–`:59`; `src/audit/ingest/live-kernel.e2e.test.ts:7`, `:24`–`:25` |
| `AGENTOS_LIVE_NUDGE` | `exec-mcp-stdio.live.test.ts` | optional override naming a specific advertised tool to nudge the live brain toward | absent ⇒ a built-in default tool — `src/runtime/brain/adapters/hermes/mcp/exec-mcp-stdio.live.test.ts:253`–`:256` |
| `AGENTOS_LIVE_OPENSHELL_SANDBOX` | `grpc-transport.live.test.ts`, `nemoclaw.live.test.ts` | optional name of a pre-existing sandbox; not needed because those tests self-create | absent ⇒ test self-creates a sandbox — `src/runtime/openshell/grpc-transport.live.test.ts:12` |

### Token-carrying live vars (secrets — never commit, never log)

These carry a real credential **only** in the operator's own shell during a live demo. They are
resolved at the egress boundary and never echoed: every diagnostic is assembled from fixed string
literals, so the token value never appears in output
(`src/runtime/brain/adapters/hermes/action-live-gmail-runner.ts:391`–`:420`).

| Variable | Gated script | Role | Behavior when unset |
|----------|--------------|------|---------------------|
| `AGENTOS_GMAIL_OAUTH_KEY` | `e2e:live-gmail` | **Directly holds** the Gmail OAuth token (one-level). | absent/blank ⇒ `SKIP`, no send — `scripts/e2e-live-gmail.sh:26`; `action-seed-tools.ts:113` |
| `AGENTOS_GCAL_OAUTH_KEY` | (Google Calendar action transport) | The env **key** the GCal connector resolves the token from at egress. | absent ⇒ unauthenticated path — `src/runtime/brain/adapters/hermes/action-seed-tools.ts:223`, `:269` |
| `AGENTOS_OPENSHELL_TOKEN` | (live OpenShell auth, exercised by `*.live.test.ts`) | Bearer credential for a real OpenShell gateway; treated as a secret canary the installer must not echo. | absent ⇒ no token (live path unauthenticated/blocked) — `src/runtime/brain/adapters/hermes/hermes-desktop-install.test.ts:104` |
| `AGENTOS_BROWSER_TYPE_KEY` | `exec-mcp-server-bin.act5e.test.ts` | The env **key** naming a credential placeholder for the `browser.type` value (live browser path). | absent ⇒ no placeholder — `src/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.act5e.test.ts:448` |

> The credential-blind doctor explicitly proves it never echoes a secret-shaped value placed in
> `AGENTOS_SECRET_TOKEN` (`src/cli/doctor.test.ts:224`) and the ACP harness uses
> `AGENTOS_TEST_PARENT_SECRET` to assert no parent-process secret leaks to a child
> (`src/runtime/brain/adapters/hermes/acp-stdio.test.ts:261`). These two are **test canaries**, not
> operator switches — do not set them.

---

## Worked example: the two live demos

Both demos build the repo's `dist` and drive the **full governed pipeline** (screen → authorize →
cost → commit-before-effect → effect → boundary). They are opt-in and skip cleanly when their gate
is unset. The token rides **only your shell's env** — never the repo, logs, or any artifact.

### A. Governed Gmail self-send — `pnpm run e2e:live-gmail`

All four gate vars must be set and non-blank, or the script prints `SKIP (env not set)` and exits 0
(`scripts/e2e-live-gmail.sh:24`–`:30`):

```bash
# In your own shell only — these are NOT committed and NOT echoed by the tooling.
export AGENTOS_ACTION_LIVE=true                       # master switch ON
export AGENTOS_ACTION_TEST_ACCOUNT=throwaway@example.test  # the ONLY account it may send AS
export AGENTOS_GMAIL_OAUTH_KEY='<your-oauth-token>'   # holds the token directly; resolved at egress
export AGENTOS_EGRESS_ALLOW=gmail.googleapis.com      # the host the send may reach

pnpm run e2e:live-gmail
# exit 0 ONLY on a REAL send; non-zero prints the precise "NOT SENT — …" reason.
```

> Note: `AGENTOS_ADVERTISE_ACTIONS` governs advertising the action family to an *autonomous brain*;
> the `e2e:live-gmail` driver drives the action path directly and gates on the four vars above.

### B. Governed real-browser navigate + read — `pnpm run e2e:live-browser`

Gated solely on the egress allowlist; unset ⇒ `SKIP` and exit 0
(`scripts/e2e-live-browser.sh:24`–`:27`). The driver additionally fail-closes (exit 2) if Playwright
is not installed — `verify` never installs it (zero-new-dep):

```bash
# One-time: install the browser library yourself (NOT a verify-time dependency).
pnpm add -D playwright && pnpm exec playwright install chromium

export AGENTOS_EGRESS_ALLOW=example.com   # the only host the browser may reach
pnpm run e2e:live-browser
# exit 0 = navigate+read executed under governance; 2 = browser lib missing (nothing run); 1 = pipeline deny.
```

---

## `agent-os.config.json` (the onboarding config file)

`agentos setup` reads a declarative, **non-secret-only** `agent-os.config.json` (default
`./agent-os.config.json`, or `--config <path>`), validates it with a `zod` **`.strict()`** schema,
and from it builds the `agentos-exec` registration env (the `AGENTOS_*` / `SPENDGUARD_*` / `AGT_*`
keys above) before delegating the Hermes MCP registration. `setup` starts **no** services — it
generates + applies + verifies; `agentos doctor` checks that the services are actually up
(`src/cli/setup.ts:5`–`:48`).

The schema is **fail-closed**: malformed JSON, an unknown key (`.strict()` at every level), a wrong
type, a missing required section, or a partial `spendguard` block all **throw** — never a
half-config (`src/cli/setup.ts:153`–`:165`).

| Section | Field | Required? | Type | Maps to env |
|---------|-------|-----------|------|-------------|
| `openshell` | `endpoint` | yes | string `host:port` | `AGENTOS_OPENSHELL_ENDPOINT` |
| `openshell` | `mtlsDir` | yes | string path | `AGENTOS_OPENSHELL_MTLS` |
| `openshell` | `image` | yes | string | `AGENTOS_OPENSHELL_IMAGE` |
| `openshell.networkPolicy` | `egressAllow` | optional | string[] of plain-DNS hosts | `AGENTOS_EGRESS_ALLOW` (comma-joined) — the hosts `net.fetch` may reach; **read by the egress auto-provisioner** at sandbox creation |
| `openshell.networkPolicy` | `gitEgressAllow` | optional | string[] of plain-DNS hosts | `AGENTOS_GIT_EGRESS_ALLOW` (comma-joined) — the SEPARATE, higher-bar `git.push` allowlist |
| `kernel` | `ingestEndpoint` | yes | string `host:port` | `AGENTOS_KERNEL_INGEST_ENDPOINT` |
| `spendguard` | `udsPath`, `budgetId`, `unitId`, `windowInstanceId` | **whole section optional; all four required if present** | strings | `SPENDGUARD_UDS_PATH` / `_BUDGET_ID` / `_UNIT_ID` / `_WINDOW_INSTANCE_ID` |
| `agt` | `udsPath` | required when `agt` present | string | `AGT_UDS_PATH` |
| `agt` | `scope` | optional | `"effectful"` \| `"all"` | `AGT_SCOPE` (only written when present) |
| `agt` | `timeoutMs` | optional | positive integer | `AGT_TIMEOUT_MS` (only written when present) |
| `secrets` | `{ logicalName: ENV_KEY_NAME }` | optional | record of UPPER_SNAKE env-key **names** | none (a non-secret registry of the env KEYS whose VALUES you export; a pasted secret value is rejected value-free) |
| `nemoclaw` | `gateway` | required when `nemoclaw` present | string | none (compiled to the NemoClaw onboard stanza by `config render`) |
| `nemoclaw` | `image` | optional | string | none |

(Generated source of truth: run `agentos setup --explain` for the live field → env map. Schema: `src/cli/setup.ts` `AgentOsConfigSchema`; env mapping: `buildRegistrationEnv`.)

Example `agent-os.config.json` (non-secret only — no credentials ever):

```json
{
  "openshell": {
    "endpoint": "127.0.0.1:17670",
    "mtlsDir": "/home/you/.config/openshell/gateways/openshell/mtls",
    "image": "ghcr.io/example/openshell-sandbox:latest",
    "networkPolicy": {
      "egressAllow": ["api.github.com", "pypi.org"],
      "gitEgressAllow": ["github.com"]
    }
  },
  "kernel": {
    "ingestEndpoint": "127.0.0.1:50051"
  },
  "spendguard": {
    "udsPath": "/var/run/spendguard/adapter.sock",
    "budgetId": "team-budget",
    "unitId": "usd",
    "windowInstanceId": "2026-Q2"
  },
  "agt": {
    "udsPath": "/var/run/agt/decision.sock",
    "scope": "effectful",
    "timeoutMs": 750
  },
  "secrets": {
    "gmail": "AGENTOS_GMAIL_OAUTH_KEY",
    "netFetch": "AGENTOS_NET_FETCH_AUTH_KEY"
  },
  "nemoclaw": {
    "gateway": "benevolent-buck"
  }
}
```

Omitting `spendguard`, `agt`, `openshell.networkPolicy`, `secrets`, and/or `nemoclaw` is valid —
those features simply stay off (the deny-by-default "off" state, not an error). `secrets` holds env-key
**names** only; the VALUES are exported in your shell and resolved only at the egress boundary.

---

## Onboarding & compiler commands (the `agentos` CLI)

```bash
# 1) scaffold a starter config (no blank page; --profile personal|enterprise|developer; refuse-if-exists)
agentos setup --init --profile personal

# 2) see what each config field compiles to, value-free (the field → native-output map)
agentos setup --explain

# 3) compile + apply (hermes mcp add on a TTY, else prints the block) + run doctor
agentos setup

# 4) preflight: per-system PASS/FAIL/SKIP; --secrets adds a value-blind SET/UNSET inventory of secret env KEYs
agentos doctor
agentos doctor --secrets
```

### `agentos config render` / `agentos config check` — the config compiler

`config render` compiles the one declarative `agent-os.config.json` into each system's **native** artifact
under `.agentos/rendered/` plus a `.agentos/render.lock.json` (sha256 of the source + each target). Each
artifact is **applied through that system's own CLI** (printed alongside it); Agent OS never auto-rewrites a
foreign system's file. `config check` re-renders in memory and **fails closed (non-zero) on any drift** from
the lock — the GitOps / CI staleness guard.

```bash
agentos config render        # writes .agentos/rendered/* + .agentos/render.lock.json, prints each apply command
agentos config check         # exit 0 IN-SYNC, non-zero on DRIFT (run in CI after committing the lock)
agentos config render --config ./prod.config.json   # any path
```

Rendered targets (each section renders **only when present**):

| Target | From | Apply via |
|--------|------|-----------|
| `registration.env` | the non-secret `AGENTOS_*` / `SPENDGUARD_*` / `AGT_*` env | exported into Hermes's `mcp_servers.env` by `agentos setup` (reference) |
| `openshell-egress.json` | `openshell.networkPolicy` | **reference** — the egress auto-provisioner applies it **merge-aware** at sandbox creation (canonical); a manual `openshell policy set` REPLACES the whole policy, so prefer the auto-provisioner |
| `nemoclaw-onboard.txt` | `nemoclaw` | `nemohermes onboard --gateway <name>` (NemoClaw has no auto-provisioner, so this is the real apply path) |

**Credential-blind:** every rendered artifact and the lock hold **non-secret bytes only** — `config render`
screens each artifact and **fails closed, value-free**, if a secret-shaped value slipped into a free-form
field. Secrets live in env (resolved at egress), never in a rendered file.

**GitOps:** `.agentos/rendered/` is git-ignored by default (personal). Enterprise operators commit
`.agentos/render.lock.json` and gate drift in CI with `agentos config check`.

---

## See also

- [Composition Root Guide](./sdk/composition-root-guide.md) — how to stand up and run a surface.
- [Tool Manifest Authoring](./sdk/tool-manifest-authoring.md) — authoring the manifests the verifier
  checks.
- [Verifier Release](./sdk/verifier-release.md) — building and pinning `agentos-verifier`.
