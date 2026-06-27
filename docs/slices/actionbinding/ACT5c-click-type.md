# SLICE-ACT5c: browser.click / browser.type（destructive→approval;type-credential placeholder)

- **Phase**: ActionBinding — Slice 5c（補完 in-repo 瀏覽器原語:click/type)
- **Branch**: slice/act5c-click-type
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 範圍
加 `browser.click`/`browser.type` 兩原語(ACT5a/b 已有 navigate/read)。**UI 動作效果不透明**(click 可 submit/刪、type 可觸發)→ **sideEffect destructive → superRefine 強制 requiresApproval → per-step approval**。`browser.type` 的 text 可為**憑證 placeholder**(在 connector egress 解析,credential-blind)。fake browser,無真瀏覽器/網路(真 = ACT5d)。

## (1) 範圍
1. **`BrowserStep.primitive` += `"click"|"type"`**(browser-closed-loop.ts);`FakeBrowserConnector.perform` 處理(記步驟、回 ok;type 在 egress 解析 text placeholder——平行 `resolveCredentialHeaders`)。
2. **`browser.click {sessionId, selector}`**:manifest **containment in-sandbox**(click 無 projectable host;其網路效果由 substrate 強制——誠實標)、**sideEffect destructive**(⇒ requiresApproval true 強制)、idempotent false;binding strict `{sessionId, selector}`、`governanceProjector`(operationClass、無 params)、bindingWrappedBrowserEffect dispatch。
3. **`browser.type {sessionId, selector, text}`**:manifest in-sandbox、**destructive**(⇒ approval)、idempotent false;binding strict `{sessionId, selector, text}`;**text-credential placeholder**:若 text 是 `openshell:resolve:env:KEY` → connector 在 egress 解析(brain/WORM/projection 只見 placeholder);**literal secret in text → credential-blind input guard 擋**(deny,connector 不呼叫)。
4. **`resolveCredentialText`(或重用 resolveCredentialHeaders 的同款邏輯)**(可測,純):text 是 placeholder → 換 env[KEY](egress);非-placeholder → 原樣;env 缺 → fail-closed。**僅在 connector egress;brain 永不見真值**。
5. **selector strict**(普通字串,結構化傳給瀏覽器,**非 script 串接**——無 DOM 注入面)。
6. **governed join**:click/type 過 REAL runGovernedToolCall → approval(destructive)→ commit-before-effect → effect → boundary。

## (2) 不變量
- **destructive→approval(per-step)**:click/type superRefine 強制 requiresApproval;無 pre-auth → denied@approval,connector 不呼叫;pre-auth → proceed。
- **type credential-blind**:憑證走 placeholder,egress 解析;**literal secret in text → input guard deny**;真值不入 brain/WORM/projection/trace。
- **單一 edge / 無旁路**:click/type 各自過 runGovernedToolCall;commit-before-effect 序;pipeline 零改。
- **session 不外露**;**selector 無注入**(strict,結構化)。
- **誠實**:click 的網路/UI 副作用不透明 → PDP 用 approval + session-on-allowlist-host gate;真效果邊界 = substrate(沙盒瀏覽器,deploy)PRIMARY。
- byte-identical:純加;ACT5a/b + 既有全測不變。無新依賴。

## (3) Test-first plan（RED 先行;FakeBrowserConnector,無瀏覽器/網路）
- manifest:`browser.click`/`browser.type` `sideEffect destructive` + `requiresApproval:false` → parseToolManifest 拒(superRefine)。
- **approval(核心)**:click 無 pre-auth → denied@approval,Fake never called;`AGENTOS_APPROVE_PREAUTH` 含 browser.click → proceed → Fake.perform。type 同。
- argv/strict:unknown key 拒;selector/text strict。
- **type credential-blind**:text=`openshell:resolve:env:LOGIN_PW` + env 有值 → connector egress 收到解析值;brain/WORM/projection/trace **只見 placeholder**(canary 不外洩)。text=literal `sk-…`(真 secret)→ input guard deny,connector 不呼叫。`resolveCredentialText` 單測:placeholder→env、非-placeholder→原樣、env 缺→fail-closed。
- session 不外露;commit-before-effect 序;boundary。
- mutation:click manifest 可設 requiresApproval:false(若繞 superRefine)→ approval gate 失效測翻;type 略過 input guard → literal-secret 測翻;type 略過 egress 解析 → 真值不達 connector(功能翻)/或 placeholder 外洩測翻。
- byte-identical:ACT5a/b + exec/CAP/ACT1-4 全測續綠。

## (4) Definition of Done（實測）
- [x] **DONE（merged)**:`BrowserPrimitive += click/type` + `resolveCredentialText`(placeholder→env@egress,fail-closed)+ FakeBrowserConnector click/type(type 在 egress 解析、resolved 值只進 private lastTyped)+ `browser.click`/`browser.type` manifest(in-sandbox、destructive⇒requiresApproval)+binding(strict;type literal-secret→input guard deny)+ 條件註冊(需 approval wired)+ 過 REAL pipeline join。RED → verify **exit 0**(1748 passed + 29 skipped;26 測;**requiresApproval-off / skip-input-guard / leak-resolved-value 各翻**)。獨立 Opus4.8 review **PASS,零 findings**:**type credential-blind**(resolved canary 只在 peekLastTyped〔actor〕,不入 result/steps/WORM/projection/trace/response;literal secret 擋;missing-env fail-closed)、destructive→approval per-step(superRefine 強制;no-pre-auth→denied@approval connector 不呼叫)、selector/text strict 無注入、session 不外露、單一 edge、commit-before-effect、byte-identical(ACT5a/b + 677 sibling 綠)。
- **in-repo 瀏覽器原語完成**(navigate/read/click/type + session)。**誠實**:fake browser;真執行 = ACT5d 沙盒 Chromium;click/type 效果不透明 → approval + session-allowlist + sandbox + WORM 層層,substrate PRIMARY;type 憑證 placeholder/egress credential-blind。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純加 click/type)。
- Depends-on:ACT5a/b(browser port/session/effect/join)、manifest superRefine(destructive→approval)、credential placeholder + resolveCredentialHeaders 樣式、bin approver(CAP4)。Blocks:ACT5d(真瀏覽器)、ACT5e(advertise)。
- **誠實前提**:fake browser;真執行 = ACT5d 沙盒 Chromium(deploy)。click/type 效果不透明 → 事前不可完備預測 → 靠 **per-step approval + session-on-allowlisted-host + 沙盒隔離 + WORM** 層層 + substrate PRIMARY。type 憑證走 placeholder/egress(credential-blind);redact/host-allowlist 是疊加(open-q#2「每 click 互動 approval vs 預授權 budget」用既有 budget posture,interactive-maker-checker 為 deploy posture)。
