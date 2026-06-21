# SLICE-P2-I: governed intent→effect pipeline — 五槽位組合證明（over fakes, end-to-end）

- **Phase**: P2（five-piece — 組合層；證明五個 port 接縫真的合得起來）
- **Branch**: slice/p2-i-governed-pipeline
- **Author**: <id>    **Adversarial reviewer**: <fresh-context、非作者>
- **Size budget**: <= 1 day；net LOC <~260、files <~4（`src/orchestration/{pipeline.ts,index.ts}` + `src/orchestration/pipeline.e2e.test.ts` + `src/index.ts` barrel）、新增依賴 = 0
- **狀態**: DRAFT（實作後以真實 exit code 覆蓋 §5/§6 並標 DONE）

## (1) ID + Title
SLICE-P2-I — 新增 `runGovernedToolCall(deps, toolCall)`：把一個 brain 提議的 ToolCall 走完**受治理管線**——credential-blind screen → policy authorize（PDP 唯一權威）→ cost reserve（hard-cap）→ **commit-before-effect**（append→receipt 才放行）→ effect → cost commit——並用一個**端到端整合測試**證明四個短路點與 commit 時序在真實 fake adapter 上組合正確。

## (2) Goal（一句話）
第一次讓整條脊椎**當一條流跑起來**並可驗:證明五個 vendor-neutral port 的**接縫真的合得起來**、deny/over-budget/credential 違規會**短路且不發生 effect**、effect 只在 audit receipt 之後發生——在投資真實 OpenShell/NemoClaw adapter **之前**用 fake 把架構打臉。

## (3) In-scope / Out-of-scope
- In-scope：`runGovernedToolCall` 管線（依注入的 deps 串接，低耦合）；`GovernedOutcome`（executed | denied+stage）；端到端整合測試（**用既有真實 fake/實作**接線：brain credential-guard `screenBrainEvent`、PDP `evaluatePolicy`+`combineDecisions`、`InMemoryCostGate`、in-memory commit appender、`FakeSandboxAdapter` 當 effect）。
- Out-of-scope：完整 Task/AgentSession FSM + resume ledger（後續 slice）；真實 vendor adapter（OpenShell/NemoClaw/Hermes/SpendGuard/AGT）；approval inbox（後續）；commit-abort 後的 cost reservation 釋放（CostGate 無 release op — 記為 follow-up，見 §8）。

## (4) Design + 模組 + 介面 + 依賴方向
- **Design delta**：純組合層；不重寫任何既有 port。低耦合靠**依賴注入**（同 commitgate/brain-guard 模式）：pipeline 只 import 有 barrel 的模組型別（`ToolCall` from runtime/brain、`CostGate` from cost、`commitBeforeEffect`/`CommitAppender` from commitgate），其餘能力（screen/authorize/effect）以注入函式提供，由 composition root（測試）接真實實作。**不** import 無 barrel 的 policy/audit internals（避免 not-to-internal 違規）。
- **PUBLIC interface（src/orchestration/pipeline.ts）**：
  - `GovernedToolCallDeps<R> = { screen:(tc)=>{ok:true}|{ok:false,reason}; authorize:(tc)=>{effect:"allow"|"deny",reason}; cost:CostGate; estimateTokens:(tc)=>number; appender:CommitAppender<unknown,R>; effect:(tc)=>Promise<{ok,detail?,tokensUsed?}> }`；
  - `GovernedOutcome<R> = {status:"executed", reservationId, receipt:R, detail?} | {status:"denied", stage:"screen"|"policy"|"cost"|"commit", reason}`；
  - `runGovernedToolCall<R>(deps, toolCall:ToolCall): Promise<GovernedOutcome<R>>`。
- **順序 + 短路（fail-closed）**：① screen 失敗 → denied@screen（不 authorize、不 reserve、不 effect）；② authorize deny → denied@policy；③ cost.reserve denied（over-budget）→ denied@cost；④ commitBeforeEffect：append→receipt 失敗 → denied@commit、**effect 絕不執行**；⑤ effect 執行後才 cost.commit(actual)。
- **依賴方向**：orchestration → {runtime/brain, cost, commitgate}（皆經 index barrel）；無 cycle（這些模組不 import orchestration）；orchestration 在 no-vendor-in-core core from-list、無 vendor import。

## (5) Test-first plan（RED 先行）
`src/orchestration/pipeline.e2e.test.ts`（pipeline 不存在 → RED：import 失敗），用**真實既有 fake** 接線：
- **happy path**：clean ToolCall + allow rule + 充足 budget + 正常 appender → `executed`；effect 真的跑（FakeSandboxAdapter 有建 sandbox）；cost committed。
- **screen 短路**：ToolCall args 含 secret（runtime 組裝 canary）→ denied@screen；effect 未跑（FakeSandbox 無 sandbox）。
- **policy 短路**：PDP deny（或 tenant-mismatch / secondary 不影響）→ denied@policy；effect 未跑。
- **cost 短路**：estimate > budget → denied@cost；effect 未跑。
- **commit 短路（時序）**：appender reject → denied@commit；**effect 未跑**（FakeSandbox 無 sandbox）——證 commit-before-effect。
- **PDP 唯一權威**：secondary allow + PDP deny → denied@policy（用 combineDecisions 接線）。
> 預期首次 RED：import `./pipeline.js` 失敗。

## (6) Definition of Done（待填）
- [ ] first RED exit code 已貼。
- [ ] `pnpm run verify` exit 0。
- [ ] `deps:check` 綠（orchestration 只經 barrel import、無 vendor、無 cycle、no-vendor-in-core 綠）。
- [ ] secret-scan clean（secret canary runtime 組裝）。
- [ ] Adversarial review = PASS（含 mutation：把 effect 移到 screen/policy/cost/commit gate 之前任一處 → 對應短路測試紅；commit-abort 仍跑 effect → 時序測試紅）。

## (7) Rollback
revert commit（移除 orchestration 模組 + barrel 一行）。

## (8) Depends-on / blocks
- Depends-on：P2-A（substrate/FakeSandboxAdapter）、P2-C（commitgate）、P2-D（brain credential-guard）、P2-E（PDP dedup）、P2-G（CostGate）。
- Blocks：live OpenShell substrate adapter、NemoClaw hosting adapter、IntentGateway、Task/AgentSession FSM。
- **Tracked follow-up**：commit-abort（append 失敗）後 reserve 仍 held → CostGate 需 `release(reservationId)` op（後續 slice）；本 slice 誠實記為 denied@commit 並標註此邊界。
