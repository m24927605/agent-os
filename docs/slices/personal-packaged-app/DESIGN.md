# Personal zero-skill packaged app — design (v1)

**Closes AOS-UX dimension D7** (scored 1/5: "the Personal zero-skill PACKAGED path does NOT exist — only a
developer-mediated example"). Target: a non-technical person **installs one thing** (no git/pnpm/Docker CLI, no
editing config/secrets) → expresses an intent → sees a plan → approves → watches it in a governed timeline.
(AOS-UX metric 16 = the packaged path exists reachable without a CLI; metric 17 = Personal SUS ≥ 80.)

Produced by a Staff+ panel (Product / DevOps / Security / UX). See also [AOS-UX Standard](../../aos-ux-standard.md).

## Recommended approach — a signed native ORCHESTRATOR, not a new UI

Ship **"Agent OS Engine"**: a signed, notarized native **Tauri** menu-bar/tray **supervisor** (macOS-first
`.dmg`), distributed as an Agent-OS-hosted signed installer, with a **hosted brain** (Nous Portal, already the
Hermes default). The orchestrator is the **one front door** the user ever opens; it provisions a container
runtime, verify-before-start launches the existing 127.0.0.1-pinned `kernel`/`substrate` stack, drives the
**already-shipped** `agentos setup`/`doctor`/`config` CLI internally, generates + keychains a local session
key, then **launches and points Hermes Desktop** — which stays the **sole** intent/plan/approval/timeline
surface. It is a lifecycle + health + recovery supervisor, **never a second UI**.

**Rejected:** a `curl | sh` installer (a terminal *is* the failure mode for this persona; no ongoing
lifecycle/repair; TOFU supply chain), and a **hosted substrate** (Personal's promise is "operate *your*
computer" — a remote body can't touch local files/apps and breaks the localhost credential-blind trust model;
that is the Enterprise shape). Tauri over Electron: smaller footprint, OS webview, a Rust core is a natural
compose supervisor, cleaner to notarize.

## Zero-skill flow (persona "Nadia", 58, never opened a terminal; target ≤ ~5–10 min, only wait = the download)

1. **Install** — download a signed `.dmg`, drag to Applications, double-click → Gatekeeper-clean launch.
2. **"Preparing your computer"** — the orchestrator's one full-window setup moment (plain-language progress, never
   terminal logs). Invisibly: ensure a container runtime → **verify-before-start** (re-run `launcher-check` on the
   bundled compose + check kernel/substrate images by pinned digest + signature, refuse on mismatch) → CSPRNG
   `SHELL_SESSION_KEY` into the OS keychain → `docker compose up -d` the 127.0.0.1-pinned kernel+substrate,
   await healthchecks → run `agentos setup` + `config render/check` (compile the non-secret config) → register the
   governed `agentos-exec` MCP into `~/.hermes/config.yaml` via the credential-blind install-hermes helpers →
   run `agentos doctor`, map PASS/FAIL/SKIP to a tray traffic light.
3. **Brain login** (the one human action, and it is **not ours**) — a "Sign in to your assistant" button opens the
   system browser to Nous Portal OAuth **inside Hermes**; the token is written by Hermes into its own store; the
   orchestrator never sees it.
4. **"Open your assistant"** unlocks **only** once `doctor` exits 0 (all required PASS). It launches Hermes
   Desktop, already pointed at `agentos-exec`; the orchestrator recedes to the menu bar. **Hermes is the surface.**
5. **First governed intent (the "aha")** — Hermes greets with **one seeded, PDP-passing, sandbox-safe, reversible**
   starter intent (e.g. "organize this folder" / "summarize this document" / "back up my Notes") so turn one can't
   flop. User types it → the brain proposes a tool call → Agent OS runs `renderPlanPreview` → that preview becomes
   the **content of Hermes's own native approval card** → user clicks **Approve in Hermes** → the sole governed edge
   runs screen→PDP→approval→cost→**commit/WORM**→effect→boundary in the substrate + kernel → the WORM-backed
   `buildTaskTimeline` result surfaces **back into the Hermes chat** as a legible receipt. Intent → plan card →
   approve → completed receipt, fully governed, **no new UI**.
6. **Steady state** — tray sits green in the background (Start/Stop/Update/Repair buttons). A **denied** action
   renders in Hermes as a plain-language *decision* ("I didn't do that — it isn't allowed by your rules: <reason>.
   You can [Allow this kind of action] or [Ask me something else]"), where "Allow" opens a scoped human
   maker-checker that writes a **narrow** allow-rule (deny stays default without explicit consent).

**Failure recovery, no terminal:** doctor FAIL → tray red → one plain-language card per failing check, each with
exactly **one** action button ("Agent OS can't reach its secure recorder → [Restart engine]"). The health dot is a
**pure function of doctor's exit code** (green ⇔ exit 0, amber = still starting, red = needs you). Repair is
**capped at 3** attempts; on exhaustion offer "Reset to clean" and "Get help" (a **credential-blind** diagnostic =
doctor PASS/FAIL/SKIP only, redactSecrets + secret-scan) — never a stack trace.

## Architecture — four processes, one front door

1. **Tauri orchestrator** = a Rust supervisor + a thin webview (setup wizard / tray cards). Its **logic lives in a
   testable TS `personal-orchestrator` harness** so CI can fail-closed on all of it; the Rust/webview shell is a
   thin wrapper. It owns: runtime detection, verify-before-start, keychain session-key, `compose up/down/ps` +
   health-poll, driving `agentos setup`/`doctor`/`config`, the install-hermes MCP registration, launching/pointing
   Hermes, the doctor→health-card mapping + capped Repair machine, and the signed auto-updater. It **imports no
   `src` governance module** ("a launcher, not a new engine") and is never in the effect path.
2. **The compose stack** — `kernel` (WORM attester), `substrate` (the OpenShell exec actor/boundary), `shell`
   (the `src/personal` governance **backend** running intent→plan-preview→approval→timeline as logic — its `:8080`
   web page is **not** surfaced; `agentos-exec` calls into it). All 127.0.0.1-pinned; `launcher:check` gates the
   pins + zero-secrets before every up.
3. **Hermes Desktop** — the brain + the **sole** experience surface, spawning the `agentos-exec` MCP bin.
4. **Nous Portal** — the hosted brain (third-party).

**Health:** tray green/amber/red derived purely from the compose healthchecks + `doctor` exit code, via a new
`doctor --json` structured mode (map checks, don't scrape). **Refinement worth taking:** kernel + shell are plain
localhost services (could later run as supervised native sidecars, no runtime); only **substrate** is the
virtualization-bound security boundary that truly needs a container runtime — this narrows the heaviest dependency
to one service.

> **⚠️ Found in code — endpoint skew (must fix, Phase 1):** the compose ports (`7070/7071/8080`) do **not** match
> the doctor defaults (`DEFAULT_KERNEL=127.0.0.1:50051`, `DEFAULT_OPENSHELL=127.0.0.1:17670`). A fresh-box
> start→doctor would FAIL. The `agent-os.config.json` compiler must thread **one** endpoint source into compose +
> doctor + the MCP registration, enforced by an **endpoint-consistency invariant** in `launcher-check`.

## Brain-login / credential model — two structurally-separated domains (that separation *is* the credential-blind story)

- **Domain A — the brain (the only sign-in a zero-skill user does, and it is NOT ours):** the orchestrator launches
  Hermes; the user clicks "Sign in with Nous Portal" **inside Hermes**; the OAuth token is written by Hermes into
  its own `~/.hermes`. Agent OS never sees, proxies, or reads it — **structural** blindness (the HermesTurn/ACP
  contract carries only intent + proposals, no key field; `~/.hermes` is never read; doctor probes registration via
  Hermes's own `hermes mcp list`). No key paste in v1.
- **Domain B — local + action credentials (two-plane, resolved only at egress):** `SHELL_SESSION_KEY` is
  CSPRNG-generated into the **OS keychain** on first run and injected into the stack env at `compose up` (replacing
  the README's terminal `export`/`.env`), **never** a file/log — a locked/headless keychain **fails closed**
  ("can't start securely"); a plaintext `.env` fallback is **forbidden + test-gated**. Optional action creds
  (`AGENTOS_GMAIL_OAUTH_KEY`, … — the `KNOWN_SECRET_ENV_KEYS` doctor already inventories) are **deferred** (the
  first "aha" intent is credential-free); when a later approved intent needs one, a guided "Connect X" runs OAuth
  (token straight into the keychain under the config's KEY NAME) — the config holds only the KEY NAME, the value is
  resolved only at the OpenShell SecretResolver egress (`openshell:resolve:env:<KEY>`), never in config/WORM/logs/brain.

## In-repo MVP (verify-guardable NOW — no deploy target) vs deploy-gated

**In-repo MVP** — the packaging/orchestration/**onboarding harness** as DI-seamed TS that **composes the shipped
`setup.ts`/`doctor.ts`** (zero new engine; same injectable-deps + exit-code + fail-closed discipline, fakeable like
`DoctorProbes`/`SetupDeps`):

1. A `personal-orchestrator` **onboarding state machine** (injected seams: spawn/compose, health-probe, doctor,
   keychain-write, hermes-launch) → returns one plain-language status object; unit-test every PASS/FAIL/recover branch.
2. `doctor --json` structured PASS/FAIL/SKIP + a remediation action per FAIL (exit behavior unchanged).
3. A doctor→**human-card** mapping as a pure table + a **`NAMES_A_HUMAN_FIX` conformance gate** (mirroring the AOS-UX
   `NAMES_A_FIX`) asserting every doctor check has a card + exactly one recovery action — humane recovery becomes a CI invariant.
4. The capped (≤3) Repair state machine.
5. A credential-blind session-key generator behind an injectable keychain port + a **non-leak test** + a
   **forbidden-plaintext-`.env`-fallback test**.
6. The headless Hermes-wiring writer (merge the `mcp_servers` block into a fake `~/.hermes/config.yaml`; **no-token** test).
7. The Nous-OAuth **handoff** invocation (open URL / shell `hermes`) with a test asserting no token touches Agent OS files.
8. **Harden `launcher-check`** with the **endpoint-consistency** invariant (fixes the 7070/50051 skew fail-closed) +
   a substrate-hardening invariant (non-root / cap-drop / read-only / no-new-privileges).
9. The seeded starter-intents as data + a first-run writer + a Personal denied-action → plain-language projection.
10. `pnpm run package:personal` emitting an **UNSIGNED** Tauri artifact + a **structural test** (bundle contains the
    pinned compose + the CLI + the install-hermes helper; secret-scan clean; every port 127.0.0.1; a GUI entrypoint
    declared) + a **first-run acceptance harness** driving the whole state machine against fakes, asserting
    zero-terminal-steps, **no-fake-green** ("ready" ⇔ doctor exit 0), and credential-blindness.

→ This makes **AOS-UX metric 16 a harness-level exit-code fact even before real images exist**.

**Deploy-gated (MUST NOT be claimed done):** (1) the real published images `agent-os/audit-kernel` / `substrate` /
`personal-shell`; (2) **code signing + notarization** (Apple Developer ID + hardened runtime + notarytool; nested
signing of any bundled runtime + the virtualization entitlement; later Windows Authenticode; a Tauri Ed25519
update key) — the single biggest install→healthy enabler, pure infra/legal; (3) hosting (a cosign-signed image
registry, an update feed, a download page); (4) a bundled/bootstrapped **container runtime** per OS; (5) a real
Hermes binary + a live Nous Portal OAuth app + account; (6) real sandboxes + the live OpenShell egress + action
OAuth apps; (7) the real KMS/HSM WORM trust-root (TR2); (8) the moderated **SUS study** for metric 17. **Do not
overclaim metric 16 "met" until images + signing + hosting are real** — until then it is a guarded harness, not a
shippable installer, and metric 16 ≠ metric 17.

## Invariants preserved

- **Deny-by-default / fail-closed** — the orchestrator only starts/stops the stack + points the brain; the PDP,
  commitgate, and pipeline are unchanged; `doctor`/`agentos up` exit non-zero on any required FAIL/unknown ⇒ tray
  RED + engine STOPPED (never a fake green); `launcher-check` re-runs before every up.
- **Credential-blind** — brain token only in `~/.hermes`; `SHELL_SESSION_KEY` keychained + egress-injected, never a
  file/log (plaintext-`.env` forbidden + test-gated); action creds two-plane; install/render helpers THROW on
  secret-shaped env; doctor + diagnostics print names/PASS/FAIL/SKIP only.
- **Commit-before-effect** — untouched (the orchestrator is not in the effect path); a down kernel ⇒ doctor FAIL ⇒ effect blocked.
- **Attester ≠ actor WORM** — preserved by the container **process** split (kernel attests, substrate acts; the
  orchestrator supervises + signs nothing); updates are **forward-only** (snapshot/restore, admin-signed — no undo).
  Honest caveat: on a single-user box the owner is root → Personal WORM is tamper-**evident**, not tamper-proof
  against its own owner; the moat targets the **prompt-injectable brain** (the real adversary), which the process boundary holds.
- **No new UI** — the orchestrator renders only ops chrome (health chip + Start/Stop/Repair/Update/Open-Hermes +
  recovery cards + login handoff) — no intent box / plan authoring / timeline — **enforced by a conformance test**.

## Phasing (MVP-first)

0. **In-repo MVP (verify-guardable now):** the onboarding state machine + `doctor --json` + doctor→human-card
   mapping (with `NAMES_A_HUMAN_FIX` gate) + capped Repair + credential-blind session-key (non-leak + forbidden-`.env`
   tests) + headless Hermes-wiring writer (no-token test). Exit: fail-closed CI green on the full state machine.
1. **In-repo, close correctness gaps:** fix the **endpoint skew** (one endpoint source → compose + doctor + MCP) +
   harden `launcher-check` (endpoint-consistency + substrate-hardening); seeded starter-intents + first-run writer +
   denied-action projection + a localization string-table (projections are zh-TW today).
2. **In-repo:** scaffold the Tauri project as a thin wrapper over Phase 0; `pnpm run package:personal` (UNSIGNED) +
   the structural + first-run acceptance harnesses. Exit: metric 16 is a harness-level fact.
3. **Deploy-gated:** build + cosign-sign + publish the three images; update feed + download page; decide + bundle the runtime.
4. **Deploy-gated (the true zero-skill unlock):** Apple Developer ID signing + notarization; the Tauri auto-updater key + channel.
5. **Validation:** a moderated SUS study on the signed app + real brain (metric 17 ≥ 80); then Windows + Linux fast-follow.

## Top risks

Container-runtime on a zero-skill machine is the **#1 activation killer** (Docker Desktop is heavy/licensed;
virtualization often off; corp laptops block it; substrate's containment is virtualization-bound) — the no-terminal
recovery must be bulletproof or SUS collapses. Signing/notarization is a hard external dependency on the critical
path. **Hermes is third-party** (installer, OAuth, config.yaml format, and whether its approval card renders our
plan-preview faithfully — if not, "see a plan before you approve" degrades to a raw confirm; mitigate by pinning a
tested version + contract-testing `hermes mcp list`). Two-apps confusion (enforce a single front door). Orchestrator
scope-creep into a second UI (hold the line with the conformance test). The **seeded first intent** must be proven to
pass the PDP **and** succeed in the sandbox (a denied/scary turn-one poisons trust). SUS ≥ 80 for a governance-gated
flow is hard (scope approvals to effectful/irreversible actions; frame the preview as reassurance, not a tax).

## Open decisions (product/scope — for the user)

1. **Container-runtime strategy** (biggest): rootless **Podman** (Apache, daemonless, better deny-by-default fit) vs
   Docker Desktop vs Apple-container/colima/libkrun microVM — and whether to split kernel+shell to native sidecars so
   only substrate needs virtualization.
2. **Target OS order** — confirm macOS-first (one signing + one runtime story), Windows/Linux fast-follow.
3. **Signing/distribution ownership** — Apple Developer ID + notarization now (who owns the certs/HSM + CI signing) +
   the image registry + cosign + update feed + download page.
4. **Hosted-vs-local** — local stack + hosted Nous brain (recommended); confirm no hosted-substrate variant for Personal.
5. **Brain default + login mode** — Nous OAuth-in-Hermes as the only v1 sign-in (recommended); guided masked
   key-paste in v1 or a power-user fast-follow?
6. **The seeded first intent(s)** — pick 1–3 curated, PDP-passing, sandbox-safe, reversible, satisfying starters
   (real-user-tested — a denied/scary turn-one poisons trust).
7. **The `:8080` shell** — confirm it stays the governance **backend** `agentos-exec` calls into (page not surfaced), not retired.
8. **Localization scope** — which language(s) the plain-language projections ship in (currently zh-TW).
9. **Update posture** — notify-and-apply vs silent; pin-Hermes-version-and-warn vs track-latest.
10. **Honest-claim bar** — agree metric 16 is claimed only when images + signing + hosting are real (harness green ≠
    installer shipped); metric 17 only after a moderated SUS study.
