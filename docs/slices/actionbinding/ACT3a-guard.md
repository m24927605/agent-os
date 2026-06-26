# SLICE-ACT3a-guard: 真連接器安全閘（live-off-by-default + 測試帳號 allowlist;fail-closed)

- **Phase**: ActionBinding — Slice 3a（guard 部分:讓真連接器結構上只能對測試帳號動作,且預設停用)
- **Branch**: slice/act3a-guard
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機（user-chosen:專用 consumer 測試帳號路線)
使用者選「專用 consumer 測試帳號」路線。真 MCP/OAuth transport 與 live send 是 deploy/auth-gated(ACT3a-live,BLOCKED,需使用者建+連帳號+明確授權)。**ACT3a-guard 現在就建可 verify-proven 的安全閘**:包裝任何 `ActionConnector`,讓它(a)**預設停用**(`AGENTOS_ACTION_LIVE` off → 拒一切,fail-closed)、(b)即使 live on,**作用帳號不在測試 allowlist 就拒**(尤其擋使用者主帳號)。這樣日後接上真 transport + go-live,真連接器**結構上只能**對設定的測試帳號動作。

## (1) 範圍
1. **`createGuardedActionConnector(inner: ActionConnector, config): ActionConnector`**(新檔,hermes 區):`invoke(context, descriptor)`:
   - `config.live !== true` → 回 `{ok:false, detail:<靜態 "action live disabled (deny-by-default)">}`,**inner 不呼叫**。
   - 解析作用帳號(`config.resolveAccount(context, descriptor)`);allowlist 空 / 帳號 undefined / ∉ allowlist → `{ok:false, detail:<靜態>}`,inner 不呼叫。
   - resolveAccount throw/reject → 拒(fail-closed)。
   - 全過 → delegate `inner.invoke(context, descriptor)`。
2. **env config(fail-closed,鏡像 egressAllowFromEnv)**:`AGENTOS_ACTION_LIVE`(只有精確 `"true"`〔或 `"1"`〕→ live;unset/blank/其他 → off)+ `AGENTOS_ACTION_TEST_ACCOUNT`(comma-list 帳號 allowlist;unset/blank → 空 → deny-all)。
3. **`AccountResolver` port**:`resolveAccount(context, descriptor): MaybePromise<string | undefined>`。in-repo `FakeAccountResolver`(回設定的 test/non-test 帳號);**真 resolver(經 live MCP 取認證帳號)= ACT3a-live deploy-gated**。
4. **不接真 transport / 不 advertise / 不 live send**(BLOCKED,ACT3a-live)。guard 純包裝,用 FakeActionConnector + FakeAccountResolver 證。

## (2) 不變量
- **deny-by-default / fail-closed**:live off → 拒;allowlist 空 → 拒;帳號 ∉ allowlist → 拒;resolver throw → 拒。每個拒 **inner 不呼叫**(無 side-effect)。
- **master switch**:`AGENTOS_ACTION_LIVE` unset(預設)→ 真連接器全拒 → 系統停在 fake;只有明確 `true` 才可能 live。
- **主帳號保護**:作用帳號 ∉ 測試 allowlist(含使用者主帳號)→ 拒。
- **credential-blind**:拒絕 reason 靜態(不回帶帳號 email/PII);config 是非-secret allowlist。
- **byte-identical**:guard 純加;未包裝的 composition(現 ACT1/ACT2 用 FakeActionConnector 直接)不變;無新依賴。
- **PDP/治理閘不變**:guard 在 connector 層(effect 邊界內),不改 pipeline/authorize。

## (3) Test-first plan（RED 先行;FakeActionConnector + FakeAccountResolver)
- live off(`AGENTOS_ACTION_LIVE` unset/`"false"`/blank)→ guard 回 ok:false,FakeActionConnector.invoke **never called**。
- live on + allowlist=["test@x"] + resolver→"test@x" → delegate,inner 收到 descriptor。
- live on + resolver→"main@x"(∉ allowlist)→ 拒,never called。
- live on + allowlist 空 → 拒,never called。
- resolver throw → 拒(fail-closed),never called。
- env parse:`AGENTOS_ACTION_LIVE` 只有精確 true-token → live;`AGENTOS_ACTION_TEST_ACCOUNT` comma/trim/blank-filter;unconfigured → off + 空 allowlist。
- credential-blind:拒絕 reason 不含帳號字串(canary 帳號 → reason 無 canary)。
- mutation:guard 略過 live 檢查 → live-off 測翻(inner 被呼叫);略過 allowlist → main-account 測翻。
- byte-identical:ACT1/ACT2/exec 全測不變綠。

## (4) Definition of Done（實測）
- [x] **DONE（merged)**:`action-guard.ts`——`createGuardedActionConnector(inner, {live, testAccounts, resolveAccount})`(4 refusal branch:live≠true / resolver throw〔fail-closed〕/ allowlist 空或帳號∉allowlist → 靜態-reason refuse,各 inner-never-called;else delegate)+ `AccountResolver` port + `FakeAccountResolver` + env readers(`actionLiveFromEnv` 只精確 "true"/"1"、`testAccountsFromEnv` comma/trim/blank-filter→unset 空、`actionGuardConfigFromEnv`)。RED → verify **exit 0**(1616 passed + 29 skipped;guard 19 測;skip-live/skip-allowlist mutation 翻)。獨立 Opus4.8 review **PASS**:每 refusal inner-never-called(探針 10 斷言)、master switch off-by-default + exact-token(unset/blank/"false"/"TRUE"/"yes"/"true " 全 off)、主帳號 blocked + credential-blind(canary 不洩、帳號不 interpolate)、empty-allowlist=deny-all、byte-identical(無 production 接線,un-wrapped 路徑不變)、depcruise bite + secret-scan clean、無新依賴。
- **安全閘就位**:日後接真 transport + go-live 時,真連接器**只能**對 allowlist 內測試帳號動作、且須明確開 `AGENTOS_ACTION_LIVE`。**BLOCKED(ACT3a-live,user-initiated+授權)**:真 transport(agent-os runtime 自己的 Google/MCP client,非此 session MCP 工具)+ 真 AccountResolver(live 認證取帳號)+ 對測試帳號真 send。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純加 guard + env reader + resolver port)。
- Depends-on:ACT1(ActionConnector/ActionDescriptor/ActionResult)。Blocks:**ACT3a-live**(真 MCP transport〔agent-os runtime 自己的 Google/MCP client,非此 session 的 MCP 工具〕+ 真 AccountResolver〔live 認證取帳號〕+ live send)。
- **誠實前提**:ACT3a-guard = **安全閘,verify-proven**(Fake connector + Fake resolver)。**BLOCKED(ACT3a-live,user-initiated + 明確授權)**:真 transport、真認證帳號解析、對測試帳號的真 send。guard 保證日後 live 時**只能**對 allowlist 內測試帳號動作、且須明確開 `AGENTOS_ACTION_LIVE`。真連接器另須(ACT1 誠實點)拒 descriptor 未宣告的 host(substrate PRIMARY)。**憑證/帳號密碼永不進對話/檔案/log**——guard 只認帳號 email 字串做 allowlist 比對。
