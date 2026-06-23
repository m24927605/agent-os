# SLICE-DVx: 三面共用一套治理 — 可注入 ToolRegistry 的 registry-backed authorize

- **Phase**: P4 / 跨-vertical 整合（讓 Personal / Enterprise / Developer 共用同一份「開發者註冊的工具目錄 + deny-by-default 准入」）
- **Branch**: slice/dvx-unified-tool-registry-authorize
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；TS only;新增依賴 = 0
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer = PASS;backward-compat byte-identical / injected deny-by-default / 跨面 unified / 租戶隔離不變 經 mutation 證實;3 impl 檔 additive）

## (0) 動機 + 現況（grounded）
三面已共用**治理引擎**(`runGovernedToolCall` screen→authorize→cost→commit-before-effect→effect + WORM + PDP `evaluatePolicy`),但 **authorize 准入合約三套不同**:
- **Developer**(`createDeveloperKit`):`authorize = authorizeToolInvoke(req, **ToolRegistry**, rules)`——**逐工具 deny-by-default**(未註冊工具拒;註冊才進 PDP),bootstrap.ts:25-26。
- **Personal**(`createPersonalShell`):寫死 `allow personal:*` + `allowToolInvoke` boolean——**整個命名空間放行,無逐工具註冊**,bootstrap.ts:78-79,132-134。**無 ToolRegistry**。
- **Enterprise**(`createEnterpriseFleet`):per-tenant `allow fleet:*` + `allowToolInvokePerTenant` boolean,bootstrap.ts:90,219,395。**無 ToolRegistry**。
- `authorizeToolInvoke`(src/tools/authorize.ts)= registry deny-by-default → delegate `evaluatePolicy`,**目前只有 Developer 用**。

→ 一個工具在 Developer 要註冊才能跑,在 Personal 只要落 `personal:*` 就放行;**「誰能做什麼」是三套政策、非單一可稽核來源**。

## (1) ID + Title
SLICE-DVx — 在 `createPersonalShell` 與 `createEnterpriseFleet` 的 opts 加**可注入 `toolRegistry?: ToolRegistry`**:注入時 authorize seam 改走 `authorizeToolInvoke(req, toolRegistry, <該面既有 allow rules>)`(registry deny-by-default **在前**、既有 PDP allow **在後**——兩者皆套);**不注入時 byte-identical 今日行為**。並證:注入**同一份** ToolRegistry 到三面後,**已註冊工具在三面皆獲治理、未註冊工具在三面皆 denied@authorize**(三面共用一套准入)。

## (2) Goal（一句話）
把三面從「共用引擎」推進到「共用整套治理政策」:一份開發者註冊的工具目錄 + 一條 registry-backed deny-by-default 准入,**在 Personal / Enterprise / Developer 一致生效**——讓「ONE governance core」名副其實到「誰能做什麼」。

## (3) In-scope / Out-of-scope
- In-scope:
  - **Personal**:`PersonalShellOpts.toolRegistry?: ToolRegistry`。注入 → authorize = `authorizeToolInvoke(req, toolRegistry, personalAllowRules)`(registry deny-by-default → 既有 `personal:*` PDP);**不注入 → 今日寫死路徑 byte-identical**(既有 e2e 不變)。
  - **Enterprise**:`EnterpriseFleetOpts.toolRegistry?: ToolRegistry`(平台級共用目錄,跨租戶)。注入 → per-tenant authorize = `authorizeToolInvoke(req, toolRegistry, perTenant fleet allow)`(registry deny-by-default + 既有 per-tenant PDP **皆套**;**租戶隔離〔routing/per-tenant WORM/per-tenant rule〕不變**);不注入 → 今日 byte-identical。
  - **跨面統一 proof**(e2e):建**一份** `ToolRegistry`,`register` 一個工具;注入 `createPersonalShell` + `createEnterpriseFleet` + `createDeveloperKit`;**已註冊工具 → 三面皆 executed**;**未註冊工具 → 三面皆 denied@authorize(deny-by-default)**。
  - 單元/e2e:Personal/Enterprise 注入 registry 的 deny-by-default + byte-identical 缺省;tenant 隔離仍綠(`verify:cross-tenant`)。
- Out-of-scope（誠實標記）:
  - `DeveloperKit.integrateWithPersonal/Enterprise` **便利 facade**(薄包「注入 kit 的 registry」)= 可後續;DVx 的核是 **`opts.toolRegistry` seam**(三面共用的原語是 `ToolRegistry` 本身,非 Developer 專有)。
  - 改 PDP / 既有 allow rules / commit-before-effect / WORM(早共用,不動)。
  - 工具**發行/註冊權**(誰能 register)= registry 既有契約;DVx 只統一**消費端 authorize**。
  - 改 `authorizeToolInvoke` 本身(直接重用)。

## (4) Design delta + 依賴方向
- Personal/Enterprise opts 各加 optional `toolRegistry`;authorize seam 條件式:有 registry → `authorizeToolInvoke(req, registry, rules)`(重用既有);無 → 今日 lambda。`combineDecisions` 既有用法不變。`ToolRegistry`/`authorizeToolInvoke` 經 `src/tools` barrel(Personal/Enterprise 已有 tools 依賴或經 barrel 新增,無 cycle、無 vendor)。
- **PUBLIC**:`PersonalShellOpts.toolRegistry`、`EnterpriseFleetOpts.toolRegistry`;三面統一的 registry-backed deny-by-default 語意。

## (5) Test-first plan（RED 先行）
- Personal:注入 registry(空)→ 任一 tool denied@authorize(deny-by-default);注入 registry + register tool → executed;**不注入 → 既有 e2e byte-identical 綠**。在 opts.toolRegistry 前紅。
- Enterprise:同上 per-tenant(注入共用 registry;未註冊 → denied;已註冊 → executed;tenant 隔離不變)。
- **跨面統一 e2e**:一份 registry + 一 tool 注入三面 → 已註冊三面 executed、未註冊三面 denied@authorize。
- 缺省 byte-identical:無 toolRegistry → Personal/Enterprise/Developer 既有 e2e 全綠不變。

## (6) Definition of Done（實測）
- [x] RED:Personal/Enterprise `opts.toolRegistry` + 跨面 e2e 前紅(5 failed:注入 registry 被忽略 → unregistered 仍 executed)。
- [x] `pnpm run verify` **exit 0**(929 passed + 18 skipped;**Personal〔8〕/Enterprise〔cross-tenant 4 + operator 5〕/Developer〔11〕既有 e2e byte-identical 不變**;新 registry-authorize〔Personal 3 + Enterprise 3〕+ unified〔3〕綠;verify:cross-tenant 綠;depcruise 135 modules clean;secret-scan clean)。
- [x] **registry-backed deny-by-default(注入時)**:Personal/Enterprise 注入空/缺工具 registry → denied@policy(無 effect、無 WORM);reviewer mutation(注入卻 bypass registry / 走 wildcard)→ 各面 deny 測試紅。
- [x] **缺省 byte-identical**:無 toolRegistry → 條件式取 `evaluatePolicy`(Personal/Enterprise)/ 內建 registry(Developer)= 今日;reviewer mutation(缺省也走 registry,`?? new ToolRegistry()`)→ 既有 e2e 翻紅(空 registry 拒全部)。
- [x] **跨面統一(核心)**:`unified-governance.e2e` 建**一份** ToolRegistry instance(by-reference)注入三 composition root → 已註冊三面 executed、未註冊三面 denied@policy、partial(只註一面)只該面 executed;reviewer mutation(某面 unwire)→ unified e2e 該面紅。
- [x] tenant 隔離不變:Enterprise registry **僅在 perTenantDeps authorize**(bootstrap.ts:436)被諮詢;per-tenant `fleet:*` allow/`wormByPartition`/per-tenant inbox/routing **不動**;`operatorAction` 走獨立 `enforceMakerChecker`(registry 不見);`verify:cross-tenant` 綠;Enterprise registry-authorize e2e 再證 per-tenant WORM 隔離 + B 不能核准 A 的 id。
- [x] depcruise exit 0(reviewer 以 deep-import 注入 → not-to-internal exit 1 實證邊界 bites;Personal/Enterprise 經 `src/tools` barrel);secret-scan clean(deny reason 靜態無值)。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8;default-also-registry / bypass-registry〔per surface〕/ surface-unwire 五 mutation 翻紅;8 攻擊面 HELD/N/A;WORM/commit-before-effect/PDP git-diff 未觸)。
> **deviation(reviewer 判定 sound)**:加 `DeveloperKitOpts.toolRegistry?`(缺省 `?? new ToolRegistry()` byte-identical;unified proof 需把**同一** registry 注入三面,Developer 本就 registry-backed,此 opt 只使其可注入)。

## (7) Rollback
- `git revert <merge-sha>`(移除 opts.toolRegistry + 條件式 authorize + 統一 e2e)。三面缺省路徑不變、可逆。

## (8) Depends-on / blocks
- Depends-on:DV1(createDeveloperKit/authorizeToolInvoke 樣式)、ES1/ES3(createEnterpriseFleet authorize seam)、P2R-PV-S1(createPersonalShell authorize seam)、R9-S2(ToolRegistry/authorizeToolInvoke)。
- Blocks:無(`integrateWith*` 便利 facade 可後續)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:DVx 統一三面的**消費端 authorize**(registry-backed deny-by-default);引擎/WORM/PDP/commit-before-effect 早共用、不動;工具發行權、`integrateWith*` facade、租戶級工具目錄分權 = 後續。
