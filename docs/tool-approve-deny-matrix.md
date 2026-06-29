# Tool approve/deny test matrix (REAL)

A deterministic, **real** approve/deny test flow for the governed exec MCP tools — the ~16 tools a Hermes
brain discovers and calls. It drives the **single governed edge** directly
(`createExecMcpServer(buildBinDeps(false, …)).handle({tools/call})`) with **no LLM and no model credits**,
against a **real OpenShell sandbox** and a **fresh real Go kernel WORM partition** (`tenant-bin`). For each
tool it proves an **approve** path (real effect runs, exit 0, committed before the effect) and the matrix
as a whole proves every **deny mode**, then reads the kernel chain back to confirm it is append-only,
hash-chained, and credential-blind.

- Spec: `src/runtime/brain/adapters/hermes/mcp/exec-mcp-matrix.live.test.ts`
- Runner: `scripts/e2e-live-tool-matrix.sh` (`pnpm run e2e:live-tool-matrix`)

## Run it

```bash
# Needs a running OpenShell gateway (openshell CLI on PATH). The runner builds + spawns its OWN fresh Go
# kernel, sources ~/.env for your action creds, and runs the COMPLETE real flow. No Hermes, no model credits.
AGENTOS_LIVE_OPENSHELL=1 pnpm run e2e:live-tool-matrix
```

It runs three real stages, **nothing faked**: (1) the in-sandbox + network matrix below; (2) a **real**
Gmail send (`e2e:live-gmail` — `gmail.send` → real Google API egress); (3) a **real** Chromium browser
drive (`e2e:live-browser` — `browser.navigate` + `browser.read` on a real page). Stages 2–3 cleanly
**skip** when their creds / playwright are absent — never a fake stand-in.

Missing `AGENTOS_LIVE_OPENSHELL=1` or `openshell` ⇒ a **clean block** (exit 0). Not part of `pnpm run
verify` (it spawns a kernel + drives real external effects); the matrix spec is `describe.skip` without the
gates so the offline suite stays green.

**Verified live (2026-06-29):** matrix 7/7 green (real exec/git/net.fetch + every deny mode + readback);
real Chromium navigate+read EXECUTED on a real page (read back real content); the real Gmail send made a
real Google egress call (real OAuth) and was governed-**denied** by the account allowlist — align the OAuth
token's account with `AGENTOS_ACTION_TEST_ACCOUNT` for a green send (a real config gate, not a fake).

## Driving mechanism — `composition-root-real`

`buildBinDeps(false, opts)` is the single composition root that wires the **real** OpenShell exec-capable
substrate (from `AGENTOS_OPENSHELL_ENDPOINT` + `…_MTLS` + a **pinned** sandbox image) **and** the **real**
shared-kernel WORM appender (`createRpcAppendTransport` @ `AGENTOS_KERNEL_INGEST_ENDPOINT`, partition
`tenant-bin`). Its opts expose exactly the per-scenario policy seams: `costGate`, `approve`, `egressAllow`,
`ingestTransport`, `extraAllowRules`. We wrap the deps in `createExecMcpServer` and call `.handle()` once
per `(tool × scenario)` — the exact production code path, with full control and zero non-determinism.

An `onEffect` hook tracks effect firing: **approve** ⇒ `isError:false` + `onEffect` fired once; **deny** ⇒
`isError:true` + `"DENIED: <stage> — <reason>"` + `onEffect` **never** fired (commit-before-effect).

## The matrix

**APPROVE — real OpenShell exec, exit 0, committed before effect** (one shared sandbox, seeded in order):

| tool | args | proves |
|---|---|---|
| `exec.pwd` `exec.echo` `exec.ls` `exec.run` | benign | read + arbitrary-argv exec |
| `exec.write_file` → `exec.cat` `exec.head` `exec.wc` `exec.grep` | seed `seed.txt`, then read it | write (content via stdin, never argv) + reads |
| `net.fetch` | `https://example.com/` (`egressAllow: ["example.com"]`) | a **real** network fetch from inside the sandbox |
| `exec.run git init/config` → `git.status` `git.add` `git.commit` `git.diff` `git.log` | a real in-sandbox git work-tree | git read + staged mutation + local commit (never a push) |

**DENY — each mode, with no effect run:**

| mode | tool | how | expected |
|---|---|---|---|
| `denied@screen` | `exec.echo` | a secret-**shaped** synthetic canary (`sk-` + 20 synthetic chars, built at runtime, account-invalid) | `DENIED: screen — credential-blind…` |
| `denied@cost` | `exec.echo` | inject `new NullCostGate()` (denies at reserve) | `DENIED: cost …` |
| `denied@policy` (egress) | `net.fetch` | `egressAllow: []` (deny-all) | `DENIED: policy … egress-allowlist` — host **not** leaked |
| `denied@approval` | `git.push` | `approve` returns `{status:"denied"}` | `DENIED: approval …` |
| `denied@policy` (deny-by-default) | `gmail.send` | `actionAdvertise` off ⇒ unregistered | `DENIED: policy …` |

**KERNEL READBACK** (`createSignedChainReader({partitionId:"tenant-bin"})`): the partition has ≥ the
approved-effect count of entries; every entry's `prevHash` equals the previous entry's `entryHash`
(hash-chained); and **no secret-shaped bytes** appear in any appended event (credential-blind oracle).

## What this proves (and what it does not — honest boundaries)

- **Real** for the in-sandbox `exec.*` / `git.*` tools: the effect actually runs in a real OpenShell
  sandbox to exit 0, and the receipt is in a real Go-kernel WORM chain.
- **attester ≠ actor holds to the PROCESS boundary (TR1)** — the kernel signs/hash-chains in a separate
  process, but the key is in-process/operator-held. Operator-unforgeable HSM/KMS/remote-attestation is
  **TR2/deployment**, not proven here.
- **`net.fetch`** runs a **real** fetch from inside the sandbox to an allowlisted host (verified green).
  **`git.push`** executed needs a real remote + push credential, so the harness proves its **deny** path
  (approval) deterministically; the executed push is left to an operator with a real remote — real-or-skip,
  never faked.
- **Action / browser families are tested REAL, not faked.** The runner also runs `e2e:live-gmail`
  (`gmail.send` → a **real** Google API call; real OAuth resolved at egress) and `e2e:live-browser`
  (`browser.navigate` + `browser.read` → a **real** Chromium driving a real page). Verified live: the
  browser drive navigated + read a real page; the Gmail send made a real Google egress call and was
  governed-**denied** by the account allowlist (the OAuth token's account must equal
  `AGENTOS_ACTION_TEST_ACCOUNT` for a green send — a real config gate, not a fake). `drive.*` / `calendar.*`
  need their own OAuth tokens; absent those they cleanly **skip** — never faked.

## Notes from building it (gotchas the harness encodes)

- The bin **always** seeds `allow-exec/git/net` — there is no opt to remove them — so deny-by-default for
  the core tools is shown via an **unadvertised** tool (`gmail.send`), not by stripping allow rules.
- A freshly-created sandbox may reject the **first** exec; the approve test does a small **readiness warmup**
  (the live capstone got readiness for free via LLM latency).
- All appends share the `tenant-bin` partition, so only **one** kit appends per run; a second appender hits
  `SEQUENCE_REPLAY` — which is the kernel **proving it is append-only** (it refuses to rewrite a settled
  sequence). The runner therefore spawns a **fresh** kernel each run.
- Credential canaries must match the real detector (`src/audit/redact.ts`): `sk-` + 16+ **unbroken**
  `[A-Za-z0-9]`. Synthetic, never a real/published key.
