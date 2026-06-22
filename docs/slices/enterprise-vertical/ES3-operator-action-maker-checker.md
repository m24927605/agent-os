# SLICE-ES3: operator 敏感動作端（maker-checker 閘 + commit-before-effect 審計）

- **Phase**: P3（Enterprise 垂直;把已建 `enforceMakerChecker` 串成可用的 operator 動作端）
- **Branch**: slice/es3-operator-action-maker-checker
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~190（`createEnterpriseFleet` 加 `operatorAction` + 測試）、新增依賴 = 0
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer = PASS;maker-checker 閘 + commit-before-effect 各經 mutation 證實;verify:cross-tenant 綠;採納 reviewer MINOR〔移除死 import〕）

## (0) 動機
R8-S5 已建 `enforceMakerChecker`(maker-checker.ts:66,五檢查),R8-S4 console 只交付**唯讀投影**——**動作端是 stub**(無 suspend/budget/policy)。ES3 補上 operator 敏感動作端:一條 **maker-checker 閘 + commit-before-effect 審計 + tenant-scoped effect** 的特權動作路徑。

## (1) ID + Title
SLICE-ES3 — 在 `createEnterpriseFleet`(`src/enterprise/bootstrap.ts`)加 `operatorAction(ctx, action, cap): Promise<OperatorResult>`:`route(ctx)〔gateway〕→ enforceMakerChecker(ctx, action, cap)〔deny 短路〕→ commitBeforeEffect(append operator AuditEvent → 該租戶 WORM,等 receipt 後才跑 effect)→ tenant-scoped effect`。交付一個具體動作 **suspend-agent**(effect:更新該租戶 repo 的 agent phase=`suspended`,可由 `console(ctx).fleet()` 觀測)+ 通用 enforcement 路徑。

## (2) Goal（一句話）
讓 operator 敏感動作**只有持有正確 capability 的非-maker checker** 能執行,且**先審計後生效**(commit-before-effect),跨租戶 capability/動作不符一律 fail-closed deny——把 maker-checker 從原語變成可用的治理動作端。

## (3) In-scope / Out-of-scope
- In-scope:
  - `EnterpriseFleet.operatorAction(ctx, action: {kind: string; resource: string}, cap: CheckerCapability): Promise<OperatorResult>`(`OperatorResult = {status:'ok', event} | {status:'denied', reason, event}`):
    1. `route(ctx)` → binding(fail-closed;未註冊 → deny)。
    2. `enforceMakerChecker(ctx, action, cap)`(maker-checker.ts:66)→ `effect:'deny'` 即短路 denied(cross-tenant cap / maker==checker / TOCTOU action-mismatch / malformed 全 deny)。
    3. `effect:'allow'` → `commitBeforeEffect({appender:該租戶 WORM SEAM appender(合成 operator AuditEvent:action.kind/resource、actorId=checker、policyDecision 由 maker-checker、result:'success'), effect:該動作的 tenant-scoped 變更})`(commitgate/guard.ts;append 失敗 → effect 不跑,fail-closed)。
    4. 具體動作 **suspend-agent**:effect 寫/更新**該租戶 repo** 的 agent 條目 phase=`suspended`(`store.forTenant(binding).put(...)`,key/shape 對齊 `ConsoleProjection.fleet()` 投影,projection.ts:55-61)→ `console(ctx).fleet()` 反映。
  - 單元/e2e(RED 先):見 §5。
- Out-of-scope（明確不做）:
  - **maker-checker capability 發行端**(誰簽/存哪/怎到 checker)= **out-of-band**(enforce 端已建,issue 端是缺口;ES3 測試自建 valid cap,**不假裝 issuance 已解**)。
  - live per-tenant WORM(ES2);動態 onboarding(ES4)。
  - 其餘動作(adjust-budget / change-policy)——ES3 交付 suspend-agent + 通用路徑,其餘沿用同路徑後續加。
  - 真 operator 身分認證(ctx 用 agent context;真 operator≠agent 身分過濾 = 後續,沿 ES1 風險)。

## (4) Design delta + 依賴方向
- `bootstrap.ts` 加 `operatorAction`(reuse `enforceMakerChecker` + `commitBeforeEffect` + 該租戶 WORM appender + repo);不改 R8 模組。依賴經 barrel(tenant〔maker-checker〕/commitgate/audit);無 vendor、無 cycle。
- **PUBLIC**:`EnterpriseFleet.operatorAction(ctx, action, cap)`。

## (5) Test-first plan（RED 先行）
`src/enterprise/operator-action.e2e.test.ts`(operatorAction 不存在 → RED):
- **happy**:valid cap(cap.tenantId===ctx.tenantId、makerActorId≠ctx.actorId、actionIdentity===deriveActionIdentity(action))→ allow → **operator AuditEvent 落該租戶 WORM**(audit-before-effect)→ effect → `console(ctxA).fleet()` 顯示該 agent phase=`suspended`。
- **maker-checker deny(本刀核心)**:cross-tenant cap(cap.tenantId≠ctx.tenantId)→ denied;maker==checker(cap.makerActorId===ctx.actorId)→ denied;**TOCTOU**(cap 綁 action X,執行 action Y)→ denied;malformed cap → denied。各 deny **effect 未跑**(repo/fleet 不變)。
- **commit-before-effect**:appender 失敗 → effect 不跑(reuse commitgate 既有保證;測試以 failing appender 證 effect 未跑)。
- **跨租戶隔離**:tenant-A 的 operatorAction 不改 tenant-B 的 fleet/WORM(tenant-scoped;route+appender+repo closure-bound)。`verify:cross-tenant` 仍綠。
- **fail-closed**:未註冊 tenant 的 ctx → route deny。
- 首次 RED:operatorAction 不存在 → import/型別錯。

## (6) Definition of Done（實測）
- [x] RED:`TypeError: fleet.operatorAction is not a function` + TS2339(operatorAction 不存在)→ 5 cases 全紅。
- [x] `pnpm run verify` **exit 0**(859 passed + 10 skipped;operator e2e 5/5;**ES1 e2e 4/4 不變**;`verify:cross-tenant: ok`〔TS 11 + Go partition Conformance〕)。
- [x] **maker-checker 閘非 vacuous(reused,不重寫 5 檢查)**:reviewer mutation 把 `if(decision.effect==="deny")`→`if(false)` → cross-tenant/maker==checker/TOCTOU/malformed **4 deny 全紅**;且各 deny case 斷言 `status==="denied"` **且** WORM/fleet 不變(effect 未跑)。
- [x] **commit-before-effect(reused,不重造 ordering)**:operator AuditEvent **先**落該租戶 WORM(action="suspend-agent"、result="success")才 effect;reviewer mutation 把 effect 移到 commitBeforeEffect 前 → failing-appender case 紅(append 失敗仍 suspend = 漏記)。
- [x] tenant-scoped 隔離(operatorAction 不改別租戶 fleet/WORM;wrong-tenant mutation → 隔離斷言紅);depcruise exit 0(barrel-only);secret-scan clean(deny reason 靜態、cap 不入 event/log)。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8;skip-deny / effect-before-audit / wrong-tenant 三 mutation 皆翻紅;8 攻擊面 HELD/N/A)。
- [x] **誠實標記**:capability **issuance out-of-band**(grep 無 issuer;測試自建 cap,**不假裝 issuance 已解**);真 operator auth 後續。
> **採納 reviewer MINOR**:移除 bootstrap.ts 死 import `deriveActionIdentity`(lint 未抓 unused import)。
> **追蹤 reviewer MINOR(後續,非阻斷)**:`failWormAppendFor` 測試-fault-injection 鉤子目前在 production `EnterpriseFleetOpts`(已 `TEST FAULT INJECTION ONLY` 註解、default never-fault、construction-time、**只能強制 fail-closed deny 不能 bypass**);後續移到 test-only seam(注入 faulting `CommitAppender`)使 opts 不含測試旋鈕。

## (7) Rollback
- `git revert <merge-sha>`(移除 `operatorAction` + 測試)。route/submit/approve/console 不受影響、可逆。

## (8) Depends-on / blocks
- Depends-on:ES1(createEnterpriseFleet + per-tenant WORM/repo)、R8-S5(enforceMakerChecker/deriveActionIdentity)、P2-C(commitBeforeEffect)、R8-S4(ConsoleProjection.fleet)。
- Blocks:無(operator 動作端;其餘動作沿同路徑後續)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:maker-checker enforcement 已可用,但 **capability issuance = out-of-band 缺口**(prod 需 issue 路徑:誰簽/存哪/分發);真 operator 身分認證 = 後續。
