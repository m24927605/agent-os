# SLICE-ES1: Enterprise fleet composition root（最薄 in-memory 可跑、gateway-per-tenant、tenant-sealed）

- **Phase**: P3（Enterprise 垂直切片;第一條「多租戶 fleet 會跑且租戶密封」的可執行主幹）
- **Branch**: slice/es1-enterprise-fleet-composition-root
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~220（`src/enterprise/bootstrap.ts` + `src/enterprise/bootstrap.e2e.cross-tenant.test.ts` + barrel）、新增依賴 = 0、modules <~1(`src/enterprise`,組裝既有 barrels)
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-ES1 — 新增 composition root `createEnterpriseFleet(opts)`(`src/enterprise/bootstrap.ts`),把 R8 的 TenantRouter/TenantStore/ConsoleProjection + P2-I `runGovernedToolCall` + commit-before-effect + per-tenant CostGate + **per-tenant WORM partition(in-memory)** 組成一條**可呼叫、可跑的 gateway-per-tenant 治理主幹**:`route(ctx) → per-tenant 治理管線 → per-tenant WORM → operator console`。全程**純記憶體 in-tree**(無網路、無 kernel 行程),先證明「多租戶 fleet 接得起來、會跑、且 tenant-sealed」。鏡像 `createPersonalShell`(`src/personal/bootstrap.ts:129`)。

## (2) Goal（一句話）
第一次把 R8 隔離原語 + 治理核組成一個多租戶 fleet,證明:每租戶的 governed action 經自己的 gateway/partition 成功落 effect + 可讀 console,且**組合後整體**任一租戶無法讀/寫/核准另一租戶(tenant-sealed,建構上不可能)。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/enterprise/bootstrap.ts`:`createEnterpriseFleet(opts: EnterpriseFleetOpts): EnterpriseFleet`,門面至少含:
    - `route(ctx)` → `TenantRouter.resolve(ctx)`(包 R8-S1;fail-closed/deny-by-default)。
    - `submitForApproval(ctx, call: GovernedCall)` → route(ctx) 取 binding → 取**該租戶的** `ApprovalInbox` → `inbox.submit(preview, call)` → `{pending,id}|{denied}`。
    - `approve(ctx, id)` → route → 該租戶 inbox `.approve(id)`(注入 runner=`(tc)=>runGovernedToolCall(perTenantDeps(binding), tc)`)→ `DecideOutcome`。
    - `console(ctx)` → `ConsoleProjection.forTenant(binding)` → `{fleet(), timeline()}`(R8-S4,唯讀)。
  - **per-tenant deps 工廠** `perTenantDeps(binding)`(closure-bound,**每租戶獨立實例**):`screen=screenBrainEvent`、`authorize=evaluatePolicy+combineDecisions`(注入**該租戶** `allow tool:invoke` rule,rule.tenantId===binding.tenantId)、`cost`=該租戶 `InMemoryCostGate(budget)`(keyed by tenantId)、`estimateTokens=()=>N`、`effect=FakeSandboxAdapter.createSandbox`、`appender`=**該租戶 WORM 的 SEAM appender**。
  - **per-tenant WORM(關鍵接縫,鏡像 Personal SEAM)**:`Map<partitionId, InMemoryAppendOnlyLog>`(**每租戶獨立 log,絕不共用**)。SEAM appender `append(structuralEvent)` 用 `createAuditEvent({...ctx, action, resource, policyDecision, result})` 合成 AuditEvent → 寫**該 partition 的 log** → 回 receipt;**並**把可投影 timeline 條目(`{seq,summary}`)`put` 進**該租戶的 `TenantScopedRepo`**,使 `console.timeline()`(讀同一租戶 repo)反映該治理動作。
  - barrel `src/enterprise/index.ts` 匯出 `createEnterpriseFleet`。
  - 所有 cross-module 消費經 barrel(tenant/orchestration/commitgate/cost/policy/runtime-substrate/audit/personal〔ApprovalInbox〕/iam),無 deep-import、無 vendor 進 core。
- Out-of-scope（明確不做）:
  - live per-tenant WORM partition(Go kernel + proto partition_id)→ **ES2**。
  - operator 敏感動作(suspend/budget/policy + maker-checker 串接)→ **ES3**。
  - 動態 onboarding/deprovision、per-tenant Ed25519 key provision → **ES4**(ES1 ctor 預註冊 opts.tenants)。
  - intent 解析/clarify(Personal 專屬;Enterprise 直接收 GovernedCall)。
  - operator 身分認證面(console(ctx) 用 agent context 取 binding;真 operator auth 後續)。

## (4) Design delta + 模組 + 介面 + 依賴方向
- **Design delta**:純組合層,**不改任何既有模組**;只新增 `src/enterprise/bootstrap.ts` + 測試 + barrel。低耦合靠 DI(同 Personal/commitgate 模式)。
- **依賴方向(inward、acyclic)**:`enterprise/bootstrap` → `{tenant〔router/persistence/console〕, orchestration, commitgate, cost, policy, runtime/substrate, audit, personal〔ApprovalInbox〕, iam}` 皆經 barrel;無 cycle;無 vendor 進 core。
- **PUBLIC interface**:`createEnterpriseFleet(opts): EnterpriseFleet`(opts 注入 tenants/budget/allow rules)。

## (5) Test-first plan（RED 先行）
`src/enterprise/bootstrap.e2e.cross-tenant.test.ts`(bootstrap 不存在 → import RED):
- **happy(per-tenant)**:tenant-A `submitForApproval`→`{pending,id}`→`approve`→`executed` + FakeSandbox 建立 → `console(ctxA).timeline()` ≥1 筆該動作。
- **🔑 組合後整體跨租戶隔離(本刀核心,既有 conformance 未涵蓋)**:
  - tenant-A approve 後,`console(ctxB).timeline()` **看不到** A 的事件;A 的 WORM partition log 與 B 的是**不同實例**。
  - tenant-A 的 inbox **不核准** tenant-B 發的 id(approve(ctxB, A_id) → denied;反之亦然)。
  - `route(ctxB)` 永不回 binding-A(對照 conformance:resolve(ctxA) 只回 binding-A)。
- **治理短路(per-tenant)**:含 sk- secret canary → denied@screen;無 allow rule → denied@policy;budget 太小 → denied@cost。
- **fail-closed**:未註冊 tenant 的 ctx → route deny;approve 一次性(同 id 二次 → denied)。
- `pnpm run verify:cross-tenant` **仍綠**(組合根不得破壞既有三邊界閘)。
- 首次 RED 證據:import `./bootstrap.js` 失敗(exit≠0)。

## (6) Definition of Done（待實測填）
- [ ] RED:bootstrap 不存在 → e2e import 失敗 exit≠0。
- [ ] `pnpm run verify` exit 0(含 **`verify:cross-tenant` 綠**;e2e 全綠:happy + 組合跨租戶隔離 + 短路 + fail-closed)。
- [ ] **組合後跨租戶證明**:tenant-A 的 approve→WORM→timeline **不滲入** tenant-B(每租戶獨立 log/inbox/repo,closure-bound);mutation(改成共用單一 log/inbox + tenantId 參數)→ 該隔離斷言紅。
- [ ] **per-tenant 獨立實例**(非共用+參數):reviewer 檢視 + 測試證明 CostGate/WORM-log/inbox 每租戶一個。
- [ ] depcruise exit 0(enterprise 只經 barrel、無 cycle、無 vendor;reviewer 以 core 注入 deep-import → exit 2 實證邊界)。
- [ ] secret-scan clean(canary runtime 組裝);console/timeline 出口 allow-list(canary 不出現)。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:shared-log → 跨租 timeline 紅;route 回別租 binding → 隔離紅;移除 allow rule → policy 紅)。

## (7) Rollback
- `git revert <merge-sha>`(移除 `src/enterprise/bootstrap.ts` + 測試 + barrel)。純組合、無既有模組改動、可逆。

## (8) Depends-on / blocks
- Depends-on:R8-S1/S2/S4(router/persistence/console,DONE)、R8-S6(cross-tenant 閘,DONE)、P2-I(runGovernedToolCall)、P2-C(commitgate)、P2-G(InMemoryCostGate)、P2-A(FakeSandboxAdapter)、P2-E(evaluatePolicy tenant-scope)、Personal ApprovalInbox/SEAM 樣板(bootstrap.ts)。
- Blocks:ES2(live partition)、ES3(operator 動作)、ES4(onboarding)。
- 確認 slice DAG 無 cycle: ☑ 是
- **誠實前提**:ES1 證**同進程邏輯**多租戶隔離 + in-memory WORM;live per-tenant kernel partition、真 operator auth、per-tenant key provision、多進程物理隔離 = 後續/P4。
