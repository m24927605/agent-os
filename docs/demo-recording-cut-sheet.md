# Agent OS — Demo Recording Cut-Sheet (read-aloud)

> **One file to record from.** For each scene: run the **COMMAND**, show the **ON SCREEN** lines (they
> are the *real* captured output — see the cast files), and read the **🎙 NARRATION** aloud. Calm,
> technical, founder-credible read; no hype. Target ~3:00. Ground truth = the cast logs in
> `/tmp/agentos-demo-casts/` (and reproducible via the commands below).

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

## SCENE 1 — Cold open: the real send (≈18s)
**COMMAND:** `pnpm run e2e:live-gmail`  ·  **ON SCREEN (split):** terminal scrolling + the inbox; an email lands.
```
act-live-gmail: ABOUT TO SEND to <test-account> (SELF-send; the operator running this = confirmation)
...
act-live-gmail: SENT ok — governed live self-send executed (confirm receipt in the test mailbox)
```
🎙 **"An AI agent just decided to send this email. And it did — for real, to a real inbox. The interesting part isn't that it sent it. It's everything that had to happen first."**

## SCENE 2 — The thesis (≈14s)
**ON SCREEN:** hold on the delivered email → it slides left; a clean card types in: *"Agent OS — a computer that operates itself by intent. Governed while it does."*
🎙 **"This is Agent OS. It lets an agent act in the real world — send mail, browse, run tools — but every single action is forced through one governance gate. Let's rewind that email."**

## SCENE 3 — Rewind: the governance trace (≈28s)
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
🎙 **"The agent only proposes a tool name. Agent OS screens it for secrets, checks policy — deny by default — requires approval for anything destructive, reserves budget, and only then commits. Watch the order."**

## SCENE 4 — WORM-before-effect: the seatbelt moment (≈22s)
**ON SCREEN:** zoom on the two adjacent lines — `[commit] WORM append` (highlight GREEN) directly above `[effect] …`. A small timeline animation seals the ledger entry, *then* the effect fires.
🎙 **"The tamper-proof record is written first. The email cannot leave until that record is durable. If the record fails, the effect never runs. There is no 'log it later' — and by design, no undo. Commit, then act."**

## SCENE 5 — The credential is never there (≈20s)
**ON SCREEN:** the real egress lines + the placeholder snippet beside them.
```
act-live-gmail: egress GET  https://www.googleapis.com/oauth2/v3/userinfo            (Authorization: [REDACTED])
act-live-gmail: egress POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send (Authorization: [REDACTED])
```
overlay: the agent's arg → `openshell:resolve:env:<KEY>`  →(resolved only at egress)→ `[REDACTED]`
🎙 **"And the agent never touches the credential. In its request, the token is just a placeholder. The real key is resolved only at the very last step, on the way out — never in the agent, never in the audit log."**

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
🎙 **"Now the same send — but not approved. Watch the trace stop. There's no commit. There's no effect. The connector is never even reached. The seatbelt didn't catch a bad action after the fact — the action simply never happened. That's the whole idea: nothing to undo, because nothing was done."**

## SCENE 7 — A different domain: the browser, allowed and blocked (≈28s)
**COMMAND:** `pnpm run e2e:live-browser` then `pnpm run e2e:deny-demo`  ·  **ON SCREEN:** real Chromium loads the allowed page; then the deny cut.
```
act5-live-browser:  ABOUT TO DRIVE navigate -> read on https://example.com/   →  [outcome] executed
act5-deny-demo:     ABOUT TO ATTEMPT navigate -> https://blocked.not-allowlisted.example/  (NOT on the allowlist)
  [authorize] DENIED@policy — policy.egress-allowlist: host not on allowlist (deny-by-default)
act5-deny-demo:     DENIED ok — connector NEVER driven; nothing committed; nothing to undo.
```
🎙 **"Same gate, a different kind of action — now it browses. It can reach exactly the hosts it's allowed to. Anywhere else, the request is killed at the network itself, before the browser is ever driven. One governance edge, every tool family."**

## SCENE 8 — What it's allowed to read back (≈16s)
**ON SCREEN:** the sanitized read line; overlay three tags.
```
act5-live-browser: SANITIZED read content = {"content":"Example Domain…","truncated":false,"untrusted":true}
```
🎙 **"And whatever a page returns is scrubbed of secrets, length-capped, and flagged untrusted before it reaches the agent's reasoning. Data flows out through the same seatbelt it flows in."**

## SCENE 9 — Attester ≠ actor (≈16s)
**ON SCREEN:** a two-box diagram across a process boundary — *Agent (proposes)* → *Agent OS gate*; a SEPARATE *WORM kernel (signs the record)*; the brain-cannot-self-restore arrow crossed out.
🎙 **"One last thing, and it's the whole point. The thing that acts is never the thing that signs the record. They live in separate processes. The agent can't forge, rewrite, or restore its own history."**

## SCENE 10 — Close (≈14s)
**COMMAND (B-roll):** `pnpm run verify`  ·  **ON SCREEN:**
```
Tests  1808 passed | 29 skipped     All checks passed!     secret-scan: clean
```
then the thesis card; four lines fade in: *Deny by default · Commit before effect · Credential-blind · Attester ≠ actor.*
🎙 **"Deny by default. Commit before effect. Credential-blind. The recorder is never the actor. That's Agent OS — autonomy you can actually let off the leash. Run the demo yourself."**

---

## Narration-only (teleprompter, ~340 words, ~2:50 at a calm pace)

1. An AI agent just decided to send this email. And it did — for real, to a real inbox. The interesting part isn't that it sent it. It's everything that had to happen first.
2. This is Agent OS. It lets an agent act in the real world — send mail, browse, run tools — but every single action is forced through one governance gate. Let's rewind that email.
3. The agent only proposes a tool name. Agent OS screens it for secrets, checks policy — deny by default — requires approval for anything destructive, reserves budget, and only then commits. Watch the order.
4. The tamper-proof record is written first. The email cannot leave until that record is durable. If the record fails, the effect never runs. There is no "log it later" — and by design, no undo. Commit, then act.
5. And the agent never touches the credential. In its request, the token is just a placeholder. The real key is resolved only at the very last step, on the way out — never in the agent, never in the audit log.
6. Now the same send — but not approved. Watch the trace stop. There's no commit. There's no effect. The connector is never even reached. The seatbelt didn't catch a bad action after the fact — the action simply never happened. That's the whole idea: nothing to undo, because nothing was done.
7. Same gate, a different kind of action — now it browses. It can reach exactly the hosts it's allowed to. Anywhere else, the request is killed at the network itself, before the browser is ever driven. One governance edge, every tool family.
8. And whatever a page returns is scrubbed of secrets, length-capped, and flagged untrusted before it reaches the agent's reasoning. Data flows out through the same seatbelt it flows in.
9. One last thing, and it's the whole point. The thing that acts is never the thing that signs the record. They live in separate processes. The agent can't forge, rewrite, or restore its own history.
10. Deny by default. Commit before effect. Credential-blind. The recorder is never the actor. That's Agent OS — autonomy you can actually let off the leash. Run the demo yourself.

---
Companion: `docs/demo-video-script.md` (the asset list + the three demo formats). Casts: `cast-A-gmail` / `cast-D-deny-gmail` / `cast-B-browser` / `cast-C-deny-browser` / `cast-verify-summary`.
