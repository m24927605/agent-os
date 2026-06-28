# Agent OS — 影片製作 Brief(繁體中文版)

> 本檔是 [`demo-video-briefs.md`](./demo-video-briefs.md) 的繁體中文版,方便中文團隊/外包廠商使用。
> **慣例:** 策略與製作指示以中文呈現;**待錄製的英文旁白(VO)維持英文原文逐字**——那是要錄的腳本本身,
> 不應翻譯(若需中文配音版,VO 另行翻譯重錄)。技術名詞與 code 識別字(如 `commit-before-effect`、
> `runGovernedToolCall`、`placeholderForKey`、WORM kernel、Ed25519)保留原文。
>
> **配套文件:** [`demo-video-script.md`](./demo-video-script.md)(資產清單 + live 腳本的*真實*畫面文字)
> 與朗讀用的 [`demo-recording-cut-sheet.md`](./demo-recording-cut-sheet.md)。畫面上每一條 trace 的 ground truth
> = 真實 cast logs(`scripts/act-live-gmail.mjs`、`scripts/act5-live-browser.mjs` 及 deny runners)。

## 三件套策略

一個產品、三種受眾、三種任務。**不要**讓一支影片同時做三件事。

| 影片 | 長度 | 受眾 | 任務 |
|-----|------|------|------|
| **Hero** | 60–75s | 漏斗頂端:CISO / AI 負責人 / 高管 | 搶下注意力;唯一感受:「**這種自主性我敢放著讓它跑**」。**「拒絕」是高潮**。不講架構。 |
| **產品 Demo** | 2–3 分 | 動手評估者(工程 / 平台 / 資安) | 端到端展示 governed pipeline、**同一道閘治理每一種工具**;讓他們想 clone 來跑。 |
| **技術 / 架構** | 5–8 分 | 資安架構師、稽核、深度盡調 | 證明每個不變量是**結構性**的(行程邊界、fail-closed 控制流、簽章 append-only 鏈)——能對資安團隊辯護。 |

三支共用 through-line:**「Hermes proposes. Agent OS governs.」** Tagline:**「Autonomy you can actually leave running.」**

## 共用規範(繼承)

**Demo** 與 **技術版** brief 繼承 **Hero** brief 的視覺系統(§4)、動態設計(§7)、聲音設計(§8)、字幕(§9)
與硬性拘束(§10–11)。下層 brief 只描述**差異處**。配色、字體、兩個強調節點(ledger **seal** 與 **deny**)、
浮現紀律(每個項目在被唸到的字**前 ~0.2s** 才出現)三支保持一致。

## 誠實狀態 — 現有什麼 vs 這些 brief 的用途

目前存在一支**合成 animatic**(終端機風格渲染卡片 + AI「nova」scratch VO + 逐字對齊浮現、A/V 已同步),
作為**預覽片 / 時間軸參考**。它**不是**企業級成片。這些 brief 描述的製作步驟需要:**真實螢幕 footage**
(terminal / 瀏覽器 / 信箱 / trace)、**授權音樂 + 聲音設計**、**最終 VO**。把 animatic 當剪輯/時間軸參考,
真正的片子照這些 brief 拍。

---

## Cut 1 — Hero 片(60–75s)

```
=====================================================================
AGENT OS — HERO 產品片 · 製作 BRIEF v2
=====================================================================

0 · 專案
  一支 60–75s 企業級 Hero 片。要讓觀眾留下的唯一感受:
  「這裡我可以讓 AI agent 自己行動 —— 而且每一步都能信任、能證明、能稽核。」
  主檔 16:9,另出 1:1 與 9:16。30fps(若調色需要可接受 24)。
  這是一支電影感產品片,不是投影片,也不是「螢幕錄影硬配旁白」。

1 · 策略與定位
  受眾:CISO、AI/平台工程負責人、資安架構師,正在評估是否要讓 agent 真的去做動作
    (寄信、付款、瀏覽、執行)而不在每個動作都放一個人把關。
  他們的恐懼:被劫持或幻覺的 agent 做了不可逆的事、洩漏交給它的憑證、或行動後
    沒有可證明「誰允許的」的記錄。
  競品框架(暗示,不要明貶):替代方案是 (a) 每個動作都要人批准 —— 不可規模化,或
    (b) agent 可以「講道理繞過」的 guardrails。Agent OS 是一道 agent 「無法繞過」的控制面。
  唯一的概念:把「思考者」與「執行者」分開。brain 提議;OS 治理。
  Through-line(全片骨幹):"Hermes proposes. Agent OS governs."
  Tagline(片尾):"Autonomy you can actually leave running."

2 · 產品真相(準確;不可誇大;若為重建鏡頭,仍須技術上忠實)
  Agent OS = 介於 LLM「brain」與真實世界之間的治理層。agent 只「提議」一個 tool call;
  Agent OS 先 screen、authorize、記錄,然後才執行。四個不變量「就是」產品:
    1. Deny by default —— 未知 / 格式錯誤 / 出錯 ⇒ 拒絕。
    2. Commit before effect —— 一筆 append-only、防竄改的記錄在動作執行「之前」封存。
       記錄若失敗,effect 永不發生。設計上無 undo。
    3. Credential-blind —— agent 只看得到 placeholder("resolve:env:<KEY>");真正的 secret
       在 network egress 才解析,絕不進 agent、絕不進任何 log。
    4. Attester ≠ actor —— 簽記錄的行程與執行動作的行程「分離」,所以 agent 無法偽造、
       改寫或還原自己的歷史。
  Governed path(trace 文字須忠實,依此順序):
    screen → authorize(policy · egress · approval;deny by default)→ commit(記錄封存)
    → effect → boundary。
  元件(只有較長的版本需要;Hero 不需要):
    Hermes = brain(提議)· OpenShell = execution substrate(sandbox)· NemoClaw = agent
    hosting · Agentic SpendGuard = cost gate(reserve/commit 預算)· AGT = advisory governor
    (只能收緊決策,不能放行)。全部在 neutral port 後可替換;治理核心(spine + 防竄改
    ledger)為 vendor-neutral。

3 · 參考 / 氛圍(對齊這個調性,不要照抄)
  Apple 隱私廣告的沉穩權威;Linear、Stripe 發表片的克制與產品優先剪輯;Vanta / Vercel
  那種「正經基礎設施」感。要:自信、安靜、精確。比起廣告,更接近一場資安 keynote。

4 · 調性與視覺系統
  調性:沉穩、自信、創辦人般可信。電影感的克制。讓沉默發揮作用。
  配色:近黑底 #0a0e14;柔和 slate 文字 #cdd6f4;語意色 —— 綠 #a6e3a1 = 允許/封存,
    紅 #f38ba8 = 拒絕,琥珀 #fab387 = 憑證,藍 #89b4fa = 系統/階段標籤。色彩節制使用,
    當作「意義」而非裝飾。
  字體:標題用乾淨的 grotesk(如 Inter/Suisse);終端機/trace 用清晰等寬(如 SF Mono/
    JetBrains Mono)。留白充足;永不塞滿畫面。
  Footage 政策:PROOF 節點(hook 寄信、allow trace、deny trace、信箱、憑證 egress)「必須」
    用真實產品擷取或逐幀忠實的重建。風格化動態圖文「只允許」用於概念圖與片尾不變量。

5 · 旁白 VO(最終文案 —— 逐字朗讀;溫暖、沉穩,約 60s)
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
  Alt hook(A/B 備選):"This email was sent by an AI agent — unattended. The story
          isn't that it sent it. It's everything Agent OS forced to happen first."

6 · BEAT SHEET(時間參考自實測 VO;加上 §7 的留白後 → 約 64s)
  # | 節點   | in–out (m:ss) | 畫面                                        | 聲音
  1 | HOOK   | 0:00–0:05     | 真實終端機寄信 → 真實信箱收到                | 音樂床輕入
  2 | STAKES | 0:05–0:18     | 3 個風險逐一浮現,各自在被唸到時             | 低張力
  3 | IDEA   | 0:18–0:27     | 圖解收斂:Agent → [gate] → effect            | 音樂床上揚
  4 | ALLOW  | 0:27–0:37     | 真實 trace;[commit] 在 [effect] 之前封存;   | SEAL thunk +
    |        |               | 憑證 placeholder → [REDACTED]@egress         | 0.8s 近靜音
  5 | DENY   | 0:37–0:47     | 同一 trace 停在 approval;denied(紅);       | 音樂切到
    |        |               | 無 commit、無 effect;停在那份「靜止」        | ~0.8s 靜音
  6 | CLOSE  | 0:47–0:60     | 四不變量逐句落定 → wordmark + tagline +      | 音樂床收束
    |        |               | 單一 CTA "try it yourself →"                 |

7 · 動態設計(這是初版失敗之處 —— 「唐突」。精準修正。)
  - 場景之間「不要」硬切。用 match cut 或交叉溶接,8–14 幀,緩動(cubic in-out)。
    可能時讓一個元素跨越剪接點延續(motion continuity)。
  - 浮現:每行/項目淡入 + 上移約 12px,6–10 幀,ease-out。它在引介它的那個字「前 ~0.2s」
    出現 —— 不更早、不一次全出、不更晚。對齊 VO 逐字時間(已提供含逐字時間戳的 transcript)。
  - 留白:每個節點末尾停住最後一幀約 0.5–0.8s 再轉場。絕不讓畫面超前或落後旁白。
  - 鏡頭:緩慢、有意圖地向關鍵行推進約 3–5%([commit] 封存那行;denied@approval 那行)。
    不漂移、不無謂視差。
  - SEAL 動畫(節點 4):[commit] 觸發時,一個 ledger row「鎖定」(細微填色掃過 + 一記
    分量感的「咔」),「然後才」點亮 [effect]。順序必須一眼讀成 commit → 然後 → effect。

8 · 聲音設計與音樂
  - 音樂床:低調、漸強的電子/管弦;正經,絕不浮誇。在 VO 下方 duck。
  - 兩個強調節點:在 SEAL(commit)與 DENY,把音樂床降到近靜音約 0.8s 再恢復 —— 讓它們落定。
  - SFX:commit 時一記柔軟、有分量的「lock/seal」thunk;deny 時一記低沉、終局的單音;
    live run 下方輕微的鍵盤/終端機質感。不要卡通化。
  - VO 全程混音靠前、清晰。

9 · 字幕 · 無障礙 · 在地化
  - 提供(可選燒錄的)字幕 + 乾淨 SRT。字幕「強化」而非逐字複述 VO。在 9:16 行動尺寸下清晰。
  - 顏色絕不是唯一訊號(allowed/denied 另帶 icon/標籤)。
  - 文字放在獨立圖層,讓 EN 可換成其他語言而不必重剪。

10 · 硬性拘束
  - terminal/瀏覽器/信箱/trace 用真實產品 footage(或逐幀忠實重建)。
  - 誠實:不主張產品做不到的事;若展示 deploy-gated 能力,須標明。
  - 畫面上所有 secret/PII 打碼(測試 email → ••••••••@gmail.com);絕不顯示真實憑證或 token,
    即使一瞬間也不行。
  - trace 文字忠於 §2 的順序。commit「永遠」在 effect 之前。

11 · 避免(具體失敗模式)
  場景間硬切而唐突 · 投影片/「卡片配旁白」感 · 項目在被唸到前或一次全出 · logo 開場 ·
  行銷空話與 hype 字眼("revolutionary"、"seamless"、"next-gen"、"game-changing")·
  與 VO 打架的音樂 · 文字牆 · 為動而動 · 把 DENY 埋掉(它就是高潮)。

12 · 提供物 / 所需物
  提供:最終 VO 文案(如上)+ nova 配的 scratch track + 逐字 SRT;每條 trace 的真實
    cast logs(畫面文字的 ground truth);品牌配色 + 字體規範(§4)。
  製作端所需:真實螢幕擷取(或重建);授權音樂;最終真人 VO(或核可的 AI VO);
    seal/deny 的聲音設計。

13 · 交付物與驗收標準(Definition of Done)
  交付:60–75s 主檔 16:9;1:1 與 9:16 版;SRT;從 HOOK + DENY 剪出的 6–10s teaser;
    可重新調時間軸的可編輯專案。
  完成條件:(a) 沒有任何轉場讀起來唐突;(b) 每個浮現落在其 VO 字的 ±0.15s 內;
    (c) commit-before-effect 的順序第一次看就一目了然;(d) DENY 是情緒高點;
    (e) 一個資安買家靜音看一次,仍能 get「agent 無法繞過它,而且全程有記錄」。
=====================================================================
```

---

## Cut 2 — 產品 Demo 片(2–3 分)

```
=====================================================================
AGENT OS — 產品 DEMO 片 · 製作 BRIEF(三支之二)
=====================================================================

0 · 專案
  一支 2–3 分的產品 demo,給動手評估者。唯一感受:「我看得到它到底怎麼運作,同一道閘
  治理每一種工具,而且我想自己跑跑看。」主檔 16:9 + 9:16 章節版。繼承 HERO BRIEF v2 的
  視覺系統、動態、聲音與拘束(§4、§7–11)。這是走查 —— 比 Hero 更倚重「真實 footage」。

1 · 策略與定位
  受眾:工程主管、平台/資安工程師,正在做評估。
  目標:端到端證明 governed pipeline,並跨「不只一種」工具家族(API + 瀏覽器,有的話 + exec),
    用「展示」而非「斷言」讓不變量變得具體。降低被感知的整合成本(「就一道閘,每種工具都一樣」)。
  維持 through-line:"Hermes proposes. Agent OS governs."
  與 Hero 的調性差異:少一點恐懼框架,多一點「看它運作」。仍然沉穩、精確。

2 · 產品真相
  完整繼承 HERO BRIEF v2 §2。Demo 額外強調:同一套控制面包住「每一種」工具家族 ——
  API actions(gmail/drive/calendar)、瀏覽器(navigate/read/click/type)、與 exec(sandbox 內的 argv)。
  demo 的重點就是這道閘「與工具家族無關」。

3 · 序列(章節化;約 2:30;章節卡配安靜的 lower-third 標籤)
  D1 · THESIS(~12s)—— 重述:agent 在真實世界行動;Agent OS 治理它的每一步。
  D2 · THE PATH(~22s)—— 在一次真實寄信上走 pipeline:screen → authorize(policy · egress ·
       approval;deny by default)→ reserve budget → commit(封存)→ effect → boundary。
       每個階段被唸到時在真實 trace 上 highlight。
  D3 · ALLOW: 寄信(~18s)—— 真實 gmail 寄信;[commit] 在 [effect] 之前封存;信箱收到。
       封存那一刻套用 §8 的聲音處理。
  D4 · CREDENTIAL-BLIND(~16s)—— agent 的參數是 placeholder;只在 egress 解析成 [REDACTED]。
       並排顯示 agent 的視角 vs egress 的視角。
  D5 · ALLOW: 瀏覽器 + data-out(~22s)—— 同一道閘、不同家族:只導航 allow-list 內的 host;
       讀回的內容在 agent 讀到「之前」已被 scrub 掉 secret、長度上限、標記 untrusted。
  D6 · 跨家族的 DENY —— THE PROOF(~24s)—— 拿掉 approval:同一次寄信 → denied@approval,
       無 commit/effect/email。再一個瀏覽器呼叫到 non-allow-list host → denied@policy 在網路層,
       瀏覽器還沒動就被擋。"Deny by default isn't a setting; it's the default." 這是 demo 的
       headline;給它 §8 的近靜音節點。
  D7 · ATTESTER ≠ ACTOR(~16s)—— 記錄由「另一個行程」簽署,不是 agent,甚至不是執行的那部分。
       畫面上跨過行程邊界。任何在跑的東西都無法偽造、改寫或還原自己的歷史。
  D8 · ASSURANCE + CTA(~18s)—— 每次 build 都跑同一道閘(typecheck · tests · cross-tenant
       checks · secret-scan),且獨立 verifier 以全新 context 重跑;約 1,800 測試全綠。
       CTA:"Clone it. Run the demo. Then point it at your own agent." 收在 wordmark + repo/quickstart。

4 · 旁白 VO(近最終;逐字朗讀;沉穩、明快但不趕)
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

5 · FOOTAGE(真實擷取優先)
  用乾淨的分割或子母畫面:一邊 terminal/trace,另一邊真實「結果」(D3 信箱、D5 Chromium 視窗、
  D6 那份「什麼都沒發生」的靜止)。真實 cast logs 是每條 trace 行的 ground truth。除了 D2 的
  pipeline 圖,章節卡是僅有的純動態圖文時刻。

6 · 動態 · 聲音 · 字幕 —— 繼承 HERO BRIEF v2 §7、§8、§9。兩個近靜音節點:D3 的 SEAL 與 D6 的 DENY。
  同樣的浮現紀律(每行在其字「前 ~0.2s」)。

7 · 拘束 / 避免 —— 繼承 HERO §10–11。Demo 專屬:絕不讓兩種工具家族的閘「長得不一樣」(重點就是
  ONE gate);絕不為了省時間跳過 commit→effect 順序;每條 trace 忠於真實 run。

8 · 交付物與 Definition of Done
  交付:2–3 分主檔 16:9;行動用 9:16 章節版;SRT;章節標記;可編輯專案。
  完成條件:每個章節都站得住腳;「同一道閘、每種工具」一目了然;兩個 DENY 鏡頭都讀成
  「什麼都沒發生,而且可證明」;評估者看完想 clone repo。
=====================================================================
```

---

## Cut 3 — 技術 / 架構片(5–8 分)

```
=====================================================================
AGENT OS — 技術 / 架構片 · 製作 BRIEF(三支之三)
=====================================================================

0 · 專案
  一支 5–8 分、章節化的技術片,給深度盡調用。唯一感受:「這些不變量是被架構強制的,不是
  靠慣例 —— 我能對我的資安團隊辯護。」主檔 16:9,含可見章節標記。繼承 HERO BRIEF v2 §4、
  §7–11(更沉、停留更久;這個受眾受得了密度)。這裡歡迎架構動態圖文;每個主張都用真實
  code、trace 或測試 footage 佐證。

1 · 策略與定位
  受眾:資安架構師、staff 工程師、稽核、技術盡調。
  目標:說服一個懷疑者 —— 每個不變量都是結構性的(行程邊界、fail-closed 控制流、簽章
    append-only 記錄)—— 不是某人可以關掉的開關。
  調性:資安 keynote / 架構 deep-dive。不浮誇;精確就是賣點。
  Through-line:"Separate the thinker from the doer — and make the separation enforceable."

2 · 產品真相(完整深度;每個細節技術上忠實)
  拓撲:BRAIN(LLM,如 Hermes —— untrusted,提議)→ SPINE(agent-os —— 唯一的 governed edge;
    runGovernedToolCall pipeline)→ BODY(execution substrate:OpenShell sandbox、真實瀏覽器);
    另有一個「獨立行程」:WORM KERNEL(append-only、hash-chained、Ed25519 簽章的 ledger —— attester)。
  Pipeline(runGovernedToolCall),依序,消費注入的 vendor-neutral seams:
    screen(secret/shape)→ authorize(PDP policy + egress + approval + host-fs-write folds;
    deny by default)→ cost.reserve → COMMIT(WORM append + 等 receipt)→ effect(guarded
    connector)→ cost.commit → boundary(記錄越界)。跨 exec / API actions / 瀏覽器皆同。
  Neutral port 後的元件(用 config 替換,非重寫):Hermes = brain · OpenShell = execution
    substrate · NemoClaw = agent hosting · Agentic SpendGuard = cost gate(reserve/commit ledger)
    · AGT = advisory governor(any-deny-wins;只能收緊,不能放行)。治理核心(spine + ledger)
    不 import 任何 vendor —— 由 dependency boundary check 強制。
  憑證模型:brain 永遠只持有 placeholderForKey(KEY) = "openshell:resolve:env:<KEY>";真正的
    secret「只」在 egress 解析;brain、WORM、projection 都只看到 placeholder。data-out 由
    returnContentSanitizer 把關(redact secrets + size-bound + 標記 untrusted)。
  復原:設計上「無 undo」(effect 是真的)。Forward-only snapshot(錨定 WORM sequence、
    reference-or-hash-only、credential-blind)+ restore(forward-only FSM、attester ≠ actor、
    一個 verifying-anchor 階段交叉驗證 worm-head + memory-version、pre-initiated 階段 fail-closed)
    + replay;當 live state 與 snapshot 不一致時產生 DivergenceReport。
  多租戶:cost commit 受保護,使 tenant A 的 reservation 永遠不能在 tenant B 名下 commit
    (fail-closed);gateway-per-tenant。

3 · 章節(約 6–7 分;每章開場一張標題章節卡 + 一句「它要證明的主張」)
  C0 · 威脅模型(~45s)—— 點名對手:prompt injection、憑證外洩、不可逆 effect、抵賴
       (「誰允許的?」)、跨租戶污染。框架:agent 能講道理繞過的 guardrails 不是控制面。
  C1 · 架構(~60s)—— Brain / Spine / Body / WORM kernel;neutral-port seams;composition root
       接 vendor。把 Hermes/OpenShell/NemoClaw/SpendGuard/AGT 對應到 port。
  C2 · GOVERNED PIPELINE(~60s)—— 在真實 trace 上逐階段走 runGovernedToolCall;展示注入的
       seams 與 AuthorizeDecision folds(egress、approval、host-write)。
  C3 · 不變量 1+2 —— DENY-BY-DEFAULT & COMMIT-BEFORE-EFFECT(~75s)—— fail-closed 控制流
       (未知/格式錯誤/出錯 ⇒ deny;活在 hooks,絕不在 poller);WORM append + receipt 把關 effect。
       在 code 與 trace 上展示 deny path 與 seal-before-effect 順序。
  C4 · 不變量 3 —— CREDENTIAL-BLIND(~50s)—— placeholderForKey 流經 brain/WORM/projection;
       只在 egress 解析;data-out 的 returnContentSanitizer。展示同一 call 的三種視角(agent / log / egress)。
  C5 · 不變量 4 —— ATTESTER ≠ ACTOR(~60s)—— WORM kernel 作為獨立簽章行程;append-only hash chain
       + Ed25519;ingest 端 redaction 後盾 + canonical bytes。為何 actor 無法偽造、改寫或還原自己的
       歷史。跨過行程邊界。
  C6 · 無 UNDO 的復原(~55s)—— 為何沒有 undo;forward-only snapshot/restore、admin-signed、
       verifying-anchor 交叉驗證、DivergenceReport。復原是 forward、簽章、可證明的 —— 不是 agent
       能觸發的 rollback。
  C7 · 多租戶與 ASSURANCE(~55s)—— fail-closed 跨租戶 guard;gateway-per-tenant;接著 verify gate
       (typecheck · lint · build · test · proto checks · go/py · cross-tenant · secret-scan)+ 獨立
       fresh-context verifier;約 1,800 測試;no-vendor-in-core 由 dependency boundary check 強制。
  C8 · 收尾(~30s)—— 一句話的信任論證:agent 提議、vendor-neutral core 治理、獨立簽署者讓一切
       可證明。指引:security model、auditor guide、composition-root guide、SDK。

4 · 旁白 VO(完整文案 —— 逐字朗讀;沉穩、精確、資安 keynote 調性;章節間讓圖解呼吸;約 7–8 分)
  C0 · 威脅模型
   "Give an AI agent the power to act — to send, to pay, to run commands, to browse — and
    you inherit its worst day. A single poisoned web page can turn it against you. It can
    leak a credential you handed it. It can do something that cannot be undone, and leave no
    trustworthy record of what happened, or who allowed it. In a multi-tenant system, one
    tenant's agent must never reach another's. Guardrails an agent can argue its way around
    are not a control plane. You need a layer it cannot bypass. That is the whole design of
    Agent OS."
  C1 · 架構
   "Agent OS separates the thinker from the doer. The brain — an LLM, here Hermes — only
    proposes a tool call; it is treated as untrusted. Between the brain and the real world
    sits the spine: agent-os, the one governed edge every action must pass through. The body
    is where effects run — a sandboxed substrate, or a real browser. And in its own process
    sits the WORM kernel: an append-only, hash-chained, signed ledger — the attester.
    Everything except the spine and the ledger is a vendor behind a neutral port: Hermes the
    brain, OpenShell the execution substrate, NemoClaw the hosting, SpendGuard the cost gate,
    AGT an advisory governor that can only narrow a decision, never grant one. The
    composition root wires them. The core imports no vendor — and a dependency check enforces
    it. Swap any vendor by config, not a rewrite."
  C2 · GOVERNED PIPELINE
   "Here is the path every tool call takes — one function, the same for every kind of action.
    Screen: check the call for secrets and shape. Authorize: the policy decision point
    evaluates it, deny by default, folding in the egress allow-list, the approval requirement,
    and any host filesystem write. Reserve the budget. Then the pivot — commit: append a
    record to the WORM ledger and wait for the receipt. Only after the record is sealed does
    the effect run, through a guarded connector. Then commit the cost, and record the boundary
    crossing. Every stage is an injected, vendor-neutral seam. The same pipeline governs an
    exec command, a Gmail send, and a browser navigation. There is no second path, no fast
    lane, no exception."
  C3 · DENY-BY-DEFAULT & COMMIT-BEFORE-EFFECT
   "The first two invariants live in the shape of the code, not in a setting. Deny by default:
    an unknown tool, a malformed request, an error anywhere in the decision — all fall through
    to refuse. No path lets uncertainty resolve to 'allow.' And the decision lives in the
    request path itself, in the gate — never in a background poller that could lag or fail
    open. Commit before effect: the record is written first. The pipeline appends to the
    tamper-proof ledger and waits for the receipt before the connector is ever touched. If the
    ledger does not seal, the effect never runs. Watch a real trace. Allowed: commit, then
    effect, in that order, every time. Denied — a send that wasn't approved — the trace stops
    at the gate. No commit, no effect; the connector is never reached. Nothing to catch after
    the fact, because nothing happened. And nothing to undo, because the effect, by design,
    has none."
  C4 · CREDENTIAL-BLIND
   "The third invariant: the agent never touches a secret. When the brain proposes a call that
    needs a credential, all it holds is a placeholder — resolve, env, key-name. That
    placeholder is what flows through the brain, into the record, into any projection of state.
    The real token is resolved at the last moment, at the network egress, and nowhere else.
    See the same call three ways: in the agent's request, a placeholder; in the audit log, a
    placeholder, redacted; only on the wire, at egress, the real value — then gone. Data coming
    back is governed too: whatever a page returns is scrubbed of secrets, length-capped, and
    marked untrusted before the agent is ever allowed to read it."
  C5 · ATTESTER ≠ ACTOR
   "This is the heart of it. The thing that acts and the thing that signs the record are
    different processes. The WORM kernel runs on its own — an append-only chain, each entry
    hashed onto the last and signed with a key the actor never holds. Records are redacted on
    ingest, before they're hashed, so a secret cannot slip into the chain. Because the actor
    cannot reach the signer, it cannot forge a record, it cannot rewrite history, and — this
    matters — it cannot restore its own past. A compromised agent cannot quietly erase what it
    did, because the evidence is produced by a process it does not control and cannot
    impersonate. Attestation is structurally separated from action. That separation is what
    makes the record trustworthy to an auditor who trusts neither the agent nor the operator."
  C6 · 無 UNDO 的復原
   "A fair question: with no undo, how do you recover? Forward-only. Effects are real — an
    email sent cannot be unsent — so Agent OS refuses to pretend otherwise. Recovery is a
    signed, forward operation. A snapshot is a cut of state, anchored to a point in the WORM
    sequence, holding references and hashes, never raw credentials. A restore is a forward-only
    state machine, run by a separate authority — attester is not actor here either — with a
    verifying phase that cross-validates the ledger head and the memory version, and fails
    closed if they disagree. When live state and a snapshot diverge, you get a divergence
    report, not a silent overwrite. Recovery is something an operator proves and signs — never
    a rollback the agent could trigger to cover its tracks."
  C7 · 多租戶與 ASSURANCE
   "Two more guarantees. Isolation: a budget reserved by one tenant can never be committed
    under another — the cost path checks it and fails closed — and each tenant gets its own
    gateway. And assurance — how you know any of this holds. Every build runs one gate:
    type-check, lint, build, the full test suite, the protocol checks, the Go and Python
    planes, a cross-tenant isolation check, and a secret scan. Its exit code is the only
    accepted proof that it works. On top, an independent verifier re-runs everything with fresh
    context and adversarially probes the invariants before a change is called done. Around
    eighteen hundred tests, green. And the rule that the core imports no vendor isn't a
    guideline — a dependency boundary check fails the build if it's broken."
  C8 · 收尾
   "So the trust argument, in one line. The agent proposes. A vendor-neutral core governs
    every action through one gate it cannot bypass. A separate process signs the record, so
    everything is provable — even against the agent itself. Deny by default. Commit before
    effect. Credential-blind. The recorder is never the actor. To verify it yourself, start
    with the security model, the auditor guide, and the SDK. Agent OS — autonomy you can
    actually leave running."

5 · 視覺(主張 → 證據)
  每章把一張乾淨的架構/動態圖文,配上證明它的真實 artifact:source(pipeline、placeholder helper、
  sanitizer)、真實 traces(allow/deny)、kernel 的簽章鏈、verify run、dependency-boundary check 輸出。
  圖解是示意且準確的(對的方塊、對的箭頭、對的順序)。章節卡 + 常駐的小章節索引輔助導覽。

6 · 動態 · 聲音 · 字幕 —— 繼承 HERO §7–9,但更沉:停留更久、推進更慢、音樂床更安靜(密集 code 下
  可無音樂)。此長度下字幕 + SRT 必備;在說明欄加章節化目錄。

7 · 拘束 / 避免 —— 繼承 HERO §10–11。技術片專屬:技術準確不可妥協 —— 每個圖解、trace、術語都必須
  對齊真實系統(這裡一個錯箭頭就失去整個受眾);不要為了簡化而失準;不要把 deploy-gated 能力講成
  已出貨(要標明)。

8 · 交付物與 Definition of Done
  交付:5–8 分主檔 16:9;SRT;章節標記 + TOC;各章節 clip(供 docs/sales enablement);可編輯專案。
  完成條件:資安架構師能把每個不變量對應到一個結構性機制(一道行程邊界、一個 fail-closed 分支、
  一條簽章鏈)—— 而非一句承諾;畫面上沒有任何技術錯誤;每章都能單獨當作 clip。
=====================================================================
```

---

*這些 brief 是製作規格;它們所拍的 live demo 是真的(`pnpm run e2e:live-gmail`、`e2e:live-browser`、
`e2e:gmail-deny-demo`、`e2e:deny-demo`)。畫面上每條 trace 都要忠於實際 driver 輸出。合成 animatic 只是
時間軸參考 —— 真正的片子照這些 brief 拍。英文原版:[`demo-video-briefs.md`](./demo-video-briefs.md)。*
