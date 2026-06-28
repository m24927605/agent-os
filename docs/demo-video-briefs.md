# Agent OS — Video Production Briefs

> **Purpose:** production-ready creative briefs for the Agent OS films, written to be handed
> straight to a motion-design / video studio (or a capable text-to-video + edit pipeline) and
> executed **without back-and-forth**. They encode the product truth, narrative, visual system,
> motion design, sound design, and acceptance criteria for each cut.
>
> **Companions:** [`demo-video-script.md`](./demo-video-script.md) (asset list + the *real* on-screen
> lines from the live scripts) and the read-aloud [`demo-recording-cut-sheet.md`](./demo-recording-cut-sheet.md).
> Ground truth for every trace on screen = the real cast logs (`scripts/act-live-gmail.mjs`,
> `scripts/act5-live-browser.mjs`, and the deny runners).

## The three-cut strategy

One product, three audiences, three jobs. Do **not** make one film do all three.

| Cut | Length | Audience | Job |
|-----|--------|----------|-----|
| **Hero** | 60–75s | Top-of-funnel: CISO / Head of AI / exec | Earn attention; one feeling: *"autonomy I could actually leave running."* The **refusal** is the hero moment. No architecture. |
| **Product Demo** | 2–3 min | Hands-on evaluators (eng / platform / security) | Show the governed pipeline end-to-end, **the same gate across every tool family**; make them want to clone it. |
| **Technical / Architecture** | 5–8 min | Security architects, auditors, deep diligence | Prove each invariant is **structural** (process boundaries, fail-closed control flow, a signed append-only chain) — defensible to a security team. |

The through-line is shared across all three: **"Hermes proposes. Agent OS governs."** Tagline:
**"Autonomy you can actually leave running."**

## Shared specification (inheritance)

The **Demo** and **Technical** briefs inherit the **Hero** brief's visual system (§4), motion design
(§7), sound design (§8), captions (§9), and hard constraints (§10–11). Each lower brief specifies only
what *differs*. Keep palette, type, the two emphasis beats (the ledger **seal** and the **deny**), and
the reveal discipline (each item appears ~0.2s **before** the word that introduces it) consistent.

## Honest status — what exists vs what these briefs are for

A **synthetic animatic** (terminal-style rendered cards + an AI "nova" scratch VO + word-timed reveals,
A/V-synced) exists as a **pre-viz / timing reference**. It is **not** the enterprise deliverable. The
production step these briefs describe requires **real screen footage** (terminal / browser / inbox /
trace), **licensed music + sound design**, and a **final VO**. Use the animatic as the edit/timing
reference; shoot the real thing against these briefs.

---

## Cut 1 — Hero film (60–75s)

```
=====================================================================
AGENT OS — HERO PRODUCT FILM · PRODUCTION BRIEF v2
=====================================================================

0 · PROJECT
  A 60–75s enterprise hero film for Agent OS. One feeling to leave the viewer with:
  "I could let AI agents act on their own here — and still trust, prove, and audit
  every move." Master 16:9, plus 1:1 and 9:16. 30fps (accept 24 if it suits the grade).
  This is a cinematic product film, NOT a slideshow and NOT a screen-recording with a
  voiceover slapped on.

1 · STRATEGY & POSITIONING
  Audience: CISO, Head of AI/Platform Eng, security architects evaluating whether to let
    agents take real actions (send, pay, browse, run) without a human on every click.
  Their fear: a hijacked or hallucinating agent doing something irreversible, leaking a
    credential, or acting with no provable record of who allowed it.
  Competitive frame (imply, don't bash): the alternatives are (a) a human approving every
    action — doesn't scale, or (b) "guardrails" the agent can talk its way around. Agent
    OS is a control plane the agent CANNOT bypass.
  The one idea: separate the thinker from the doer. The brain proposes; the OS governs.
  Through-line (spine of the film): "Hermes proposes. Agent OS governs."
  Tagline (end card): "Autonomy you can actually leave running."

2 · PRODUCT TRUTH  (accurate; never overclaim; if a shot is reconstructed it must still
   be technically faithful)
  Agent OS = a governance layer between an LLM "brain" and the real world. The agent only
  PROPOSES a tool call; Agent OS screens, authorizes, records, then executes. Four
  invariants ARE the product:
    1. Deny by default — unknown / malformed / error ⇒ refused.
    2. Commit before effect — an append-only, tamper-evident record is sealed BEFORE the
       action runs. If the record fails, the effect never happens. No undo by design.
    3. Credential-blind — the agent sees only a placeholder ("resolve:env:<KEY>"); the real
       secret is resolved at network egress, never in the agent, never in any log.
    4. Attester ≠ actor — the process that signs the record is SEPARATE from the one that
       acts, so the agent cannot forge, rewrite, or restore its own history.
  The governed path (keep trace text faithful, in this order):
    screen → authorize (policy · egress · approval; deny by default) → commit (record
    sealed) → effect → boundary.
  Components (only if a longer cut needs them; not required in the hero):
    Hermes = brain (proposes) · OpenShell = execution substrate (sandbox) · NemoClaw =
    agent hosting · Agentic SpendGuard = cost gate (reserve/commit budget) · AGT = advisory
    governor (can only narrow a decision, never grant). All swappable behind neutral ports;
    the governance core (the "spine" + the tamper-proof ledger) is vendor-neutral.

3 · REFERENCES / MOOD  (match this register, do not copy)
  The calm authority of Apple's privacy films; the restraint and product-forward editing
  of Linear and Stripe launch films; the "serious infrastructure" feel of Vanta / Vercel.
  Think: confident, quiet, exact. Closer to a security keynote than an ad.

4 · TONE & VISUAL SYSTEM
  Tone: calm, confident, founder-credible. Cinematic restraint. Let silence do work.
  Palette: near-black base #0a0e14; soft slate text #cdd6f4; semantic accents — green
    #a6e3a1 = allowed / sealed, red #f38ba8 = denied, amber #fab387 = credential, blue
    #89b4fa = system/stage labels. Use accents sparingly, as meaning, not decoration.
  Type: a clean grotesk for titles (e.g. Inter/Suisse); a crisp mono for terminal/trace
    (e.g. SF Mono/JetBrains Mono). Generous margins; never fill the frame.
  Footage policy: the PROOF beats (hook send, allow trace, deny trace, inbox, credential
    egress) MUST be real product capture or a frame-faithful reconstruction. Stylized
    motion-graphics are allowed ONLY for the idea diagram and the closing invariants.

5 · VOICEOVER  (final copy — read verbatim; warm, measured, ~60s total)
  HOOK   "An agent just sent this email. For real, to a real inbox. No human clicked send."
  STAKES "That's where software is going. It's also the risk. An agent can be hijacked by
          a single web page. It can leak the keys you give it. It can do something
          irreversible — and leave no record of who allowed it."
  IDEA   "Agent OS changes the deal. Let the agent act freely — but force every single
          action through one gate it cannot bypass."
  ALLOW  "Watch it send. The tamper-proof record is written first. The email can't leave
          until that record is sealed. And the credential? The agent never even sees it."
  DENY   "Now the same send. But this time, not approved. The gate stops it. No effect.
          No email. Nothing to undo — because nothing happened."
  CLOSE  "Deny by default. Commit before effect. Credential-blind. And the thing that
          records is never the thing that acts. Agent OS. Autonomy you can actually leave
          running."
  Alt hook (A/B option): "This email was sent by an AI agent — unattended. The story
          isn't that it sent it. It's everything Agent OS forced to happen first."

6 · BEAT SHEET  (reference timing from the measured VO; add the holds in §7 → ~64s total)
  # | beat   | in–out (m:ss) | on-screen                                   | sound
  1 | HOOK   | 0:00–0:05     | real terminal send → real inbox receives    | bed in soft
  2 | STAKES | 0:05–0:18     | 3 risks surface one-at-a-time, as spoken    | low tension
  3 | IDEA   | 0:18–0:27     | diagram resolves: Agent → [gate] → effect   | bed lifts
  4 | ALLOW  | 0:27–0:37     | real trace; [commit] seals BEFORE [effect]; | SEAL thunk +
    |        |               | credential placeholder → [REDACTED]@egress  | 0.8s near-silence
  5 | DENY   | 0:37–0:47     | same trace STOPS at approval; denied (red); | music cut to
    |        |               | no commit, no effect; hold on the stillness | ~0.8s silence
  6 | CLOSE  | 0:47–0:60     | 4 invariants land one-per-phrase → wordmark | bed resolves
    |        |               | + tagline + single CTA "try it yourself →"  |

7 · MOTION DESIGN  (this is where a first attempt fails — "abrupt". Fix precisely.)
  - NO hard scene cuts. Between beats: cross-dissolve or match-cut, 8–14 frames, eased
    (cubic in-out). Carry one element across the cut (motion continuity) where possible.
  - Reveals: each line/item fades + rises ~12px over 6–10 frames, ease-out. It appears
    ~0.2s BEFORE the word that introduces it — never earlier, never all at once, never
    after. Sync to the VO word timings (a transcript with word timestamps is provided).
  - Breathing room: hold the final frame of each beat ~0.5–0.8s before transitioning.
    Never let the visual out-run or lag the narration.
  - Camera: slow, intentional ~3–5% pushes toward the key line (the [commit] seal; the
    denied@approval line). No drift, no gratuitous parallax.
  - The SEAL animation (beat 4): when [commit] fires, a brief ledger-row "locks" (a subtle
    fill sweep + a click of weight), and ONLY THEN does [effect] illuminate. The order must
    read unmistakably as commit → then → effect.

8 · SOUND DESIGN & MUSIC
  - Bed: understated, building electronic/orchestral; serious, never poppy. Ducks under VO.
  - Two emphasis beats: at the SEAL (commit) and at the DENY, drop the bed to near-silence
    for ~0.8s, then resume — let those land.
  - SFX: a soft, weighty "lock/seal" thunk on commit; a single low, final tone on the deny;
    quiet keystroke/terminal texture under the live runs. Nothing cartoonish.
  - VO mixed forward and intelligible at all times.

9 · CAPTIONS · ACCESSIBILITY · LOCALIZATION
  - Provide burned-in-optional captions + a clean SRT. Captions reinforce, not duplicate
    verbatim, the VO. Legible at 9:16 mobile sizes.
  - Color is never the only signal (allowed/denied also carry an icon/label).
  - Build text on its own layer so EN can be swapped for other languages without re-edit.

10 · HARD CONSTRAINTS
  - Real product footage for terminal/browser/inbox/trace (or frame-faithful reconstruction).
  - Honesty: claim nothing the product doesn't do; deploy-gated capabilities, if shown,
    are labeled as such.
  - Redact every secret/PII on screen (test email → ••••••••@gmail.com); never show a real
    credential or token, even briefly.
  - Trace text stays faithful to the order in §2. Commit ALWAYS before effect.

11 · AVOID  (the specific failure modes)
  Abrupt hard cuts between scenes · slideware / "cards with a voiceover" feel · items
  appearing before they're narrated or all at once · logo-first open · marketing fluff and
  hype words ("revolutionary", "seamless", "next-gen", "game-changing") · music that fights
  the VO · walls of text · motion for motion's sake · burying the DENY (it is the climax).

12 · MATERIALS PROVIDED / NEEDED
  Provided: final VO script (above) + a nova-voiced scratch track + word-level SRT; real
    captured cast logs for every trace (ground truth for the on-screen text); brand color
    + type spec (§4).
  Needed from production: real screen capture (or reconstruction) of the runs; licensed
    music; final human VO (or approved AI VO); the seal/deny sound design.

13 · DELIVERABLES & DEFINITION OF DONE
  Deliver: 60–75s master 16:9; 1:1 and 9:16 cuts; SRT; a 6–10s teaser cut from HOOK + DENY;
    an editable project so beats can be re-timed.
  Done when: (a) no transition reads as abrupt; (b) every reveal lands within ±0.15s of its
    VO word; (c) the commit-before-effect order is unmistakable on first viewing; (d) the
    DENY is the emotional peak; (e) a security buyer who watches once, muted, still gets
    "the agent can't bypass it, and it's all on the record."
=====================================================================
```

---

## Cut 2 — Product demo film (2–3 min)

```
=====================================================================
AGENT OS — PRODUCT DEMO FILM · PRODUCTION BRIEF  (cut 2 of 3)
=====================================================================

0 · PROJECT
  A 2–3 min product demo for hands-on evaluators. One feeling: "I see exactly how it
  works, the same gate governs every tool, and I want to run it myself." Master 16:9
  + 9:16 chapters. Inherits the visual system, motion, sound, and constraints of the
  HERO BRIEF v2 (§4, §7–11). This is a walkthrough — heavier on REAL footage than the hero.

1 · STRATEGY & POSITIONING
  Audience: eng leads, platform/security engineers running an evaluation.
  Goal: prove the governed pipeline end-to-end, across MORE than one tool family (API +
    browser, + exec if available), and make the invariants tangible by showing them, not
    asserting them. Lower the perceived integration cost ("it's one gate, every tool").
  Keep the through-line: "Hermes proposes. Agent OS governs."
  Tonal shift vs hero: less fear-framing, more "watch it work." Still calm, exact.

2 · PRODUCT TRUTH
  Inherit HERO BRIEF v2 §2 in full. Add for the demo: the SAME control plane wraps every
  tool family — API actions (gmail/drive/calendar), browser (navigate/read/click/type),
  and exec (argv in a sandbox). The point of the demo is that the gate is family-agnostic.

3 · SEQUENCE  (chaptered; ~2:30; chapter cards with a quiet lower-third label)
  D1 · THESIS (~12s) — recap: an agent acts in the real world; Agent OS governs every move.
  D2 · THE PATH (~22s) — the pipeline on a real send: screen → authorize (policy · egress ·
       approval; deny by default) → reserve budget → commit (sealed) → effect → boundary.
       Highlight each stage on the real trace as it's named.
  D3 · ALLOW: send (~18s) — real gmail send; [commit] seals BEFORE [effect]; the inbox
       receives it. The seal moment gets the §8 sound treatment.
  D4 · CREDENTIAL-BLIND (~16s) — the agent's arg is a placeholder; resolved to [REDACTED]
       only at egress. Show the agent's view vs the egress view side by side.
  D5 · ALLOW: browser + data-out (~22s) — same gate, different family: it navigates only
       allow-listed hosts; the read-back is scrubbed of secrets, length-capped, marked
       untrusted before the agent reads it.
  D6 · DENY across families — THE PROOF (~24s) — remove approval: same send → denied@approval,
       no commit/effect/email. Then a browser call to a non-allow-listed host → denied@policy
       at the network, before the browser moves. "Deny by default isn't a setting; it's the
       default." (This is the demo's headline; give it the §8 near-silence beat.)
  D7 · ATTESTER ≠ ACTOR (~16s) — the record is signed by a SEPARATE process, not the agent,
       not even the part that acts. Cross the process boundary on screen. Nothing that runs
       can forge, rewrite, or restore its own history.
  D8 · ASSURANCE + CTA (~18s) — every build runs the same gate (typecheck · tests ·
       cross-tenant checks · secret-scan) and an independent verifier re-runs it with fresh
       context; ~1,800 tests green. CTA: "Clone it. Run the demo. Then point it at your own
       agent." End on wordmark + repo/quickstart.

4 · VOICEOVER  (near-final; read verbatim; calm, brisk-but-unhurried)
  D1 "An AI agent can act in the real world now — send, browse, run, pay. Agent OS is the
      layer that governs every move it makes. Let's watch it work, across real tools."
  D2 "Every tool call takes the same path. The agent only proposes. Agent OS screens it for
      secrets, checks policy — deny by default — folds in egress and approval, reserves the
      budget, commits a tamper-proof record, and only then runs the effect. Watch the order."
  D3 "Here, it sends an email. The record commits first. The email can't leave until that
      record is sealed."
  D4 "And look at what the agent actually held — a placeholder. The real token is resolved
      at the network egress. Never in the agent. Never in the log."
  D5 "Same gate, a different tool. Now it browses — but only the hosts it's allowed to. And
      whatever it reads back is scrubbed of secrets, length-capped, and marked untrusted,
      before the agent ever sees it."
  D6 "Now take approval away. The same send — stopped at the approval gate. No commit. No
      effect. No email. And a browser call to a host that isn't allow-listed — stopped at
      the network, before the browser even moves. Deny by default isn't a setting. It's the
      default."
  D7 "The record isn't written by the agent — or even by the part of Agent OS that acts. A
      separate process signs it. So nothing that runs can forge its own history, rewrite it,
      or restore it."
  D8 "Every build runs that same gate — types, tests, cross-tenant checks, a secret scan —
      and an independent reviewer re-runs all of it with fresh eyes. Eighteen hundred checks,
      green. Agent OS. Clone it, run the demo, watch the gate — then point it at your own agent."

5 · FOOTAGE  (real-capture priority)
  Use a clean split or picture-in-picture: terminal/trace on one side, the real RESULT on
  the other (inbox for D3, Chromium window for D5, the deny "nothing happened" stillness for
  D6). Real cast logs are the ground truth for every trace line. Chapter cards are the only
  pure motion-graphics moments besides the pipeline diagram in D2.

6 · MOTION · SOUND · CAPTIONS — inherit HERO BRIEF v2 §7, §8, §9. Two near-silence beats:
  the SEAL in D3 and the DENY in D6. Same reveal discipline (each line ~0.2s before its word).

7 · CONSTRAINTS / AVOID — inherit HERO §10–11. Demo-specific: never show two tool families
  with different-looking gates (the whole point is ONE gate); never skip the commit→effect
  order to save time; keep every trace faithful to the real run.

8 · DELIVERABLES & DEFINITION OF DONE
  Deliver: 2–3 min master 16:9; 9:16 chaptered cut for mobile; SRT; chapter markers; an
  editable project. Done when: every chapter earns its place; the "same gate, every tool"
  idea is unmistakable; both DENY shots read as "nothing happened, and it's provable";
  an evaluator finishes wanting to clone the repo.
=====================================================================
```

---

## Cut 3 — Technical / architecture film (5–8 min)

```
=====================================================================
AGENT OS — TECHNICAL / ARCHITECTURE FILM · PRODUCTION BRIEF  (cut 3 of 3)
=====================================================================

0 · PROJECT
  A 5–8 min chaptered technical film for deep diligence. One feeling: "the invariants are
  enforced by the architecture, not by convention — I can defend this to my security team."
  Master 16:9 with visible chapter markers. Inherits HERO BRIEF v2 §4, §7–11 (calmer,
  longer holds; this audience tolerates density). Architecture motion-graphics are welcome
  here; back every claim with real code, trace, or test footage.

1 · STRATEGY & POSITIONING
  Audience: security architects, staff engineers, auditors, technical due-diligence.
  Goal: convince a skeptic that each invariant is structural (process boundaries, fail-
    closed control flow, signed append-only records) — not a flag someone can flip off.
  Register: a security keynote / architecture deep-dive. No hype; precision is the pitch.
  Through-line: "Separate the thinker from the doer — and make the separation enforceable."

2 · PRODUCT TRUTH  (full depth; keep every detail technically faithful)
  Topology: BRAIN (LLM, e.g. Hermes — untrusted, proposes) → SPINE (agent-os — the one
    governed edge; the runGovernedToolCall pipeline) → BODY (execution substrate: OpenShell
    sandbox, real browser) ; and a SEPARATE process: the WORM KERNEL (append-only, hash-
    chained, Ed25519-signed ledger — the attester).
  The pipeline (runGovernedToolCall), in order, consuming injected vendor-neutral seams:
    screen (secret/shape) → authorize (PDP policy + egress + approval + host-fs-write folds;
    deny by default) → cost.reserve → COMMIT (WORM append + await receipt) → effect (guarded
    connector) → cost.commit → boundary (record the crossing). Family-agnostic across exec /
    API actions / browser.
  Components behind neutral ports (swap by config, not rewrite): Hermes = brain · OpenShell
    = execution substrate · NemoClaw = agent hosting · Agentic SpendGuard = cost gate
    (reserve/commit ledger) · AGT = advisory governor (any-deny-wins; can only narrow, never
    grant). The governance core (spine + ledger) imports no vendor — enforced by a dependency
    boundary check.
  Credential model: the brain only ever holds placeholderForKey(KEY) = "openshell:resolve:
    env:<KEY>"; the real secret is resolved ONLY at egress; brain, WORM, and projection see
    only the placeholder. Data-out is gated by a returnContentSanitizer (redact secrets +
    size-bound + mark untrusted).
  Recovery: NO undo by design (effects are real). Forward-only snapshot (WORM-sequence-
    anchored, reference-or-hash-only, credential-blind) + restore (forward-only FSM, attester
    ≠ actor, a verifying-anchor phase cross-validates worm-head + memory-version, fail-closed
    pre-initiated) + replay; a DivergenceReport when live state and snapshot disagree.
  Multi-tenant: cost commits are guarded so a reservation from tenant A can never be committed
    under tenant B (fail-closed); gateway-per-tenant.

3 · CHAPTERS  (~6–7 min; each opens with a titled chapter card + a one-line claim it proves)
  C0 · THREAT MODEL (~45s) — name the adversary: prompt injection, credential exfiltration,
       irreversible effects, repudiation ("who allowed this?"), cross-tenant contamination.
       Frame: guardrails the agent can talk around are not a control plane.
  C1 · ARCHITECTURE (~60s) — Brain / Spine / Body / WORM kernel; the neutral-port seams; the
       composition root wires vendors. Map Hermes/OpenShell/NemoClaw/SpendGuard/AGT to ports.
  C2 · THE GOVERNED PIPELINE (~60s) — walk runGovernedToolCall stage by stage on a real trace;
       show the injected seams and the AuthorizeDecision folds (egress, approval, host-write).
  C3 · INVARIANT 1+2 — DENY-BY-DEFAULT & COMMIT-BEFORE-EFFECT (~75s) — fail-closed control flow
       (unknown/malformed/error ⇒ deny; lives in hooks, never a poller); the WORM append +
       receipt that gates the effect. Show the deny path and the seal-before-effect order in code
       and trace.
  C4 · INVARIANT 3 — CREDENTIAL-BLIND (~50s) — placeholderForKey through the brain/WORM/
       projection; resolution only at egress; the returnContentSanitizer on data-out. Show the
       three views (agent / log / egress) of the same call.
  C5 · INVARIANT 4 — ATTESTER ≠ ACTOR (~60s) — the WORM kernel as a separate signed process;
       append-only hash chain + Ed25519; ingest-side redaction backstop + canonical bytes. Why
       the actor cannot forge, rewrite, or restore its own history. Cross the process boundary.
  C6 · RECOVERY WITHOUT UNDO (~55s) — why there is no undo; forward-only snapshot/restore, admin-
       signed, verifying-anchor cross-validation, DivergenceReport. Recovery is forward, signed,
       and provable — not a rollback the agent could trigger.
  C7 · MULTI-TENANCY & ASSURANCE (~55s) — fail-closed cross-tenant guard; gateway-per-tenant;
       then the verify gate (typecheck · lint · build · test · proto checks · go/py · cross-tenant
       · secret-scan) + the independent fresh-context verifier; ~1,800 tests; no-vendor-in-core
       enforced by the dependency boundary check.
  C8 · CLOSE (~30s) — the trust argument in one line: the agent proposes, a vendor-neutral core
       governs, and a separate signer makes it all provable. Pointers: security model, auditor
       guide, composition-root guide, the SDK.

4 · VOICEOVER — narration INTENT + a key line per chapter (write full VO to these; do not
   pad; let diagrams breathe). Examples of the register:
   C0: "Give an agent the ability to act, and you inherit its worst day: a poisoned page, a
        leaked key, an irreversible action no one can account for. Guardrails it can argue
        with won't save you. You need a control plane it cannot bypass."
   C3: "Deny-by-default isn't a policy you write; it's the shape of the code. Unknown,
        malformed, error — all of them fall through to refuse. And the record commits before
        the effect runs: if the ledger doesn't seal, the action never happens."
   C5: "The part that acts and the part that signs the record are different processes. That's
        the whole game. An actor that cannot reach the signer cannot forge, rewrite, or even
        restore its own history."
   (Provide full VO for C0–C8 in this voice; ~6–7 min total.)

5 · VISUAL  (claim → evidence)
  Each chapter pairs a clean architecture/motion-graphic with the real artifact that proves
  it: source (the pipeline, the placeholder helper, the sanitizer), real traces (allow/deny),
  the kernel's signed chain, the verify run, the dependency-boundary check output. Diagrams
  are schematic and accurate (right boxes, right arrows, right order). Chapter cards + a
  persistent small chapter index aid navigation.

6 · MOTION · SOUND · CAPTIONS — inherit HERO §7–9, but calmer: longer holds, slower pushes,
  a quieter bed (or none under dense code). Captions + SRT mandatory at this length; add a
  chaptered table of contents in the description.

7 · CONSTRAINTS / AVOID — inherit HERO §10–11. Technical-film-specific: technical accuracy is
  non-negotiable — every diagram, trace, and term must match the real system (a wrong arrow
  here loses the whole audience); do not dumb down to the point of inaccuracy; do not claim
  deploy-gated capabilities as shipped (label them).

8 · DELIVERABLES & DEFINITION OF DONE
  Deliver: 5–8 min master 16:9; SRT; chapter markers + TOC; per-chapter clips (for docs/sales
  enablement); editable project. Done when: a security architect can map each invariant to a
  structural mechanism (a process boundary, a fail-closed branch, a signed chain) — not a
  promise; nothing on screen is technically wrong; each chapter stands alone as a clip.
=====================================================================
```

---

*These briefs are the production spec; the live demos they film are real (`pnpm run e2e:live-gmail`,
`e2e:live-browser`, `e2e:gmail-deny-demo`, `e2e:deny-demo`). Keep every on-screen trace faithful to the
actual driver output. The synthetic animatic is a timing reference only — the films are shot against these.*
