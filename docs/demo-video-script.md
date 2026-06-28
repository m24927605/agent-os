# Demo & Demo-Video Script

> **Purpose:** make Agent OS *understandable in one watch*. The whole pitch — "an agent that can act
> in the real world, but every action is forced through one governance gate" — lands fastest when you
> SHOW it. Agent OS already has **two verified, end-to-end, real** live demos that are perfect on-screen
> proof: a governed Gmail send and a governed real-Chromium navigate+read. This doc is recording-ready.

The on-screen lines below are the **actual driver output** of the live scripts
(`scripts/e2e-live-gmail.sh` → `scripts/act-live-gmail.mjs`, and `scripts/e2e-live-browser.sh` →
`scripts/act5-live-browser.mjs`). Record the real terminals; do not mock them.

---

## 1. Three demo formats (by audience)

| Format | Audience | What it is |
|---|---|---|
| **"60-second send" hook video** | everyone (execs, prospects, social/launch) | the ~2:40 narrated screen-capture explainer below, built around the ONE moment that lands instantly: an agent sends a real email — and you watch the seatbelt fire first. |
| **Live interactive terminal demo** | Staff+ engineers, security architects | a hands-on, run-it-yourself session (or a faithful asciinema cast) that actually executes the two governed live scripts + the **deny paths**. People who won't believe a rendered video can run it. |
| **Enterprise trust & governance walkthrough** | CISO / GRC / compliance / procurement | a ~6–8 min structured walkthrough framed around the four questions a risk reviewer asks (audit/non-repudiation, credential handling, isolation, recovery), each answered by showing the WORM record + the deny-by-default behavior. Pair with [`docs/security-model.md`](./security-model.md). |

---

## 2. Primary explainer video — scene-by-scene (~2:40)

| # | Scene (≈sec) | On screen | Narration |
|---|---|---|---|
| 1 | **Cold open — the real send** (18s) | Split screen. LEFT: a terminal running `bash scripts/e2e-live-gmail.sh`, lines scrolling. RIGHT: a real inbox; an email lands in real time. | "An AI agent just decided to send this email. And it did — for real, to a real inbox. The interesting part isn't that it sent it. It's everything that had to happen *first*." |
| 2 | **The thesis** (14s) | Hold on the delivered email, then it slides left as one line types in on a clean card: *"Agent OS — a computer that operates itself by intent. Governed while it does."* | "This is Agent OS. It lets an agent act in the real world — send mail, browse, run tools — but every single action is forced through one governance gate. Let's rewind that email." |
| 3 | **Rewind — the governance trace** (30s) | Terminal scrolls back to the real `act-live-gmail: governance trace —` block; each `[stage] detail` line highlights in turn (screen → policy → approval → cost → commit → effect → boundary). | "The agent only *proposes* a tool name. Agent OS screens it for secrets, checks policy — deny by default — requires approval for anything destructive, reserves budget, and only then commits. Notice the order." |
| 4 | **WORM-before-effect — the seatbelt moment** (24s) | Zoom hard on two adjacent trace lines: `[commit] WORM append` (highlighted GREEN) directly above `[effect] …`. A small timeline animation seals the ledger entry, *then* the effect fires. | "The tamper-proof record is written **first**. The email cannot leave until that record is durable. If the record fails, the effect never runs. No 'log it later' — and by design, no undo. Commit, then act." |
| 5 | **The credential is never there** (22s) | Pan to the real egress line `egress POST https://gmail.googleapis.com/… (Authorization: [REDACTED])`. Beside it, the agent's request args showing the placeholder `openshell:resolve:env:<KEY>`. An arrow: *resolved only at egress.* | "And the agent never touches the credential. In its request, the token is just a placeholder. The real key is resolved only at the very last step, on the way out — never in the agent, never in the audit log." |
| 6 | **Second proof — the browser that gets stopped** (26s) | Switch to `bash scripts/e2e-live-browser.sh`. Show `ABOUT TO DRIVE navigate -> read on https://<allowed-host>/`; a real headless Chromium loads the allowed page. Then a deny-path cut: a non-allowlisted host → `route.abort()` at the network. | "Same gate, a different action: now the agent browses. It can reach exactly the hosts it's allowed to. Anywhere else, the request is killed at the network itself — aborted, denied by default." |
| 7 | **What the agent is allowed to read back** (20s) | On the successful read, the real line `act5-live-browser: SANITIZED read content = {…,"truncated":…,"untrusted":true}`. Overlay three tags: *redacted · length-capped · untrusted.* | "And whatever the page returns is scrubbed of secrets, length-capped, and flagged untrusted before it reaches the agent's reasoning. Data flows out through the same seatbelt it flows in." |
| 8 | **Attester ≠ actor** (18s) | A two-box diagram across a process boundary: *Agent (proposes)* → *Agent OS gate*; a SEPARATE box *WORM kernel (signs the record)*. The brain-cannot-self-restore arrow is crossed out. | "One last thing, and it's the whole point. The thing that *acts* is not the thing that *signs the record*. They live in separate processes. The agent can never forge, rewrite, or restore its own history." |
| — | **Close** (12s) | Back to the thesis card; four lines fade in: *Deny by default · Commit before effect · Credential-blind · Attester ≠ actor.* | "Deny by default. Commit before effect. Credential-blind. The recorder is never the actor. That's Agent OS — autonomy you can actually let off the leash. Run the demo yourself." |

**Total ≈ 2:44.** Keep the read calm, technical, founder-credible — no hype adjectives (match the repo's honest tone).

---

## 3. Assets to record / build

- **Primary cast A — governed Gmail send:** a clean recording of `bash scripts/e2e-live-gmail.sh` with the full live env set (§4). Capture `ABOUT TO SEND`, the `governance trace —` block (all `[stage] detail` lines), the `egress POST … (Authorization: [REDACTED])` line, and `SENT ok`.
- **Primary cast B — governed browser navigate+read:** `bash scripts/e2e-live-browser.sh` with `AGENTOS_EGRESS_ALLOW` set + Playwright/Chromium installed. Capture `ABOUT TO DRIVE navigate -> read`, the headless Chromium loading the allowed page, the `governance trace —` block, and `SANITIZED read content = …`.
- **Deny-path casts (technical + enterprise cuts):** (a) re-run the Gmail send with `AGENTOS_APPROVE_PREAUTH` unset → capture `denied@approval`; (b) point the browser at a host NOT on `AGENTOS_EGRESS_ALLOW` → capture `route.abort()` + `denied@policy`. These prove deny-by-default on camera.
- **Real inbox capture:** a throwaway test mailbox receiving the governed email in real time, timed to cast A's `SENT ok`. Blur the address.
- **WORM-ledger / pipeline-trace animation:** a vertical pipeline (screen → policy → approval → cost → commit → effect → boundary) where each node lights up keyed to the real trace lines. The load-bearing beat: the `[commit] WORM append` node sealing a ledger entry **before** `[effect]` fires. Build it from the actual trace text so it matches the terminal.
- **Credential-blind overlay:** side-by-side of the placeholder `openshell:resolve:env:<KEY>` (verbatim from `src/runtime/brain/adapters/hermes/action-seed-tools.ts`) vs the `Authorization: [REDACTED]` egress line, with a "resolved only at egress" arrow.
- **Attester ≠ actor diagram:** the two-process-boundary diagram; optionally back it with a short cast of the released verifier accepting a chain (exit 0) and rejecting a one-char tamper (exit 1) — see [`docs/sdk/verifier-release.md`](./sdk/verifier-release.md).
- **`pnpm run verify` green B-roll (credibility):** a full gate run ending in exit 0 with `1808 passed`, including `verify:cross-tenant`. Capture to a log so it's real.
- **Title / thesis / close motion cards** + **VO track (~2:44, ~340 words)** with burned-in captions for autoplay/social.
- **Honest-boundary slide (enterprise cut only):** one card naming the deploy-gated items so the demo never overclaims — real KMS/HSM trust-root (TR2) and the sandbox SecretResolver (EXEC2) are deploy-gated; the live scripts are runtime-direct and NOT part of `pnpm run verify`.

---

## 4. Recording-environment checklist

⚠️ The live scripts **SKIP (exit 0) rather than fake-green** when their env is unset — confirm the live
env is actually present before recording, or you'll capture a SKIP. Use a **throwaway** Google test
account; **never** show a real credential on screen (the scripts already print `[REDACTED]`, but blur
the recording env too). See [`docs/configuration.md`](./configuration.md) for every variable.

**Cast A — governed Gmail send** (`pnpm run e2e:live-gmail`):
```bash
export AGENTOS_ACTION_LIVE=true
export AGENTOS_ACTION_TEST_ACCOUNT="<throwaway>@gmail.com"   # the allowlisted account
export AGENTOS_GMAIL_OAUTH_KEY="<ya29 token with scope: openid email https://www.googleapis.com/auth/gmail.send>"
export AGENTOS_EGRESS_ALLOW="gmail.googleapis.com,www.googleapis.com"
export AGENTOS_APPROVE_PREAUTH="gmail.send"                  # unset this for the DENY-PATH cast
pnpm run e2e:live-gmail
```

**Cast B — governed browser navigate+read** (`pnpm run e2e:live-browser`):
```bash
pnpm add -D playwright && pnpm exec playwright install chromium   # one-time; not a repo dep
export AGENTOS_EGRESS_ALLOW="example.com"                   # the allowed host (also the navigate target)
pnpm run e2e:live-browser                                   # point at a non-allowlisted host for the DENY-PATH cast
```

**Credibility B-roll:** `pnpm run verify` (ends `All checks passed!`, `1808 passed`).

**After recording:** revoke the throwaway account's OAuth access (`myaccount.google.com/permissions`);
`git checkout package.json pnpm-lock.yaml` to drop the local Playwright install (the repo stays dep-free).

---

## 5. The one-line takeaway the video must leave

**Hermes proposes; Agent OS governs.** The agent can *do* things — and you can let it do them
unattended — because deny-by-default, commit-before-effect, credential-blindness, and a recorder that
is never the actor are enforced on *every* action, not promised.
