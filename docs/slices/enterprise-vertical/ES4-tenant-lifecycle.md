# SLICE-ES4: 租戶生命週期（動態 registerTenant / deprovision）

- **Phase**: P3（Enterprise 垂直收尾;從「建構時固定預註冊」進到「runtime 動態 onboarding」）
- **Branch**: slice/es4-tenant-lifecycle
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；TS（fleet 動態 API + InMemoryTenantStore 附加 register）；新增依賴 = 0
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8 + re-register-fix=main-loop/Opus4.8;獨立 Opus4.8 reviewer = PASS;動態註冊隔離 + deprovision fail-closed 經 mutation 證實;verify:cross-tenant 綠;採納 reviewer MINOR〔re-register→clean denied〕）

## (0) 動機 + 現況（grounded）
ES1–ES3 的 `createEnterpriseFleet` 在 **ctor 從 `opts.tenants` 靜態預註冊**租戶。真實 fleet 需 runtime onboarding。現況:
- `TenantRouter`(router.ts:31,38)**僅建構**:`#bindings = new Map(bindings)` 防禦複製,**無 mutation API**(結構性隔離:caller 事後改 Map 不影響路由)。
- `InMemoryTenantStore`(in-memory.ts:20,24)**僅建構**:`#partitions` 從 registered Set 建,**無 addPartition**(重建會丟既有租戶資料)。
- ES1 ctor 持 `bindings`/`wormByPartition`/`costByTenant`/`inboxByTenant`,迴圈 `opts.tenants` 建 per-tenant 獨立實例。

## (1) ID + Title
SLICE-ES4 — `EnterpriseFleet` 加 `registerTenant(ctx?, tenantId): LifecycleResult` 與 `deprovisionTenant(ctx?, tenantId): LifecycleResult`:
- **register**:建新 binding(`partition-${tenantId}`)→ 加入 fleet 的 binding set 並 **immutable-rebuild `TenantRouter`**(保留無-mutation-API 的結構性隔離)→ store **附加** register 新 partition(獨立空 Map)→ provision per-tenant 獨立 deps(CostGate、WORM log/sink、inbox、per-tenant key)→ ok;duplicate/ malformed → **fail-closed denied**。
- **deprovision**:從 binding set 移除 → rebuild router(此後 `route(ctx)` 對該租戶 **fail-closed deny**)。**WORM/audit 鏈 append-only,不抹除**(deprovision = 撤銷路由/動作能力,非刪歷史;by design)。

## (2) Goal（一句話）
讓 Enterprise fleet 能 runtime 動態 onboard/offboard 租戶,且**動態註冊後 tenant-sealed 隔離仍成立**(新租戶與既有互不可讀/寫/核准;deprovision 後該租戶 fail-closed 被拒),`verify:cross-tenant` 仍綠——Enterprise 垂直從固定預配置進到完整生命週期。

## (3) In-scope / Out-of-scope
- In-scope:
  - `EnterpriseFleet.registerTenant(tenantId)`:immutable-rebuild router + store 附加 register + provision per-tenant 獨立 deps(沿 ES1 的「每租戶獨立實例」紀律;per-tenant key 沿 ES2a 記憶體生,標 attester==operator/P4)。fail-closed:重複註冊 → denied;空/malformed tenantId → denied。
  - `EnterpriseFleet.deprovisionTenant(tenantId)`:rebuild router 移除該 binding(此後 route deny);未註冊 → denied。WORM 不抹除(append-only,honest)。
  - **`InMemoryTenantStore` 附加 `register(partitionId): void`**(in-memory.ts):新增**獨立空 Map**;**fail-closed**(已存在 → throw,絕不覆寫既有資料);保留 per-partition independence(forTenant 仍 closure-bound)。R8 cross-tenant conformance gate **必須仍綠**。
  - 既有 facade(route/submitForApproval/approve/console/operatorAction)對動態註冊的租戶照常運作;對 deprovision 的租戶 fail-closed deny。
  - RED-first 測試:見 §5。
- Out-of-scope（明確不做,誠實標記）:
  - **動態 LIVE kernel partition 註冊**:ES2a 的 kernel `-partitions` 在**啟動時固定**;runtime 新增 kernel partition 需新 RPC(RegisterPartition)或重啟 → **P4**。ES4 做**動態 in-memory**(fleet router/store/deps);接 live kernel 的動態租戶沿用 ES2b wormSinkFor(但該 partition 須已在 kernel 啟動時存在,否則 fail-closed deny——honest 限制)。
  - **真實 per-tenant key provision / KMS / 輪替** = P4(ES4 沿 ES2a 記憶體生 key,attester==operator)。
  - WORM 歷史抹除(deprovision 不刪 append-only 鏈,by design)。

## (4) Design delta + 依賴方向
- `bootstrap.ts`:把 ctor 的「靜態迴圈」抽成可重用的 per-tenant provision 函式,`registerTenant` 呼叫它 + rebuild router;fleet 持 mutable 的 `bindings`/per-tenant maps(但 router 本身每次 immutable rebuild)。`deprovisionTenant` 移除 + rebuild。
- `InMemoryTenantStore.register`:純附加、fail-closed、獨立 Map(不改 forTenant/既有語意)。
- 依賴經 barrel(tenant);無 vendor、無 cycle。
- **PUBLIC**:`EnterpriseFleet.registerTenant`/`deprovisionTenant`;`InMemoryTenantStore.register`。

## (5) Test-first plan（RED 先行）
- **動態 register**:fleet 起始空(或 1 租戶)→ `registerTenant("tenant-c")` → ok → `route(ctxC)` 成功 + tenant-C governed action executed + console(ctxC) 反映;**且 tenant-C 與既有 tenant-A 互不可讀/寫/核准**(組合後跨租戶隔離,沿 ES1 核心斷言)。
- **fail-closed**:重複 `registerTenant` 同 id → denied;空/malformed id → denied;`route` 未註冊 → deny。
- **deprovision**:`registerTenant("tenant-c")` → `deprovisionTenant("tenant-c")` → 此後 `route(ctxC)`/submit/approve/operatorAction **fail-closed denied**;未註冊 deprovision → denied;**WORM 既有事件仍可讀**(append-only 不抹除)。
- **store.register**:新 partition 與既有獨立(register 後 tenant-C 的 repo 與 tenant-A 不交叉);重複 register → throw(fail-closed);R8 conformance gate 綠。
- `pnpm run verify:cross-tenant` **仍綠**(動態 API 不破壞三邊界閘)。
- 首次 RED:`registerTenant`/`deprovisionTenant`/`store.register` 不存在 → 型別/import 錯。

## (6) Definition of Done（實測）
- [x] RED:`fleet.registerTenant is not a function` + `store.register is not a function` + TS2339(12 errors)→ 實作前紅。
- [x] `pnpm run verify` **exit 0**(874→875 passed〔含 3c re-register〕+ 11 skipped;`verify:cross-tenant: ok`;ES1〔4〕/ES3〔5〕/persistence-contract/conformance/console 既有 e2e **不變**綠;static ctor path byte-identical)。
- [x] **動態註冊後隔離非 vacuous**:動態 register 的 tenant-C 與 tenant-A 互不可讀/寫/核准(組合後 matrix);reviewer mutation:① register 共用既有 log/inbox → 隔離紅;② register 不 rebuild router → register-happy 紅;③ deprovision 不 rebuild router → deprovision-deny 紅。
- [x] **deprovision fail-closed**:deprovision 後該租戶 route/submit/approve/operatorAction/console 皆 deny;未註冊 deprovision → denied;**WORM 既有事件仍可讀**(append-only 不抹除,測試持 instance 證 entries 不變 + suspend-agent event 仍在)。
- [x] `InMemoryTenantStore.register` 附加/fail-closed(重複 → throw `REASON_DUPLICATE_PARTITION` 靜態不洩值)/獨立 Map;**port 未加寬**(fleet 持 concrete class);R8 conformance/contract gate 綠;每租戶獨立實例(provisionTenant fresh key/log/CostGate/inbox)。
- [x] depcruise exit 0(129 modules);secret-scan clean;credential-blind(register/deprovision deny reason 靜態)。
- [x] **誠實標記**:動態 LIVE kernel partition = P4(kernel -partitions 啟動固定);per-tenant key 記憶體生 = attester==operator/P4;deprovision 不刪 WORM(append-only)。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8;3 隔離 mutation 翻紅;8 攻擊面 HELD/N/A;static ctor byte-identical)。
> **採納 reviewer MINOR(edge case)**:`register→deprovision→re-register 同 id` 原本拋未捕例外(store.register 撞仍存在的 partition,append-only 不抹除)。修:registerTenant `try{provisionTenant}catch{→denied "tenant id retired"}`——退役 id 不可在進程內重新 onboard(避免靜默重用舊 WORM/inbox),clean fail-closed denied 而非 throw。新增測試 (3c) 證實 + 狀態一致(retired id 不可 route、A 不受影響)。

## (7) Rollback
- `git revert <merge-sha>`(移除 registerTenant/deprovisionTenant + store.register)。靜態 ctor 預註冊路徑不變、可逆。

## (8) Depends-on / blocks
- Depends-on:ES1(createEnterpriseFleet + per-tenant deps)、ES2b(wormSinkFor,動態租戶接 live 用)、ES3(operatorAction)、R8-S1/S2(TenantRouter/InMemoryTenantStore)、R8-S6(cross-tenant 閘)。
- Blocks:無(Enterprise 垂直收尾;動態 LIVE kernel partition = P4)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:ES4 收尾 Enterprise 的**動態 in-memory** 生命週期;動態 live kernel partition、真 key provision、operator auth = P4/後續。
