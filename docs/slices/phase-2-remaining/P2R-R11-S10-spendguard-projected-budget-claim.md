# SLICE-P2R-R11-S10: projected BudgetClaim 編碼（config-driven route→budget,credential-blind、fail-closed）

- **Phase**: P2（R11 SpendGuard live；裁決 (a)：SpendGuard 為正式生產成本閘 → 送真實 projected BudgetClaim）
- **Branch**: slice/p2r-r11-s10-projected-budget-claim
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~160（`decision-transport.ts` encoder+config 擴充 + `decision-transport.test.ts` 補測）、新增依賴 = 0
- **狀態**: **DONE**（merged;encoder 擴充 + config-driven claim;對真實 demo 已驗 budget-backed CONTINUE;獨立 Opus 4.8 review = PASS）
> **實作註記(誠實偏離 spec)**:claim 採 **config + 手寫 proto3 線格編碼**(`encodeBudgetClaim`,與 transport 既有手寫 codec 一致),**未**為 BudgetClaim/UnitRef regen 型別 stub(§3 原寫「擴 vendored proto subset + regen」)——手寫更輕、且 live 已逐位元驗證對真實 sidecar 正確,故不另 regen。

## (1) ID + Title
SLICE-P2R-R11-S10 — 因 R11-S9 live ground-truth 證實真實 sidecar 要求 `DecisionRequest.inputs.projected_claims` 非空,擴充 `createDecisionLedgerTransport` 送一個由 **config-driven route→budget 映射** 構出的 projected `BudgetClaim`(`Inputs.projected_claims` field 1,repeated),使真實 sidecar `RequestDecision` 能對有效預算回 **CONTINUE**(額度內)/ **STOP**(超額)。route→budget 的翻譯住在 **adapter/transport(非 core port)**——保 pluggability 與 credential-blind。

## (2) Goal（一句話）
讓 transport 對真實 SpendGuard 送出 ledger 認得的 projected BudgetClaim(budget/unit/window/amount/direction),補上 live 的最後一道必填 gate,讓 S9 能拿到 budget-backed CONTINUE。

## (3) In-scope / Out-of-scope
- In-scope:
  - `DecisionLedgerTransportOpts` 新增 **budget-claim 設定**(credential-blind 成本識別,非 secret):
    `budgetClaim?: { budgetId: string; unitId: string; windowInstanceId: string; direction?: "DEBIT"|"CREDIT" }`
    (生產上由 deployment config 提供;route→budget 映射可後續擴成 map,本刀先支援單一預設 claim)。
  - 擴 vendored proto subset:`BudgetClaim`(common.proto:232-246:budget_id=1, unit=2 UnitRef, amount_atomic=3, direction=4 enum DEBIT=1, window_instance_id=5)、`UnitRef`(unit_id=1, kind=2)、`Inputs.projected_claims`(field 1 repeated);regen stub;`spendguard:proto:check` 綠。
  - encoder:`encodeDecisionRequestInputs` 送 `projected_claims`(field 1,repeated,length-delim)= 巢狀 BudgetClaim(內含巢狀 UnitRef)。`amount_atomic` 由 `req.estimated_amount_atomic` 映成十進位字串(token unit scale=0 → 直接 token 數)。
  - reserve():當 `budgetClaim` 設定存在 → 送一個 DEBIT claim;**未設定 → fail-closed**(無法構成有效 reserve,deny-by-default,不送空 claim 騙過)。
  - **credential-blind**:claim 只含 budget/unit/window 識別 + 成本數量;無 credential(測試斷言)。
  - 單元測試對 in-process fake(**fake 現在須驗 projected_claims 非空 + 解出 budget_id/unit_id/amount/direction**,關閉「fake 不檢查就遮蔽」缺口):CONTINUE/STOP/未設定 budgetClaim→fail-closed/解碼斷言 claim 欄位正確。
- Out-of-scope（明確不做）:
  - 對真實 demo 的 live e2e → **R11-S9**(本刀讓 S9 能綠)。
  - 多 route→多 budget 的 map(本刀單一預設 claim;map 後續)。
  - ConfirmPublishOutcome 的 actual-amount 細修(commit 已可送;S9 live 若揭露 commit gate 再補)。
  - Multi-claim / USD unit(本刀 token unit `66666666…`)。

## (4) Design delta + 模組 + 介面 + 依賴方向
- **Design delta**:`decision-transport.ts` encoder + opts 擴充;vendored proto subset + regen。route→budget 映射 = transport config(SpendGuard-specific 翻譯住 adapter 層,core CostGate port 仍只 `{resource, estimatedTokens}`)。
- **依賴方向 / 封閉**:grpc-js + stub 仍只在 `src/runtime/spendguard/`;depcruise 綠(reviewer 實證 core 注入→exit≠0)。
- **PUBLIC interface**:`createDecisionLedgerTransport({ udsPath, tenantIdAssertion?, budgetClaim?, timeoutMs? })`。

## (5) Test-first plan（RED 先行）
- 先擴 `decision-transport.test.ts`:fake decision handler 解出 projected_claims(若空 → 回 INVALID 等價,使我方測試對「未送 claim」轉紅);RED 清單:
  - 設定 budgetClaim + reserve → 解出的 claim.budget_id/unit_id/amount/direction 正確(decode 斷言)。
  - 未設定 budgetClaim → reserve **reject/deny**(fail-closed)。
  - amount_atomic == estimatedTokens 的十進位字串。

## (6) Definition of Done（實測）
- [x] RED:reserve 未送 projected_claims 時,`decodeFirstBudgetClaimForTest` 斷言會紅(reviewer mutation 驗證)。
- [x] `pnpm run verify` **exit 0**;decision-transport 單元測試 **16 passed**(含 claim 編碼斷言 + 未設定 budgetClaim→fail-closed)。
- [x] depcruise exit 0 + 封閉性(grpc-js/stub 仍只在 `src/runtime/spendguard/`)。
- [x] fail-closed:未設定 budgetClaim → reserve reject(deny-by-default,不送空 claim);secret-scan clean;claim 只含 budget/unit/window/amount(credential-blind,測試斷言)。
- [x] **LIVE 驗證**:`pnpm run e2e:live-spendguard` 對真實 demo sidecar → reserve(額度內 10)= **CONTINUE + 真實 reservationId**、commit = **committed**、reserve(600>500 餘額)= **denied(fail-closed)**;`LIVE_E2E_PASS`。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8)。
> 真實 over-budget 經 sidecar 自身 `RecordDeniedDecision`(matched_rule_ids must be non-empty when DENY)→ INTERNAL → 我方 adapter fail-closed deny。**安全結果正確(over-budget 被拒)**;乾淨 STOP→overBudget 由單元測試(fake)覆蓋。此為 vendor demo 端 bug,記為 follow-up。

## (7) Rollback
- `git revert <merge-sha>`(移除 claim 編碼 + opts + subset 擴充)。S8 的 tenant/idempotency 修正不受影響。

## (8) Depends-on / blocks
- Depends-on:R11-S8（decision transport + tenant/idempotency fix,DONE）;研究 ground-truth(seeded budget 4444 / unit 6666 / window 5555 / 餘額 500)。
- Blocks:R11-S9（live e2e 用此 claim 對真實 demo 拿 CONTINUE）。
- DAG 無 cycle: ☑
