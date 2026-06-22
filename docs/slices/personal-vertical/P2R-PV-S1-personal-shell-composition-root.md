# SLICE-P2R-PV-S1: Personal shell composition root（最薄可執行主幹,純記憶體,end-to-end）

- **Phase**: P2（Personal 垂直切片;第一條「它會跑」的可執行主幹）
- **Branch**: slice/p2r-pv-s1-personal-shell-composition-root
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~200（`src/personal/bootstrap.ts` + `src/personal/bootstrap.e2e.test.ts` + barrel/接線）、新增依賴 = 0、modules <~1（`src/personal`,組裝既有 barrels）
- **狀態**: **DRAFT**

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

## (6) Definition of Done（待實測填）
- [ ] RED:bootstrap 不存在 → e2e import 失敗 exit≠0。
- [ ] `pnpm run verify` exit 0;e2e 全綠(happy + 5 短路/邊界)。
- [ ] depcruise exit 0(personal/bootstrap 只經 barrel 消費、無 cycle、無 vendor;無 not-to-internal 違規)。
- [ ] secret-scan clean(canary runtime 組裝);時間軸/preview 出口 redact(canary 不出現於 timeline 文字)。
- [ ] **關鍵接縫驗證**:appender 寫的 AuditEvent 與 timeline 讀的是同一份 log;`buildTaskTimeline` 折出的事件 sequence 與 append 一致。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:effect 移到 commit 前 / 移除 allow rule / approve 不 delete → 對應測試紅)。

## (7) Rollback
- `git revert <merge-sha>`(移除 `src/personal/bootstrap.ts` + 測試 + barrel 一行)。純組合,無既有模組改動,可逆。

## (8) Depends-on / blocks
- Depends-on:R7(personal/* 模組,DONE)、P2-I(`runGovernedToolCall`,DONE)、P2-C(commitgate)、P2-G(InMemoryCostGate)、P2-A(FakeSandboxAdapter)、P2-D(screenBrainEvent)、P2-E(evaluatePolicy)。
- Blocks:P2R-PV-S2(live append)、P2R-PV-S3(live 讀回)。
- 確認 slice DAG 無 cycle: ☑ 是
