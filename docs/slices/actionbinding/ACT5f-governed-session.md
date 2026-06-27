# SLICE-ACT5f: governed browser.session.open/close（補完瀏覽器 brain-usability)

- **Phase**: ActionBinding — Slice 5f（session-bootstrap:讓 brain 能受治理地取得 sessionId → 端到端驅動瀏覽器)
- **Branch**: slice/act5f-governed-session
- **狀態**: **DRAFT（待核准開工)**
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>

## (0) 動機（關閉 ACT5e 揭露的缺口)
ACT5e advertise navigate/read/click/type 給 brain,但 **session.open/close 從來不是 governed tool**(ACT5a-d 把 session 做成 connector server-side method)→ brain 無受治理方法取得 sessionId → 看得到工具卻每次 fail-closed deny(安全但不可用)。ACT5f 加 **governed `browser.session.open`/`browser.session.close` 工具**:`session.open` mint 並回傳一個**不可猜的 opaque sessionId** 給 brain(moat 不變:brain 拿 id、拿不到 handle/cookies)→ 一進 seedBrowserRegistry/Bindings,ACT5e 的 advertise 自動帶上 → **brain 能 open→navigate→read→click→type→close 全程受治理**。

## (1) 範圍
1. **`BrowserStep.primitive` += `"session.open"|"session.close"`**(browser-closed-loop.ts);connector.perform 處理:`session.open` → `openSession()` → 回 `{ok, sessionId:<新 opaque id>}`;`session.close` → `closeSession(sessionId)` → 回 `{ok}`。Fake + 真 page connector(ACT5d)都實作。
2. **`browser.session.open {}`** manifest+binding:**containment in-sandbox**(無網路/無 projectable host——開 session 不導航)、**sideEffect write**(配置 server-side 資源,**非 destructive** → 不需 approval;reversible via close)、idempotent false(每次 mint 新 session)、argSchema strict `{}`(無 param,**不收 sessionId——它 mint 一個**)。**bindingWrappedBrowserEffect 在 session.open 把 connector 回的 `sessionId` 放進 result**(brain 讀到 → 後續步驟用)。
3. **`browser.session.close {sessionId}`** manifest+binding:in-sandbox、write、不需 approval、idempotent true(關已關/未知 = 安全 no-op ok)、argSchema strict `{sessionId}`。
4. **session cap(fail-closed)**:`browserSessionCap`(預設如 8);`session.open` 達上限 → **deny**(防 compromised brain 資源耗盡)。可注入(測)。
5. **sessionId 不可猜**:真 connector 用 `crypto.randomUUID`(ACT5d 已是);契約要求 unguessable(Fake 的 Math.random 僅測;真連接器走 crypto)。**unknown-session gate 不變**(未 open 的 id → deny)。
6. **註冊**:session.open/close 進 seedBrowserRegistry/seedBrowserBindings(benign lifecycle,**不需 egress/approval primitive**,在 browser 家族註冊時一併)。→ **ACT5e advertise 自動涵蓋**(browserDescriptors/dispatcher/`browser.**` allow-rule 家族-generic)。
7. **ACT5e 測更新**:原「session NOT advertised」斷言 → 改為 **session.open/close 現在 IN tools/list**(缺口已關;這是預期的 advertised-set 擴增,非 regression)。
8. 不改 pipeline / exec / action / navigate-read-click-type 既有邏輯。

## (2) 不變量
- **session-bootstrap 受治理**:session.open/close 各自過 runGovernedToolCall(commit-before-effect:意圖先進 WORM 再 mint/release);brain 提議。
- **moat 不變(session 不外露)**:session.open 的 result **只帶 opaque sessionId**,**絕不帶 handle/cookies/url/登入態**;brain 拿 id、actor 持實體。
- **sessionId 不可猜 + unknown-session deny**:真連接器 crypto-random;未 open / phantom / malformed id → navigate/read/click/type **fail-closed deny**(connector 不驅動)。
- **session cap fail-closed**:達上限 → session.open deny(資源耗盡防護)。
- **session.open 非 destructive**:不需 approval(開 session 無外部效果;導航才 egress、click/type 才 approval)。
- byte-identical:navigate/read/click/type/exec/action 不變;**唯一預期變更 = ACT5e tools/list 現含 session.open/close**。無新依賴(Fake;真 = ACT5d)。

## (3) Test-first plan（RED 先行;FakeBrowserConnector,無真瀏覽器/網路）
- **session.open mint**:`browser.session.open {}` → result 帶 `sessionId`(bsess_ shape);**同一 id** 接著 navigate(allowlist)→ connector 認得、過治理;**不同/未 open id** → deny,connector 不驅動。
- **moat**:session.open result **不含** handle/cookies/url(只 opaque id);WORM/trace 同。
- **session cap**:開 cap 個 → 第 cap+1 個 session.open → **deny**(fail-closed);close 一個後再 open → ok。mutation:cap 關閉(無限)→ 耗盡測翻。
- **session.close**:close 後該 id navigate → deny;close 未知 id → 安全 no-op ok(或 deny,擇一一致)。
- **end-to-end(advertised + governed)**:brain open→navigate(allowlist)→read(sanitized,untrusted)→click(pre-auth)→type(placeholder credential-blind)→close,全程過 pipeline。
- **ACT5e advertise**:session.open/close 現在 IN tools/list(更新斷言)。
- mutation:session.open 不回 sessionId(或回 handle)→ mint/moat 測翻。
- byte-identical:navigate/read/click/type/exec/action/CAP/ACT1-5e 全測續綠(ACT5e 的 session-advertise 斷言除外)。

## (4) Definition of Done（實測）
- [x] **DONE（merged)**:BrowserStep += session.open/close;FakeBrowserConnector + 真 page connector perform 處理(mint/release);browser.session.open(strict {}, write, 非 destructive→無 approval, 回 minted opaque sessionId)/close({sessionId}) manifest+binding;session cap fail-closed(DEFAULT 8);seedBrowserRegistry/Bindings 註冊 → ACT5e advertise 自動涵蓋(BROWSER_4→BROWSER_6 斷言更新)。RED → verify **exit 0**(1799 passed + 29 skipped;新 session 單測 + end-to-end join;**leak-handle 翻 moat、remove-cap 翻 exhaustion**)。獨立 Opus4.8 review **PASS**:moat(session.open 只回 opaque id,無 handle/cookies/url;WORM/trace 同)、mint+用 + unknown-session 仍 deny(isLifecycle 豁免 keyed on composer-fixed primitive,不可 spoof、不漏給 driving primitives)、cap fail-closed(brain-reachable governed 路徑)、commit-before-effect、end-to-end brain-driven governed 流程(open→navigate→read→click→type→close)、ACT5e 現 advertise session、byte-identical、無新依賴。
- [x] **review M-1/N-1 hardening 折入(real page connector = actor-that-ships)**:M-1 真 connector 的 brain-reachable session.open 現也 cap-fail-closed(`browserSessionCap`,DEFAULT 8;trusted openSession() helper 仍 uncapped);N-1 真 connector 的 `newSessionId` 改 `crypto.randomUUID`(node 內建,無新 dep;不再 Math.random)→ doc 宣稱屬實。+2 測(cap fail-closed、id CSPRNG-shaped `bsess_[0-9a-f]{32}`)。verify **exit 0**(1799)。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純加 session.open/close + ACT5e 斷言更新)。
- Depends-on:ACT5a-d(browser port/原語/connector/sanitizer)、ACT5e(advertise dispatcher 家族-generic)、runGovernedToolCall、commit-before-effect。Blocks:無(瀏覽器家族 brain-usable 端到端完成)。
- **誠實前提**:fake browser(真 session = ACT5d page connector 啟動 context,operator 裝 playwright)。**tenant-scoped session 隔離 = open-q#3/deploy**(in-repo Fake 單程序;sessionId 不可猜 + unknown-session deny 為主防線;「brain 只能用自己 tenant 開的 session」的多租戶歸屬是部署層 PDP/session-store 的事,本刀標為 open-q#3)。session.open 非 destructive(不需 approval)是經設計判斷(開 session 無外部效果);若產品要求「開瀏覽器本身也要批准」則為 posture 調整。
