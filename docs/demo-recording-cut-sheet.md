# Agent OS — Demo Recording Cut-Sheet (read-aloud, v2 polished)

> **One file to record from.** For each scene: run the **COMMAND**, show the **ON SCREEN** lines (they
> are the *real* captured output — see the cast files), and read the **🎙 NARRATION** aloud. Calm,
> technical, founder-credible read; no hype; let the periods breathe. Target ~2:30–3:00. The narration
> below matches the generated VO (`vo/full.m4a` + `vo/scene-01..10.m4a`). Ground truth = the cast logs.

## Pre-flight (before you hit record)

```bash
# Terminal 1 — Gmail (live env from a throwaway account; token scope: openid email .../gmail.send)
set -a; source ~/.env; set +a            # loads AGENTOS_ACTION_LIVE / _TEST_ACCOUNT / _GMAIL_OAUTH_KEY / _EGRESS_ALLOW / _APPROVE_PREAUTH
# Terminal 2 — Browser (one-time): pnpm add -D playwright && pnpm exec playwright install chromium
export AGENTOS_EGRESS_ALLOW="example.com"
```
Have a real inbox open (the throwaway test mailbox) for the "email lands" shot. The scripts **SKIP**
(not fake) if env is missing — confirm a real run first. Nothing prints a credential (`[REDACTED]`).

---

## SCENE 1 — Cold open: the real send (≈16s)
**COMMAND:** `pnpm run e2e:live-gmail`  ·  **ON SCREEN (split):** terminal scrolling + the inbox; an email lands.
```
act-live-gmail: ABOUT TO SEND to <test-account> (SELF-send; the operator running this = confirmation)
...
act-live-gmail: SENT ok — governed live self-send executed (confirm receipt in the test mailbox)
```
🎙 **"An agent just sent this email. For real. To a real inbox. The interesting part isn't that it sent it. It's everything that had to happen first."**

## SCENE 2 — The thesis (≈14s)
**ON SCREEN:** hold on the delivered email → it slides left; a clean card types in: *"Agent OS — a computer that operates itself by intent. Governed while it does."*
🎙 **"This is Agent OS. It lets an agent act in the real world. Send mail. Browse. Run tools. But every action it takes is forced through one gate. Let's rewind that email, and watch the gate."**

## SCENE 3 — Rewind: the governance trace (≈26s)
**ON SCREEN:** scroll back to the real trace block; highlight each line in turn.
```
act-live-gmail: governance trace —
  [screen]    ok: gmail.send
  [authorize] allow; egress+approval folded; requiresApproval=true
  [approval]  pre-authorized by operator (gmail.send)
  [commit]    WORM append (intent / boundary)
  [effect]    guarded connector → google connector → transport (egress)
  [commit]    WORM append (intent / boundary)
  [outcome]   executed
```
🎙 **"The agent only proposes a tool. Agent OS screens it for secrets. Checks policy — deny by default. Requires approval for anything destructive. Reserves the budget. And only then, commits. Watch the order."**

## SCENE 4 — WORM-before-effect: the seatbelt moment (≈22s)
**ON SCREEN:** zoom on the two adjacent lines — `[commit] WORM append` (highlight GREEN) directly above `[effect] …`. A small timeline animation seals the ledger entry, *then* the effect fires.
🎙 **"The record is written first. The email can't leave until that record is durable. If the record fails, the effect never runs. No log-it-later. And by design — no undo. Commit. Then act."**

## SCENE 5 — The credential is never there (≈18s)
**ON SCREEN:** the real egress lines + the placeholder snippet beside them.
```
act-live-gmail: egress GET  https://www.googleapis.com/oauth2/v3/userinfo            (Authorization: [REDACTED])
act-live-gmail: egress POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send (Authorization: [REDACTED])
```
overlay: the agent's arg → `openshell:resolve:env:<KEY>`  →(resolved only at egress)→ `[REDACTED]`
🎙 **"The agent never touches the credential. In its request, the key is just a placeholder. The real token is resolved at the last possible moment, on the way out. Never in the agent. Never in the log."**

## SCENE 6 — The refusal: same action, no approval (≈24s)  ⟵ THE HEADLINE
**COMMAND:** `pnpm run e2e:gmail-deny-demo`  ·  **ON SCREEN:** the deny trace — point out there is **no `[commit]` and no `[effect]`**.
```
act-gmail-deny-demo: ABOUT TO ATTEMPT gmail.send WITHOUT pre-authorization (a destructive action)
  [screen]    ok: gmail.send
  [authorize] allow; egress folded; requiresApproval=true
  [outcome]   denied@approval
act-gmail-deny-demo: DENIED ok — the Google connector was NEVER driven (perform calls=0), NOTHING was
                     committed to the WORM, and NO email was sent. The approval gate stopped it before any effect.
```
🎙 **"Now the same email. But this time, not approved. Watch the trace stop. No commit. No effect. The connector is never even reached. Nothing was caught after the fact, because nothing happened. There is nothing to undo — because nothing was done."**

## SCENE 7 — A different domain: the browser, allowed and blocked (≈26s)
**COMMAND:** `pnpm run e2e:live-browser` then `pnpm run e2e:deny-demo`  ·  **ON SCREEN:** real Chromium loads the allowed page; then the deny cut.
```
act5-live-browser:  ABOUT TO DRIVE navigate -> read on https://example.com/   →  [outcome] executed
act5-deny-demo:     ABOUT TO ATTEMPT navigate -> https://blocked.not-allowlisted.example/  (NOT on the allowlist)
  [authorize] DENIED@policy — policy.egress-allowlist: host not on allowlist (deny-by-default)
act5-deny-demo:     DENIED ok — connector NEVER driven; nothing committed; nothing to undo.
```
🎙 **"Same gate. A different kind of action. Now it browses. It reaches exactly the hosts it's allowed to. Anywhere else, the request dies at the network, before the browser even moves. One gate. Every tool."**

## SCENE 8 — What it's allowed to read back (≈15s)
**ON SCREEN:** the sanitized read line; overlay three tags.
```
act5-live-browser: SANITIZED read content = {"content":"Example Domain…","truncated":false,"untrusted":true}
```
🎙 **"And whatever the page returns is scrubbed of secrets, capped, and marked untrusted — before the agent ever reads it. Data leaves through the same seatbelt it came in."**

## SCENE 9 — Attester ≠ actor (≈16s)
**ON SCREEN:** a two-box diagram across a process boundary — *Agent (proposes)* → *Agent OS gate*; a SEPARATE *WORM kernel (signs the record)*; the brain-cannot-self-restore arrow crossed out.
🎙 **"And here's the heart of it. The thing that acts is never the thing that signs the record. Different processes. So the agent can't forge its own history. It can't rewrite it. It can't even restore it."**

## SCENE 10 — Close (≈14s)
**COMMAND (B-roll):** `pnpm run verify`  ·  **ON SCREEN:**
```
Tests  1808 passed | 29 skipped     All checks passed!     secret-scan: clean
```
then the thesis card; four lines fade in: *Deny by default · Commit before effect · Credential-blind · Attester ≠ actor.*
🎙 **"Deny by default. Commit before effect. Credential-blind. The recorder is never the actor. That's Agent OS. Autonomy you can actually leave running. Try it yourself."**

---

## Narration-only (teleprompter — matches the chosen VO: OpenAI `gpt-4o-mini-tts`, voice **nova**, ~2:00)

1. An agent just sent this email. For real. To a real inbox. The interesting part isn't that it sent it. It's everything that had to happen first.
2. This is Agent OS. It lets an agent act in the real world. Send mail. Browse. Run tools. But every action it takes is forced through one gate. Let's rewind that email, and watch the gate.
3. The agent only proposes a tool. Agent OS screens it for secrets. Checks policy — deny by default. Requires approval for anything destructive. Reserves the budget. And only then, commits. Watch the order.
4. The record is written first. The email can't leave until that record is durable. If the record fails, the effect never runs. No log-it-later. And by design — no undo. Commit. Then act.
5. The agent never touches the credential. In its request, the key is just a placeholder. The real token is resolved at the last possible moment, on the way out. Never in the agent. Never in the log.
6. Now the same email. But this time, not approved. Watch the trace stop. No commit. No effect. The connector is never even reached. Nothing was caught after the fact, because nothing happened. There is nothing to undo — because nothing was done.
7. Same gate. A different kind of action. Now it browses. It reaches exactly the hosts it's allowed to. Anywhere else, the request dies at the network, before the browser even moves. One gate. Every tool.
8. And whatever the page returns is scrubbed of secrets, capped, and marked untrusted — before the agent ever reads it. Data leaves through the same seatbelt it came in.
9. And here's the heart of it. The thing that acts is never the thing that signs the record. Different processes. So the agent can't forge its own history. It can't rewrite it. It can't even restore it.
10. Deny by default. Commit before effect. Credential-blind. The recorder is never the actor. That's Agent OS. Autonomy you can actually leave running. Try it yourself.

---
Companion: `docs/demo-video-script.md` (asset list + the three demo formats). Casts: `cast-A-gmail` / `cast-D-deny-gmail` / `cast-B-browser` / `cast-C-deny-browser` / `cast-verify-summary`. **Chosen VO:** OpenAI `gpt-4o-mini-tts`, voice **nova** (warm female), generated from this narration with a calm/founder-credible instruction — full track + per-scene `.mp3` (kept as demo artifacts, not committed). Regenerate by re-running the narration through the same TTS call with `voice: "nova"`.
