# SLICE-PHASE ACT5: Browser sub-family（有狀態、多步、螢幕驅動的 governed UI binding)

- **Phase**: ActionBinding — Slice 5（瀏覽器:distinct sub-port,sharing the governed pipeline)
- **狀態**: **PHASE SPEC（docs-first;待核准逐 slice 開工)**
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>(逐 slice)

## (0) 為何是 distinct sub-family(不是 ActionBinding 的又一個 method)
ActionBinding(ACT1-4)的核心不變量:「brain 提議 → composer 把 validated params 在**單一處**組成一個 PURE、inspectable 的 effect descriptor `{service,method,params}`」。**瀏覽器打破它**:
- 一個瀏覽器「任務」是**一連串 UI 互動**,且**下一步取決於上一步渲染出什麼**(click 哪裡要先看到頁面)——下一步的 params 在提議時**還不知道**。
- 強塞進單一 descriptor 只有兩條爛路:(a) free-form script(等於替 DOM 開一個 `sh -c`,把 argv-exec 禁掉的注入面重新引入);(b) 每步 re-entry。**選 (b)**。
- 所以:**每個瀏覽器原語(navigate/read/click/type)各自是一個 strict-schema、帶 projector 的 governed action,各自 re-enter `runGovernedToolCall`**。一個瀏覽器任務 = 一串「逐步受治理」的 action,各自 screen→authorize→commit-before-effect→effect→boundary。

## (1) 設計
### 1a. `BrowserActionBinding` sub-port(distinct;sharing pipeline)
- 原語(各自 strict argSchema、各自 `governanceProjector`):
  - **`browser.navigate {sessionId, url}`** — 導航(網路 egress)。
  - **`browser.read {sessionId, selector?}`** — 讀螢幕/抽取內容(⚠️ 回傳內容給 brain — 見 §2 風險)。
  - **`browser.click {sessionId, selector}`** — 點擊(可觸發不可逆 UI 效果)。
  - **`browser.type {sessionId, selector, text}`** — 輸入(text 可為憑證 placeholder)。
  - **`browser.session.open {}` / `browser.session.close {sessionId}`** — session 生命週期。
- **session 是 server-held**:brain 只持有 `sessionId`(不透明 handle reference),**絕不持有 raw 瀏覽器 handle**。session 由 governed connector 開/關;handle、cookies、頁面狀態都在 actor 側(沙盒瀏覽器),brain 看不到。
### 1b. `BrowserConnector` port(actor)
- `BrowserConnector { perform(context, step: {sessionId, primitive, params}): MaybePromise<BrowserStepResult> }`。
- `FakeBrowserConnector`(in-repo:記步驟、回 canned screen-state)+ 真連接器(沙盒 headless Chromium,parallel to OpenShell exec sandbox — **deploy-gated**)。
### 1c. 治理映射(重用既有 gate,pipeline 零改)
- **containment / egress**:`browser.navigate` = `network-egress`;其 host **brain-supplied**(非 composer-fixed,像 net.fetch 不像 gmail)→ projector 抽 `new URL(url).hostname` → **egress fold per-navigation**(deny-all default;brain 只能導到 allowlist 內 host)。url 經 net.fetch 同款 `isAllowedFetchUrl`。
- **sideEffect / approval**:`navigate`/`read` = read(egress/讀);**`click`/`type` = destructive(UI 動作效果不透明,可 submit/delete)→ superRefine 強制 requiresApproval → per-step approval**。
- **commit-before-effect**:每步意圖先進 WORM 再執行 → session 的不可竄改逐步 trace。
- **boundary**:每個 external 步(navigate、會送出的 click)→ boundary event。
- **credential-blind**:`browser.type` 的 text 若是憑證 → placeholder,egress(瀏覽器)解析,brain 不見;**`browser.read` 回傳內容 = 新外洩面,見 §2**。
- **advertise**:對 brain 暴露瀏覽器 = ACT4 同款 **deny-by-default**(`AGENTOS_ADVERTISE_BROWSER`,off → 不暴露)。

## (2) ⚠️ 比 API action 更難/更危險的新面（spec 重點)
1. **screen-state-return 外洩(最大新風險)**:`browser.read` 把**頁面內容回傳給不可信 brain**。頁面可能含 secret/PII/別人的資料 → 被 prompt-injected 的 brain 可被誘導「讀一個機密頁面再外洩」。這是 ActionBinding 沒有的**資料出口通道**。**需治理答案**(open-q):回傳什麼?(redact / 內容大小上限 / content-egress allowlist / 只回結構不回原文 / 標記 untrusted)。
2. **dynamic per-navigation egress**:host 是 brain 提供的(每次 navigate 不同),非 composer-fixed → egress allowlist 必須 per-navigation 把關(deny-all default;只允許明確 allowlist 的 host)。
3. **click/type 效果不透明**:一個 click 可能做任何不可逆的事(submit 表單、刪帳號)。projector 看不出「這個 selector 點下去會幹嘛」→ 只能靠 per-step approval + 沙盒隔離 + WORM 記錄,**不能事前完備預測**(誠實標)。
4. **session 狀態**:跨步持久的 handle/cookies/登入態(exec/API 是無狀態單發)→ session 生命週期、所有權、逾時、誰能 resume 都要治理。
5. **真瀏覽器 substrate**:沙盒 headless 瀏覽器(parallel to OpenShell exec sandbox)= deploy fact;in-repo 只能 fake-prove port + 契約。

## (3) Slice 計畫（逐刀,各自 RED + 獨立 Opus 4.8 review)
- **ACT5a [NOW-buildable]**:`BrowserActionBinding` sub-port + `BrowserConnector` port + `FakeBrowserConnector` + session 模型(server-held sessionId)+ **`browser.navigate`**(egress-gated,brain-url 經 isAllowedFetchUrl)+ 過 REAL `runGovernedToolCall` 的 join(fake browser)。證:deny-by-default、egress per-navigation、commit-before-effect、boundary、session handle 不外露。
- **ACT5b [NOW-buildable,但需 open-q#1 決策]**:**`browser.read`** + **screen-state-return 治理**(回傳內容的 redact/bound/policy)。這是最關鍵的安全 slice。
- **ACT5c [NOW-buildable]**:**`browser.click`/`browser.type`**(destructive→approval;type-credential-placeholder,credential-blind)。
- **ACT5d [DEPLOY-GATED]**:真沙盒瀏覽器 substrate + 真 BrowserConnector(headless Chromium,zero-cred/egress-controlled)。
- **ACT5e [DEPLOY-GATED/posture]**:`AGENTOS_ADVERTISE_BROWSER` 把瀏覽器原語 advertise 給 brain(ACT4 同款 deny-by-default + dispatcher)。

## (4) ⚠️ Open questions（需人工/產品決策,開 ACT5b 前必答 #1）
1. **screen-state-return policy(最重要)**:`browser.read` 回傳給 brain 的內容要怎麼治理?選項:(a) 原文 size-bounded;(b) redactSecrets'd;(c) content-egress allowlist(只允許讀特定 host/區域);(d) 只回結構化抽取(text/links)不回 raw HTML;(e) 標記為 untrusted-content 進 brain。**決定資料外洩面的大小**。
2. **click/type 的 approval posture**:每個 click/type 都互動 approval(安全但難自主),還是 Personal 預授權 budget(像 git.push)?不可逆 UI 動作能否自主?
3. **session 模型**:per-tenant session、逾時、resume 權、最大並發。
4. **dynamic egress 的預設**:per-navigation deny-all + allowlist(嚴),還是「browsing 模式」放寬到一組 host?
5. **credential-into-page**:`browser.type` 打密碼 → placeholder 在瀏覽器 egress 解析(像 OAuth token)?還是禁止 brain 碰登入?

## (5) 不變量（全 phase 共通)
- **每步逐一受治理**:每個瀏覽器原語都過 `runGovernedToolCall`(單一 edge,無旁路);pipeline 零改。
- **session 不外露**:brain 只有 sessionId;handle/cookies/登入態在 actor 側。
- **credential-blind**:type 的憑證走 placeholder;**read 回傳內容受 §4#1 治理**(預設最嚴,fail-closed)。
- **deny-by-default**:advertise off → brain 看不到瀏覽器;egress deny-all → 只導 allowlist host;click/type destructive→approval。
- **誠實**:真瀏覽器 = deploy;in-repo = port + fake + 契約;click 效果不可事前完備預測(沙盒 + WORM + approval 為主)。

## (6) Depends-on / 誠實前提
- Depends-on:runGovernedToolCall、ActionBinding 模式(ACT1-4)、egress fold(CAP5/6)、approval(CAP4)、boundary(CAP7)、credential placeholder、ACT4 advertise dispatcher。Blocks:無(瀏覽器是 ActionBinding 的最後 sub-family)。
- **誠實前提**:ACT5 in-repo 能建 port + fake + 逐步治理契約(ACT5a/b/c,fake browser);**真瀏覽器執行 = deploy-gated 沙盒 substrate(ACT5d)**。screen-state-return(§2#1)是本 phase **最大新攻擊面**,ACT5b 前必須先定 open-q#1 的回傳治理政策(預設 fail-closed:最嚴)。
