# SLICE-ACT5e: advertise 瀏覽器原語給 brain（ACT4 同款 deny-by-default;3-way dispatch)

- **Phase**: ActionBinding — Slice 5e（瀏覽器終局:Hermes 提議瀏覽器 → agent-os 受治理執行)
- **Branch**: slice/act5e-advertise-browser
- **狀態**: **DRAFT（待核准開工)**
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>

## (0) 範圍 + 姿態
把瀏覽器原語(browser.session.open/close、navigate、read、click、type)advertise 給 brain,讓 **Hermes 能提議瀏覽器步驟且過完整 governed pipeline**。**⚠️ 把「驅動真瀏覽器」暴露給不可信 brain 是最重的姿態 → DENY-BY-DEFAULT**:`AGENTOS_ADVERTISE_BROWSER`(精確 true/1),**預設 off → byte-identical**(brain 看不到瀏覽器;browser tools/call → unknown/deny)。這是 ACT4 dispatcher 的**第三家族分支**。

## (1) 範圍（擴充 ACT4 的 bin 接線,鏡像 action 家族)
1. **`browserAdvertiseFromEnv(env)`**(deny-by-default,精確 true/1;鏡像 `actionAdvertiseFromEnv`)。
2. **`opts.browserAdvertise` + `opts.browserConnector` seam**(鏡像 actionAdvertise/actionConnector;測注入 FakeBrowserConnector,no real browser)。
3. **advertise-on 時**(`opts.browserAdvertise ?? (fake ? false : browserAdvertiseFromEnv(env))`):
   - `browserRegistry = seedBrowserRegistry(binWired)` 併入主 registry(authorize 的 lookup 取 navigate 的 network-egress→egress fold、click/type 的 destructive→approval、read 的 sanitizer-via-effect)。
   - `browserBindings = seedBrowserBindings(binWired)`。
   - allow-rule 加 **`browser.**`**(OR-combined,平行 exec.**/git.**/net.**/gmail.**)。
   - `browserDescriptors`(name + argSchemaToJsonSchema)併入 tools/list。
   - **dispatcher 變 3-way**:`browserBindings.has(tc) ? browserEffect(tc) : actionBindings.has(tc) ? actionEffect(tc) : execEffect(tc)`;`browserEffect = bindingWrappedBrowserEffect(browserConnector, browserBindings)`。
   - **projection 變 3-way**:`buildProjectionForCall(...) ?? buildActionProjectionForCall(...) ?? buildBrowserProjectionForCall(...)`(exec/action/browser 互斥,至多一個 yield)。
4. **off(預設)**:不併 browser registry/bindings/descriptors/allow-rule;dispatcher/projection 不含 browser 分支 → **byte-identical**(browser tools/call → 未授權/unknown → deny)。
5. 不改 pipeline / exec / action / browser-family 既有邏輯(只接線 + gate)。

## (2) 不變量
- **deny-by-default**:`AGENTOS_ADVERTISE_BROWSER` 未設 → 瀏覽器完全不暴露(不 advertise/dispatch/授權)→ **byte-identical**。
- **單一 edge / 3-way dispatch 無旁路**:brain-proposed 瀏覽器步驟只經 runGovernedToolCall + dispatcher;**navigate egress、click/type approval、read 資料-OUT sanitizer 全套用**;session 不外露;brain 改不了 composer-fixed(host 由 url 投影、selector strict)。
- **credential-blind**:brain 提議 browser.type 仍**永不見 token**(placeholder egress 解析);browser.read 回傳經 sanitizer(redact+bound+untrusted)。
- **exec + action 路徑不變**:browser on/off 都不動 exec/action(byte-identical off;三家族並存 on)。
- **多層疊加**:advertise-browser-on 才暴露;navigate egress 才放行 host;click/type approval 才放行;read sanitizer 才回內容——任一不過即停。
- byte-identical(off);無新依賴(FakeBrowserConnector 測;真瀏覽器 = ACT5d operator install)。

## (3) Test-first plan（RED 先行;FakeBrowserConnector,無真瀏覽器/網路）
- **advertise off(預設)**:tools/list 無 browser.*;`browser.navigate` tools/call → deny(unknown/未授權,connector 0 calls)。byte-identical(既有 bin/ACT4 測不變)。
- **advertise on + fake**:tools/list 含 browser.session.open/navigate/read/click/type(inputSchema 正確);
  - `browser.navigate` → 過 runGovernedToolCall → egress fold(allowlist host?非-allowlist→denied@policy,fake 0 calls);
  - `browser.click`/`type` → approval(destructive;無 pre-auth→denied@approval,fake 0 calls);
  - `browser.read` → 回傳經 sanitizer(canary redacted/truncated/untrusted);
  - `browser.type` placeholder → egress 解析,canary 不入 WORM/tools/call 回應。
- **3-way dispatch 正確**:exec→execEffect、action(gmail.send)→actionEffect、browser(navigate)→browserEffect。mutation:dispatcher 漏 browser 分支(全走 action/exec)→ browser.navigate routing 測翻;projection 漏 browser→navigate egress 測翻(CAP6 fail-closed)。
- byte-identical:exec/CAP/ACT1-4/ACT5a-d 全測續綠。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(`browserAdvertiseFromEnv` + browserAdvertise/browserConnector seam + advertise-on 併 browser registry/bindings/descriptors/`browser.**` allow-rule + 3-way dispatcher + 3-way projection;off→byte-identical〔無 browser、deny〕;on+fake→browser advertised + 提議走完整 governed pipeline〔navigate egress / click-type approval / read sanitizer / credential-blind〕;3-way dispatch 正確;mutation 證;depcruise/secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(dispatcher 第三分支 + advertise gate;off byte-identical)。
- Depends-on:ACT4(advertise dispatcher/descriptors/effect seam)、ACT5a-d(browser port/原語/sanitizer/connector)、egress fold、approval、buildBrowserProjectionForCall、seedBrowserRegistry/Bindings。Blocks:無(ActionBinding 全家族 in-repo 終局)。
- **誠實前提**:ACT5e 讓 bin **能**把瀏覽器暴露給 brain 並受治理(deny-by-default off)。verify 用 FakeBrowserConnector(無真瀏覽器)。真 live = AGENTOS_ADVERTISE_BROWSER on + 真 page connector(ACT5d,operator 裝 playwright)+ 有效 egress allowlist。把驅動真瀏覽器暴露給自主 Hermes 是最重的 posture:預設關;開了之後每個瀏覽器提議仍被 deny-by-default + navigate-egress + click/type-approval + read-sanitizer + WORM + credential-blind 層層把關。
