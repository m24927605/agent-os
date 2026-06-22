# Enterprise 垂直切片 — 把已建 R8 隔離原語組成「gateway-per-tenant 的可跑治理 fleet」(INDEX)

> 2026-06-23。目標:把 R8 Enterprise-surface 原語(已各自建好且有 RED 測試)+ P2-I governed pipeline +
> commit-before-effect + per-tenant WORM,**組裝成一條可執行的多租戶治理主幹**:`tenant onboard → gateway-per-tenant
> route → per-tenant 治理(screen→PDP→cost→commit-before-effect→effect)→ per-tenant WORM → operator console/timeline`。
> 核心不變量 = **tenant-sealed 隔離**(c3:tenant A 永不可讀/寫/核准 tenant B,建構上不可能)。
> grounded 研究見 task wtymfr1jc。樣板 = Personal 垂直(`src/personal/bootstrap.ts`)。方法論:[`looping-engineering.md`](../../standards/looping-engineering.md)。

## 0. 唯一缺口 = composition root
R8 已交付**六個隔離原語**(各有 RED 測試)+ 治理核(runGovernedToolCall / commitBeforeEffect / evaluatePolicy〔已 tenant-scope〕/ InMemoryCostGate / InMemoryAppendOnlyLog / ApprovalInbox)已在 Personal 垂直驗證可用。但**全 repo 無任何 src 檔把它們組成可跑的多租戶 fleet**(`src/enterprise/` 不存在;`grep createEnterprise*` 零命中)。本垂直補上這個 composition root + **組合後整體**的跨租戶證明。

## 1. 已建的 R8 隔離原語（grounded,file:line）
- **R8-S1 gateway-per-tenant routing**:`TenantRouter.resolve(ctx): {ok,binding}|{ok:false,reason}` — `src/tenant/router.ts:31-61`;`TenantBinding{tenantId,partitionId,storeRef}`;fail-closed parseAgentContext、deny-by-default、bindings 在 private `#` field 防禦複製、**無列舉/任意取值 API**。
- **R8-S2 per-tenant persistence**:`TenantStore.forTenant(binding): TenantScopedRepo{put(key,value),get(key),list()}` — `src/tenant/persistence/port.ts:19-31`;**方法無 tenantId 參數**(跨租定址結構性不可能);`InMemoryTenantStore` 每 partition 獨立 Map(in-memory.ts:20-53)。
- **R8-S4 operator console(唯讀投影)**:`ConsoleProjection.forTenant(binding): TenantConsole{fleet():FleetView, timeline():TimelineView}` — `src/tenant/console/projection.ts:74-115`;無 mutate、closure-bound、allow-list 欄位(fleet=sandboxId/agentName/phase;timeline=seq/summary)、malformed skip。
- **R8-S5 maker-checker**:`enforceMakerChecker(ctx, action, cap): {effect,reason,auditRequired}` — `src/tenant/maker-checker.ts:85-119`;五檢查(ctx valid、cap well-formed、cap.tenantId===ctx.tenantId、maker≠checker、action-identity TOCTOU rederive);possession 非自簽。
- **R8-S6 cross-tenant conformance gate**:`src/tenant/conformance/cross-tenant.conformance.test.ts`,**已 wire 進 `pnpm run verify` 的 `verify:cross-tenant`**(release-blocking;三邊界 routing/persistence/maker-checker;mutation-tested)。
- **identity**:`TenantId` branded 非空 + `parseAgentContext` fail-closed — `src/iam/ids.ts:12-13,39-52`(所有 R8 邊界唯一身分來源)。

## 2. 端到端呼叫鏈（grounded）
1. **onboard**:`registerTenant(tenantId)` → `TenantBinding{tenantId, partitionId=partition-${tenantId}, storeRef}` → 加入 router 的 Map + store 的 registered partition。
2. **gateway route(邊界1)**:`{ctx,intent}` 先過 `TenantRouter.resolve(ctx)`;parse 失敗/未註冊 → **deny(fail-closed,無 default fall-through)**;回 `binding`。
3. **per-tenant deps 組裝**:用 binding 建 tenant-scoped 埠:`store.forTenant(binding)`、**每租戶獨立** `InMemoryCostGate`(keyed by tenantId)、per-tenant PDP allow rules(`evaluatePolicy` 的 rule.tenantId 必須===ctx.tenantId 否則 deny,policy/evaluate.ts:42-45)、**per-tenant WORM appender**(keyed by partitionId,見 5)。
4. **approval**:per-tenant `ApprovalInbox`(inbox.ts:65-121),注入 runner=`(tc)=>runGovernedToolCall(perTenantDeps, tc)`(鏡像 bootstrap.ts:218-220);`approve(id)` 是唯一觸發點(deny-by-default、one-time、MAX_PENDING)。
5. **governed action(commit-before-effect)**:`runGovernedToolCall`(pipeline.ts:53-107)screen→authorize(PDP,傳 ctx.tenantId)→cost.reserve→`commitBeforeEffect`(append AuditEvent 等 receipt)→effect→cost.commit。**SEAM appender** 用 `createAuditEvent` 合成 AuditEvent 寫入「該租戶的」WORM partition:**ES1 = `Map<partitionId, 獨立 InMemoryAppendOnlyLog>`**;ES2 = Go kernel `PartitionedIngest.Append(partitionId, …)`。
6. **跨租戶隔離 by construction(邊界2+3)**:deps 的 store/appender/cost/PDP 全 closure-bound 到單一 binding,呼叫端**手上無任何指名別租戶的參數/介面** → 跨租讀/寫/核准結構性不可能;敏感操作再經 `enforceMakerChecker`。
7. **operator console / timeline**:`ConsoleProjection.forTenant(binding).fleet()/timeline()` — closure-bound、唯讀,讀回**同一份** per-tenant partition/repo(對齊 Personal「寫的==讀的」seam)。

## 3. ⚠️ 關鍵不變量 + 最高風險
- **tenant-sealed 隔離**:per-tenant 必須是**每租戶獨立實例 closure-bound**,**絕非「單一共用實例 + tenantId 參數」**(in-memory.ts:8 註解明示此反模式正是 contract test 要抓的)。
- **ES1 最高風險(必防)**:既有 conformance 只證**單一原語**;未證**組合後**tenant-A 的 approve→WORM→timeline 不滲入 tenant-B。**ES1 必須新增「組合後整體」的端到端跨租戶 RED 測試**(否則組合根可能引入 shared-log/shared-inbox bug 而閘門照樣綠)。
- **S1 共用-log 陷阱**:所有租戶共用一個 InMemoryAppendOnlyLog → timeline/console 跨租可見。必須 `Map<partitionId, 獨立 log>`,reader 讀回同一個。

## 4. 切片分解（小、RED-first）
| Slice | 範圍 | 狀態 |
|---|---|---|
| **ES1** | 最薄 in-memory 可跑企業脊椎:`createEnterpriseFleet(opts)`(`src/enterprise/bootstrap.ts`)組 router + per-tenant{store,CostGate,WORM log,PDP rules,inbox} + governed pipeline;**+ 組合後整體跨租戶 deny 證明**(tenant-A submission 不落 tenant-B partition/timeline、tenant-A inbox 不核准 tenant-B、route(ctxB) 永不達 binding-A) | ✅ **DONE**(verify exit 0、854 tests、verify:cross-tenant 綠;tenant-sealed 3 mutation 證實;獨立 Opus4.8 review PASS)|
| **ES2** | live 每租戶 WORM partition:`proto/ingest.proto` 加 `partition_id`(contract-before-consumer)+ `kernel/internal/partition` PartitionedIngest 接上 cmd/kernel AppendService + TS appender 注入 | DRAFT(較重;依 proto+kernel)|
| **ES3** | operator 敏感動作端:`operatorAction(ctx,action,cap)` = route → `enforceMakerChecker` 閘 → commit-before-effect 審計 → tenant-scoped suspend-agent effect(R8-S4 只交付唯讀投影,動作端原是 stub)| ✅ **DONE**(verify exit 0、859 tests、verify:cross-tenant 綠;maker-checker+commit-before-effect 各 mutation 證實;獨立 Opus4.8 review PASS)|
| **ES4** | 租戶生命週期:動態 `registerTenant`/deprovision、partitionId 配置、per-tenant Ed25519 key provision | DRAFT |

## 5. 誠實風險（界定 P4/外部範圍）
- **per-tenant Ed25519 key 來源未定**(生成/儲存/輪替 = P4 外部 KMS);ES2 若在 kernel 記憶體生 key 則 attester==operator 上限,root-trust externalization 留 P4——**明確標已知限制,勿假裝已解**。
- **maker-checker capability 發行端缺口**:enforce 已建,issue 路徑(誰簽/存哪/怎到 checker)= out-of-band;ES3 串 enforce 時須講清楚。
- **多進程物理隔離**:R8 證同進程**邏輯**隔離;真 per-process/netns = deploy form(P4),無 in-repo 閘門,勿宣稱已達成。
- **operator console 認證面**:console(ctx) 用 agent context 取 binding;真正 operator 身分(≠ agent)與可見租戶過濾 = 後續。

## 6. 交付順序
ES1(in-memory,可跑,展示「多租戶 fleet 會跑且租戶密封」)→ ES2(live per-tenant WORM partition)→ ES3(operator 動作)→ ES4(租戶生命週期)。每刀 doc-first + RED + `verify:cross-tenant` 綠 + 獨立 Opus 4.8 review + merge。
