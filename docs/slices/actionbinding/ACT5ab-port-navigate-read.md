# SLICE-ACT5a+b: BrowserActionBinding sub-port + session + navigate + read（含 return-content sanitizer)

- **Phase**: ActionBinding — Slice 5a+5b（瀏覽器 port + 前兩個原語 + 資料-OUT gate;fake-proven)
- **Branch**: slice/act5ab-browser
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 範圍（open-q#1 已決:分層強制)
建瀏覽器 sub-family 的 port + session 模型 + `browser.navigate`(egress-gated)+ `browser.read`(回傳內容經**分層 sanitizer**:allowlist-host + redactSecrets + size-bound + untrusted-marked)+ 過 REAL `runGovernedToolCall` 的 join。**fake browser,無真瀏覽器/網路**(真 substrate = ACT5d,deploy-gated)。click/type = ACT5c。

## (1) 範圍
1. **`BrowserConnector` port + `FakeBrowserConnector`**(新模組,hermes 區,sibling to action-closed-loop):
   - `BrowserStep = { sessionId: string; primitive: "navigate"|"read"; params: Record<string,unknown> }`;`BrowserStepResult = { ok: boolean; detail?: string; content?: string; currentHost?: string }`(read 帶 content)。
   - `BrowserConnector { perform(context, step): MaybePromise<BrowserStepResult> }`。
   - `FakeBrowserConnector`:server-held session map(sessionId→{currentUrl});navigate 記 url、回 ok;read 回 **canned page content**(測可注入含 canary secret 的內容);**不外露 handle/cookies**。
2. **session 模型**:`browser.session.open {}` → 回不透明 `sessionId`(server 生成);`browser.session.close {sessionId}`。**brain 只持有 sessionId**(reference),raw handle/cookies/登入態都在 connector 側。sessionId 格式驗證(strict);未知 sessionId → deny。
3. **`browser.navigate {sessionId, url}`**:strict argSchema;url 經 `isAllowedFetchUrl`(https-only,複用 net.fetch);`governanceProjector` → `networkHosts=[new URL(url).hostname]` → **egress fold per-navigation**(deny-all default,只允許 allowlist host);sideEffect read(導航本身);containment network-egress。
4. **`browser.read {sessionId, selector?}`**:strict argSchema;sideEffect read;**return-content sanitizer**(資料-OUT gate)在 content 回 brain 前套用:
   - **redactSecrets**(複用,含 Google ya29./AIza/Bearer patterns)。
   - **size-bound**(截斷至上限,如 8 KiB;標記 truncated)。
   - **untrusted-marked**(回傳結構標記 `untrusted: true`,讓下游知道這是頁面資料非指令)。
   - host:由 navigate 已 egress-gate(session 當前頁必在 allowlist;substrate 強制真邊界——誠實標)。
5. **`returnContentSanitizer(raw, opts): { content, truncated, untrusted }`**(可測,純):redact → bound → mark。**這是 credential-blind input guard 的對偶(資料-OUT)**。
6. **端到端 join**(過 REAL runGovernedToolCall + FakeBrowserConnector):navigate/read 各自走 screen→authorize(egress fold)→commit-before-effect→effect(dispatch 到 browser connector)→boundary。session 串多步。

## (2) 不變量
- **逐步治理、單一 edge**:navigate/read 各自過 runGovernedToolCall(無旁路);pipeline 零改。
- **session 不外露**:brain 只有 sessionId;handle/cookies/登入態在 connector;未知/竄改 sessionId → deny。
- **navigate egress per-navigation**:deny-all default;brain 只能導 allowlist host;非-allowlist → denied@policy,connector 不導。
- **⚠️ read 資料-OUT 受治理(open-q#1)**:回 brain 的內容經 sanitizer——secret redacted、size-bounded、untrusted-marked。**canary secret 在頁面 → 不原樣回 brain**(redacted)。
- **credential-blind(IN 不變)**:navigate/read 的 args 無憑證;session 不帶憑證給 brain。
- **deny-by-default**:advertise off(ACT5e)→ brain 看不到瀏覽器(本刀不 advertise,只建 port+join,測用直接 wiring);未知 primitive/sessionId/非-allowlist host → deny。
- byte-identical:純加(新模組 + join 測);pipeline/exec/action 家族不動。無新依賴(fake browser;真 Chromium = ACT5d)。

## (3) Test-first plan（RED 先行;FakeBrowserConnector,無真瀏覽器/網路）
- port/effect edge:未知 sessionId → deny,Fake.perform never called;navigate unknown key → strict deny。
- **navigate egress**:`{sessionId, url:"https://allowed.example/x"}` + allowlist=[allowed.example] → 過 → Fake 導航;`url:"https://evil.com"` → denied@policy,Fake never called;default(空 allowlist)→ deny-all;url=`file://`/userinfo/IP → isAllowedFetchUrl 拒。
- **⚠️ read sanitizer(核心)**:FakeBrowserConnector read 回含 canary(`sk-…`/`ya29.…`)+ 超長內容 → 回 brain 的 content **不含 canary**(redacted)、**被截斷**(truncated:true)、**標記 untrusted**。`returnContentSanitizer` 單測:redact + bound + mark;mutation:略過 redact → canary 測翻紅。
- **session 不外露**:join 多步(open→navigate→read→close);brain 只見 sessionId;Fake 的 handle/cookies 不入 tools/call 回應/WORM/trace。
- 端到端:navigate/read 過 governed pipeline(commit-before-effect 序、boundary、egress);credential-blind(canary 不入 WORM)。
- mutation:read 不過 sanitizer(原樣回)→ canary 外洩測翻紅。
- byte-identical:既有 exec/CAP/ACT1-4 全測續綠。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(BrowserConnector port + FakeBrowserConnector + session(server-held sessionId)+ browser.navigate(egress per-navigation)+ browser.read(returnContentSanitizer:redact+bound+untrusted)+ 過 REAL runGovernedToolCall join;未知 sessionId/host deny;**read canary 不外洩(redacted/truncated/untrusted)**;session handle 不外露;credential-blind;byte-identical;mutation 證(skip-redact 翻、skip-egress 翻);depcruise/secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純加 browser 模組 + join 測)。
- Depends-on:runGovernedToolCall、ActionBinding 模式、egress fold(CAP5/6)、isAllowedFetchUrl、redactSecrets(含 Google patterns)、CAP7 boundary。Blocks:ACT5c(click/type)、ACT5d(真瀏覽器)、ACT5e(advertise)。
- **誠實前提**:fake browser,無真瀏覽器/網路(真沙盒 Chromium = ACT5d,deploy)。read 的 host-allowlist 靠 navigate 的 egress-gate + substrate 真邊界(in-repo egress fold 是 best-effort;頁面 redirect/embed 的真網路邊界 = substrate PRIMARY,誠實標)。sanitizer 的 redact 是 best-effort(非形狀 PII 仍可能殘留)→ 故 host-allowlist(只讀核准 host)是主防線,redact/bound/untrusted 是疊加。
