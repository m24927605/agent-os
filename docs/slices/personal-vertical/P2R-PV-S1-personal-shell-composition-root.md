# SLICE-P2R-PV-S1: Personal shell composition root（最薄可執行主幹,純記憶體,end-to-end）

- **Phase**: P2（Personal 垂直切片;第一條「它會跑」的可執行主幹）
- **Branch**: slice/p2r-pv-s1-personal-shell-composition-root
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~200（`src/personal/bootstrap.ts` + `src/personal/bootstrap.e2e.test.ts` + barrel/接線）、新增依賴 = 0、modules <~1（`src/personal`,組裝既有 barrels）
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer = PASS,shared-log seam 經 mutation 證實為真,零 BLOCKER/MAJOR）

## (1) ID + Title
SLICE-P2R-PV-S1 — 新增 composition root `createPersonalShell(deps)`,把 R7 的 IntentGateway/Clarify/PlanPreview/ApprovalInbox/TaskTimeline + P2-I `runGovernedToolCall` + commit-before-effect + CostGate + effect 接成一條**可呼叫、可跑的主幹**:`文字 → 澄清 → 白話計畫 → 核可 → 治理管線 → effect → 時間軸`。全程**純記憶體 in-tree 實作**(無網路、無 kernel 行程),先證明「整條垂直接得起來且會跑」。

## (2) Goal（一句話）
第一次把 Personal surface 的各模組組裝成一個人(或測試)能驅動的完整流程,並用端到端測試證明 happy path 成功落 effect + 可讀時間軸、且三道治理閘(screen/policy/cost)與核可一次性、澄清上限都正確短路。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/personal/bootstrap.ts`:`createPersonalShell(opts)` 回傳一個門面,至少含:
    - `receive(text, ctx)` → `ReceiveOutcome`(包 `receiveText`);需要澄清時 `clarify`/`answer`(包 `startClarify`/`answerClarify`)。
    - `previewAndSubmit(intent)` → 由 `renderPlanPreview` 產 preview + `buildToolCall(intent)` 建 `GovernedCall`,`inbox.submit(preview, call)` → `{pending,id}|{denied}`。
    - `approve(id)` → `inbox.approve(id)`(注入的 `run = (tc) => runGovernedToolCall(deps, tc)`)→ `DecideOutcome`。
    - `timeline(taskId?)` → `buildTaskTimeline(sharedLog.entries(), {taskId, redact})`。
  - **`buildToolCall(intent): GovernedCall`**:由 `intent.action`/`targets` 推導 `{tool, context: intent.context}`(deterministic;tool 字串規則明確、無 vendor)。
  - **共享 WORM appender adapter**(關鍵接縫,見 INDEX §2):一個 `CommitAppender`,`append(structuralEvent)` 時用 `createAuditEvent({...structuralEvent.context, action, resource, policyDecision:{effect:"allow",reason}, result:"success"})` 合成 AuditEvent → 寫進**共享 `InMemoryAppendOnlyLog`** → 回其 `AppendReceipt`;同一份 log 供 `buildTaskTimeline` 讀。
  - 注入的 pipeline deps(沿用 `pipeline.e2e.test.ts:50-88` makeDeps 樣板,但 appender 換成上面的共享版):`screen=screenBrainEvent(tc,detectSecret)`、`authorize=evaluatePolicy+combineDecisions`(**注入 `allow tool:invoke` rule**)、`cost=InMemoryCostGate(budget)`、`estimateTokens=()=>10`、`effect=FakeSandboxAdapter.createSandbox`。
  - barrel:`src/personal/index.ts` 匯出 `createPersonalShell`(+ 既有 personal 匯出)。
- Out-of-scope（明確不做）:
  - live kernel append / 真 WORM → **P2R-PV-S2**;live 讀回時間軸 → **P2R-PV-S3**。
  - docker-compose 起整套 / 映像 build / 埠修正 → 部署(S2+)。
  - 語音(R7-S7,已 inactive gate)、真 STT。
  - 多 intent/多步驟 Task FSM(R5)編排(本刀單一 GovernedCall;Task 編排後續)。

## (4) Design delta + 模組 + 介面 + 依賴方向
- **Design delta**:純組合層,**不改任何既有模組**;只新增 `src/personal/bootstrap.ts` + 測試 + barrel 一行。低耦合靠依賴注入(同 commitgate/pipeline 模式)。
- **依賴方向(inward、acyclic)**:`src/personal/bootstrap` → `{personal/intent, personal/plan, personal/approval, personal/timeline, orchestration, commitgate, cost, runtime/substrate, audit, iam}` 皆經 barrel(iam 沿用現有 interim 直 import);無 cycle;無 vendor 進 core。
- **PUBLIC interface**:`createPersonalShell(opts: PersonalShellOpts): PersonalShell`(opts 注入 budget / allow rules / effect,預設給 in-memory 主幹值)。

## (5) Test-first plan（RED 先行）
`src/personal/bootstrap.e2e.test.ts`(bootstrap 不存在 → import RED):
- **happy path**:合法文字 → preview 非空 → `previewAndSubmit` 得 `{pending,id}` → `approve(id)` → `DecideOutcome.status==='executed'` 且 FakeSandbox 真被建立(start probe ok)→ `timeline()` ≥1 筆、headline 為「已完成/executed」。
- **screen 短路**:文字/args 含 runtime 組裝 secret canary(`sk-${"d".repeat(24)}`)→ pipeline `denied@screen`、effect 未跑。
- **policy 短路**:不注入 allow rule(或 deny)→ `denied@policy`。
- **cost 短路**:budget 太小 / estimate 過大 → `denied@cost`。
- **approve 一次性**:同 id 第二次 `approve` → denied(已 terminal,防 replay)。
- **clarify 上限**:模糊文字連續 answer 超過 `CLARIFY_MAX_QUESTIONS=3` → clarify `denied`。
- 首次 RED 證據:import `./bootstrap.js` 失敗(exit≠0)。

## (6) Definition of Done（實測）
- [x] RED:移除 bootstrap.ts → `vitest run bootstrap.e2e.test.ts` → exit 1（`Failed to load url ./bootstrap.js`,0 tests）。
- [x] `pnpm run verify` **exit 0**（740 passed + 4 skipped;含 6 個 e2e:happy + screen/policy/cost 短路 + approve-once + clarify-cap)。
- [x] depcruise **exit 0**（119 modules / 298 deps,0 violations;bootstrap 只經 barrel,iam/ids 為現有 interim 例外;reviewer 以 core 注入 deep-import → exit 2 實證邊界仍 live)。`src/audit/index.ts` 加值匯出 `createAuditEvent`/`InMemoryAppendOnlyLog`(純加、0 刪)以走 barrel 而非 deep-import。
- [x] secret-scan clean(canary runtime 組裝);**canary 不出現於 timeline 文字**(happy + denied 兩路皆斷言;denied@screen 時 FakeSandbox 確未建立)。
- [x] **關鍵接縫驗證(PASS)**:appender 用 `createAuditEvent` 合成 AuditEvent 寫進**共享 `InMemoryAppendOnlyLog` 同一實例**,timeline 讀同一份;append 順序 == timeline sequence。mutation(fresh-log-per-append / 合成 result:"denied")皆使 happy-path 轉紅,證明 seam 為真非巧合。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8;5 mutation 各殺對應測試:force-allow→policy 紅、screen-always-ok→screen 紅、estimate→1→cost 紅、appender denied→headline 紅、fresh-log→happy+approve-once 紅)。
> **MINOR follow-up(F1,非阻斷)**:commit-before-effect 時序**不由本刀 e2e 自身斷言**——它重用已驗證的 `commitBeforeEffect` 組合子(其時序由 `commitgate/guard.test.ts` pin;reviewer 確認該 mutation 會使上游測試紅)。若日後有人重接 seam 繞過 `commitBeforeEffect`,本刀 e2e 不會抓到。後續可在 composition e2e 補一條 append-before-effect 順序斷言。

## (7) Rollback
- `git revert <merge-sha>`(移除 `src/personal/bootstrap.ts` + 測試 + barrel 一行)。純組合,無既有模組改動,可逆。

## (8) Depends-on / blocks
- Depends-on:R7(personal/* 模組,DONE)、P2-I(`runGovernedToolCall`,DONE)、P2-C(commitgate)、P2-G(InMemoryCostGate)、P2-A(FakeSandboxAdapter)、P2-D(screenBrainEvent)、P2-E(evaluatePolicy)。
- Blocks:P2R-PV-S2(live append)、P2R-PV-S3(live 讀回)。
- 確認 slice DAG 無 cycle: ☑ 是
