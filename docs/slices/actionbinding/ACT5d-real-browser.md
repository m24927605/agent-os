# SLICE-ACT5d: 真瀏覽器 substrate（governed,跑真 Chromium 過治理 pipeline)

- **Phase**: ActionBinding — Slice 5d（真 BrowserConnector + live runner;runtime-direct,user-authorized)
- **Branch**: slice/act5d-real-browser
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 範圍 + 姿態
建**真 BrowserConnector**(驅動真 headless Chromium)+ live runner,讓一次 governed navigate+read 對**真瀏覽器**跑過完整 `runGovernedToolCall`。**設計鐵則:verify 零新依賴、零真瀏覽器**——TS 連接器對結構化 Page 介面映射(不 import playwright),fake page 測;真 Chromium 只在 `.mjs` runner(動態 import playwright,operator 為 live drive 安裝)。runtime-direct posture(同 Gmail live):actor 在 egress 邊界,credential-blind to brain。

## (1) 範圍
1. **`createBrowserConnectorOverPage(page: BrowserPage): BrowserConnector`**(新 TS 模組,hermes 區,**不 import playwright**):`BrowserPage` = 結構化介面 `{ goto(url), content(selector?), click(selector), fill(selector,text), close() }`。映射 `BrowserStep` → page 方法;type 在 egress 經 `resolveCredentialText` 解析(複用);read 的 content 由既有 effect 的 `returnContentSanitizer` 套用(redact+bound+untrusted)。**不直接碰瀏覽器** → fake page 可測。
2. **`scripts/act5-live-browser.mjs`**(operator runner):**動態 `import("playwright")`**(未裝 → fail-closed 印「install playwright for the live browser drive」、exit 非 0、不跑);啟動 chromium → **`context.route('**', ...)` egress 攔截:host ∉ `AGENTOS_EGRESS_ALLOW` → `route.abort()`(substrate PRIMARY 真網路邊界)**→ adapt chromium page 到 `BrowserPage` → `createBrowserConnectorOverPage` → wire 完整 governed pipeline → 跑 `session.open → browser.navigate(<allowlist host>) → browser.read → session.close`,印治理 trace + sanitized 結果。
3. **`scripts/e2e-live-browser.sh` + `e2e:live-browser`**:env(AGENTOS_EGRESS_ALLOW)+ playwright-presence gated skip(同 e2e:live-gmail 樣式,不 fake-green)。
4. **測**:`createBrowserConnectorOverPage` 用 **fake page**(記 goto/click/fill、回 canned content〔含 canary〕)→ 映射正確 + type resolveCredentialText + read content 經 sanitizer(canary redacted)。**verify 無真瀏覽器、無 playwright dep、無網路**。
5. **不加 package.json dep**(playwright 是 runner 的 runtime 安裝,動態 import);不改 pipeline/exec/action/ACT5a-c 邏輯。

## (2) 不變量
- **verify dep-free / browser-free**:TS 連接器對結構化 Page 介面(無 playwright import);測用 fake page;真 Chromium 只在 `.mjs`(動態 import,verify 不跑)。**package.json/lock 不變**(無新依賴);depcruise no-vendor-in-core 不破。
- **真治理(live)**:navigate/read 過 REAL `runGovernedToolCall`(egress fold + commit-before-effect + boundary);read 回傳經 sanitizer(redact+bound+untrusted)。
- **substrate PRIMARY egress(真邊界)**:runner 的 chromium 用 route-interception **真的擋掉非-allowlist host**(這是 in-repo egress fold 一直說的「substrate 為主」的真實現:瀏覽器層 abort,不只 PDP 投影)。
- **credential-blind**:type 憑證 placeholder egress 解析;read sanitizer;brain/WORM 不見真值/原始機密內容。
- **fail-closed**:playwright 未裝 / env 未設 → runner skip/blocked,不跑真瀏覽器。
- **誠實**:真 live drive 啟動真 Chromium、導到真公開頁(operator-authorized);navigate/read 是 read(無 approval/憑證)——benign demo。

## (3) Test-first plan（RED 先行;fake page,無真瀏覽器/網路/dep）
- `createBrowserConnectorOverPage`(fake page):navigate → page.goto(url) 收到;read → page.content() → 經 effect sanitizer(canary redacted/truncated/untrusted);click → page.click(selector);type placeholder → page.fill 收到 egress-resolved 值(canary 不入 result/WORM);unknown primitive → deny。
- mutation:read 不過 sanitizer(原樣回)→ canary 外洩測翻;type 不解析 → placeholder 直達 fill(功能/credential 測翻)。
- byte-identical:ACT5a-c + 既有全測續綠;**package.json/lock 無 diff**(verify 證無新依賴)。
- **live(operator,非 verify)**:`e2e:live-browser` 裝好 playwright + 設 AGENTOS_EGRESS_ALLOW=allowed-host → 真開 Chromium、route-abort 非-allowlist、navigate+read 過治理、印 sanitized 內容 + boundary。未裝/未設 → skip。

## (4) Definition of Done（實測）
- [x] **DONE（merged `321f1c6`)**:`createBrowserConnectorOverPage`〔結構化 Page、無 playwright import〕+ runner〔動態 import playwright + route-interception egress + 治理 wiring〕+ e2e:live-browser gated skip;fake page 測映射 + read sanitizer + type egress-resolve;**verify 零新依賴零真瀏覽器**(package.json 只 script 行、pnpm-lock byte-unchanged);RED → verify **exit 0**(1761 passed + 29 skipped;13 測;un-resolved-fill/leak-resolved/raw-content mutation 各翻);獨立 Opus 4.8 review **PASS,零 findings**(零新依賴 + browser-free、type credential-blind、read sanitizer、route.abort substrate-PRIMARY、playwright-absent fail-closed、.sh SKIP exit 0、byte-identical)。
- [x] **live drive 成功(2026-06-27,operator authorized):** 裝 playwright 1.61.1 + chromium → `AGENTOS_EGRESS_ALLOW=example.com` `e2e:live-browser` → **真 Chromium 導到 https://example.com + read,全程過治理**(navigate + read 各:screen→authorize egress folded→commit WORM→effect〔real browser, egress route-abort primary〕→outcome executed)→ `SENT ok`,sanitized read = `{"content":"Example Domain…","truncated":false,"untrusted":true}`,exit 0。資料-OUT sanitizer 對真頁面生效(untrusted:true);egress 在瀏覽器層真 route-abort。事後 `git checkout package.json pnpm-lock.yaml` → repo 回零依賴(playwright = 本地 live-drive 安裝,不入 commit)。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純加連接器 + runner;無 package.json 變更)。
- Depends-on:ACT5a-c(browser port/session/原語/sanitizer/effect)、egress fold、commit-before-effect、boundary。Blocks:ACT5e(advertise)。
- **誠實前提**:**runtime-direct**(runner 程序驅動真 Chromium,在 egress route-abort 非-allowlist = substrate PRIMARY 真邊界)。verify 用 fake page(零真瀏覽器/dep);真 live = operator 裝 playwright/chromium + 跑(benign navigate+read 公開頁)。redirect/embed 的真邊界由 chromium route-interception 強制(比 PDP best-effort 強)。type 憑證 credential-blind(placeholder/egress)。生產級 = 沙盒化 Chromium(zero-cred、no-egress-except-allowlist、ephemeral)——本刀 runtime-direct 對授權測試合理。
