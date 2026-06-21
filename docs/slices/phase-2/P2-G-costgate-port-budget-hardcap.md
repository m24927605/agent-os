# SLICE-P2-G: vendor-neutral CostGate port + reserve/commit + budget hard-cap（≥2 impls）

- **Phase**: P2（five-piece — CostGate 槽位；成本閘可插拔）
- **Branch**: slice/p2-g-costgate-port
- **Author**: <id>    **Adversarial reviewer**: <fresh-context、非作者>
- **Size budget**: <= 1 day；net LOC <~280、files <~6（`src/cost/{port.ts,null.ts,in-memory.ts,index.ts}` + `src/test-contracts/cost-gate-adapter.test.ts` + `src/index.ts` barrel）、新增依賴 = 0
- **狀態**: **DONE**（merge；fresh-context IV = PASS；IV 的 DEFECT-1 已修：commit 超支記為 overrun 而非無上限）

## (1) ID + Title
SLICE-P2-G — 新增 vendor-neutral **CostGate port**（`reserve`/`commit`，Stripe-style auth/capture）+ **≥2 impl**（`NullCostGate` 失敗封閉 deny-all；`InMemoryCostGate` 帶 token 預算的 **hard-cap**）+ contract harness。SpendGuard 為日後真實 adapter（落 `src/cost/adapters/spendguard/`）。

## (2) Goal（一句話）
讓「成本閘」成為**可驗的可插拔槽位**，並把兩條安全不變量變指令可驗：**reserve-before-effect**（先預留才放行）與 **budget hard-cap**；且 port **credential-blind**（介面只收 estimatedTokens/resource，從不收憑證）。
> **誠實校正（IV DEFECT-1）**：hard-cap 是**對 reserve 的 proactive 上限**（擋住「開新的超預算工作」）。`commit` 的 `actualTokens` 是**已發生的真實花費**（provider 已被呼叫）——不可事後 deny（否則 WORM 少記真實花費，違反不可逆 external effect 原則）；超預算的 commit **如實記錄並標 `overrun: true`**，且使預算耗盡 → **後續每個 reserve 被擋**（reactive）。即「不能**開始**超預算工作；單一 in-flight 估算不準的 overshoot 會被記錄、不會被抹除」——對齊 SpendGuard 的 OVERRUN_DEBT。

## (3) In-scope / Out-of-scope
- In-scope：`CostGate` 介面（`reserve(ctx,{estimatedTokens,resource})`→ ok+reservationId | denied；`commit(ctx,reservationId,{actualTokens})`→ committed | denied）；可稽核 `CostEvent`（phase=reserve|commit、result、context?/contextError?、resource?、reason?）；`NullCostGate`（deny-all，fail-closed）；`InMemoryCostGate`（per-instance token 預算、reserve 扣減/hold、over-budget → deny、commit 結算、unknown reservationId → deny）；contract test（factory over 2 impl + credential-blind 結構斷言）。
- Out-of-scope：真實 SpendGuard Rust ledger/Postgres adapter（後續，落 adapters/spendguard/）；把 CostGate 接進 OpenShell inference.local egress（整合 slice）；把 cost decision 餵進 WORM kernel（後續 ingest）；estimation predictor（SpendGuard 內部）。

## (4) Design + 模組 + 介面 + 依賴方向
- **Design delta**：純 port + 2 impl + 共享 contract，模式同 P2-A（substrate）/P2-D（brain）。
- **PUBLIC interface（src/cost/port.ts）**：
  - `ReserveResult = {status:"ok", reservationId:string, event:CostEvent} | {status:"denied", reason:string, event:CostEvent}`；
  - `CommitResult = {status:"committed", event:CostEvent} | {status:"denied", reason:string, event:CostEvent}`；
  - `interface CostGate { reserve(ctx:unknown, req:{estimatedTokens:number, resource:string}): Promise<ReserveResult>; commit(ctx:unknown, reservationId:string, settle:{actualTokens:number}): Promise<CommitResult>; }`；
  - 共享 `deny()`（fail-closed on 壞 ctx，同 substrate）+ `ok` builder。
- **不變量**：壞 ctx → denied（fail-closed）；`estimatedTokens` 非有限正整數 → denied（fail-closed）；over-budget reserve → denied（hard-cap）；commit 未知 reservationId → denied（reserve-before-effect：沒先 reserve 不能 commit）；**介面不收任何 credential 欄位**（credential-blind by construction）。
- **依賴方向**：`null.ts`/`in-memory.ts` → `port.ts`（同模組 cost）；port → `iam/ids`（AgentContext 驗證，allowlisted）。barrel 經 `src/index.ts`。`cost` 已在 no-vendor-in-core 的 core from-list（AGENTS.md 規則含 `cost`）。

## (5) Test-first plan（RED 先行）
`src/test-contracts/cost-gate-adapter.test.ts`（cost 模組不存在 → RED：import 失敗）：
- factory over [Null, InMemory]：reserve/commit 回 schema-valid CostEvent、`status===event.result`、壞 ctx → denied+contextError、永不 throw。
- Null 專屬：reserve 一律 denied（deny-all reason）。
- InMemory 專屬：(a) reserve estimated<=budget → ok + reservationId；(b) **over-budget → denied（hard-cap）**；(c) **reserve-before-effect**：commit 未知 reservationId → denied；(d) 連續 reserve 累加扣減直到 hard-cap。
- credential-blind 結構斷言：`port.ts` 不含 credential/secret/token-bearing 欄位名（只 estimatedTokens/actualTokens 數值 + resource id）。
> 預期首次 RED：import `../cost/index.js` 失敗。

## (6) Definition of Done（實測）
- [x] **first RED**（cost 模組不存在）：`vitest run cost-gate-adapter.test.ts` → import 失敗、no tests（exit≠0）。
- [x] `pnpm run verify` **exit 0**（118 tests、deps 27 modules 0 violations、secret-scan clean）。
- [x] `deps:check` 綠（IV 確認 cost/* 只 import `./port.js` + `iam/ids`、無 vendor；no-vendor-in-core 綠；`cost` 在 core from-list）。
- [x] secret-scan clean；credential-blind 結構斷言（strip 註解後掃，IV 確認 sound）。
- [x] **Adversarial review = PASS**（fresh-context IV；reserve hard-cap、reserve-before-effect、double-commit 不可、denied reserve 不漏預算、non-finite/壞 ctx 兩側 fail-closed 皆 held；3 種 mutation 皆被抓）。**IV DEFECT-1（commit actual 無上限）已修**：超支 commit 如實記錄 `overrun: true`、預算耗盡使後續 reserve 被擋（加 OVERRUN + overrun=false 兩測試鎖定）。

## (7) Rollback
revert commit（移除 cost 模組 + barrel 一行）。

## (8) Depends-on / blocks
- Depends-on：既有 `iam/ids`（AgentContext）。
- Blocks：真實 SpendGuard adapter；CostGate 接進 inference.local egress + 餵 WORM kernel 的整合 slice。
