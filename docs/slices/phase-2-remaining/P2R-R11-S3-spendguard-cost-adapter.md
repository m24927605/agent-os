# SLICE-P2R-R11-S3: SpendGuard cost adapter（over P2-G CostGate port）

- **Phase**: P2（R11 真實 vendor adapter — cost 槽位）
- **Branch**: slice/p2r-r11-s3-spendguard-cost-adapter
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~210、files <~4（`src/cost/adapters/spendguard/{adapter.ts,index.ts}` + `src/cost/adapters/spendguard/adapter.test.ts` + 餵進既有 `src/test-contracts/cost-gate-adapter.test.ts` 一行 registration）、modules <~2、新增第三方依賴 = 0
- **狀態**: **DONE**（實作 + 測試覆蓋；DoD 附實測 exit code；已 merge 進 main，no-ff）

## (1) ID + Title
SLICE-P2R-R11-S3 — 新增 `SpendGuardCostGate`：實作 P2-G `CostGate` port，把 SpendGuard 的 session-reservation ledger（`reserve_session` → `commit_session_delta`）對映成 `reserve`/`commit`，固守 hard-cap + reserve-before-effect + credential-blind，並把 SpendGuard 的 fail-OPEN 改寫成 **fail-CLOSED**。經**注入式 LedgerTransport** seam（live Postgres/gRPC ledger 留後續）。

## (2) Goal（一句話）
讓 SpendGuard 成為 `CostGate` port 的真實 vendor adapter，**over-budget reserve → deny（hard-cap）、in-flight overrun → committed{overrun:true}、credential-blind、transport/estimate 失敗 → deny（fail-closed）**，並通過既有 cost contract harness。

## (3) In-scope / Out-of-scope
- In-scope：
  - `src/cost/adapters/spendguard/adapter.ts`：`SpendGuardCostGate implements CostGate`（import 僅 `../../port.js` + `../../../iam/ids`）。
  - `reserve(ctx,{estimatedTokens,resource})` → SpendGuard reserve（tokens→`estimated_amount_atomic`、resource→`route`），回 `reservationId`；over-budget → `denyReserve`（hard-cap）。
  - `commit(ctx,reservationId,{actualTokens})` → SpendGuard commit-delta（actualTokens→`amount_atomic_delta`）；overrun → `committed{overrun:true}`，後續 reserve 全 deny；無前置 reservation 的 commit → deny。
  - **fail-closed 改寫**：estimate 缺失 / `LedgerTransport` error → `denyReserve`（deny-by-default，不沿用 SpendGuard 的 predictor-down fail-OPEN，decision.rs 對比見設計 §2.3）。
  - adapter 餵進既有 `cost-gate-adapter.test.ts` factory（過全部既有斷言）。
- Out-of-scope（明確不做）:
  - 真實 Postgres stored-proc / gRPC ledger 連線（live transport）→ 留 R1 後整合 slice。
  - `release(reservationId)`（commit-abort 釋放預留，對映 SpendGuard `release_session`，session_reservations.rs:129）→ **R12 follow-up**，本 slice 不做。
  - TTL sweeper / orphaned reservation 清理（five-piece §風險）→ 留整合 slice。
  - 多幣別 / pricing-freeze / fx-rate 細節（SpendGuard 的 `PricingFreezeRef`）→ 不對映（port 只認 token count）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 vendor adapter module；core port 不改；cost contract 加一個 impl。
- **Modules touched（唯一責任）**:
  - `src/cost/adapters/spendguard/adapter.ts` — 把 SpendGuard reserve/commit ledger 形狀對映成 `CostGate`，固守 hard-cap + credential-blind + fail-closed。
  - `src/cost/adapters/spendguard/index.ts` — 只 re-export `SpendGuardCostGate`（vendor barrel）。
- **PUBLIC interface（新增）**:
  - `class SpendGuardCostGate implements CostGate`（建構子注入 `ledger: LedgerTransport`）；
  - `interface LedgerTransport { reserve(req): Promise<{reservationId:string}|{overBudget:true}>; commit(req): Promise<{overrun:boolean}> }`（注入式 seam；live impl 由 R1 後 wire）。
- **Dependency direction（HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    cost/adapters/spendguard ──▶ cost/port.ts ──▶ iam/ids
    ```
  - 僅經 public surface 消費（無 deep import）: ☐ 是
  - 新依賴宣告：`LedgerTransport` 為 adapter 自有注入 seam（非跨 module、非第三方）；方向 inward、無 cycle；理由＝core 不 import SpendGuard、contract test 純 in-process（可腳本化回 ok/over-budget/error）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/cost/adapters/spendguard/adapter.test.ts`（module 不存在 → RED：import 失敗）；外加註冊進 `cost-gate-adapter.test.ts` factory。
- RED 測試清單:
  - [ ] `reserve` 正常 → ok + `reservationId`；token count 對映到 ledger amount。
  - [ ] **hard-cap**：ledger 回 `overBudget` → `reserve` denied（reason 標 hard-cap）。
  - [ ] `commit` 正常 → `committed{overrun:false}`；ledger 回 overrun → `committed{overrun:true}` 且**後續 reserve 全 deny**（budget 耗盡）。
  - [ ] 無前置 reservation 的 `commit`（unknown reservationId）→ denied。
  - [ ] 安全對抗式 — **credential-blind**：`reserve`/`commit` 介面只收 token count + resource，無 credential 欄位（沿用 contract 斷言）；adapter 不把任何 secret 傳進 ledger req。
  - [ ] 安全對抗式 — **fail-closed**：壞 ctx（`{}`/`null`/缺 tenantId）→ denied + contextError、永不 throw；非法 token count（非正整數）→ deny（`isValidTokenCount`）；`LedgerTransport` throw / estimate 缺 → `denyReserve`（**不 fail-open**）。
  - [ ] **no-vendor-in-core 回歸護欄**：core 植入 `import ... spendguard` fixture → `deps:check` exit≠0；移除後 exit 0。
- 首次紅燈證據（DRAFT 佔位）:
  ```
  $ pnpm test src/cost/adapters/spendguard/adapter.test.ts
  ... FAIL: Cannot find module '.../adapters/spendguard/index.js' ...
  exit code: <填實測，預期 1>
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5；git history 證順序：test 檔先紅燈於 module 不存在，後 impl 轉綠）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... typecheck ok / lint: Checked 168 files, no fixes / build ok
  ... Test Files 68 passed | 1 skipped (69)；Tests 673 passed | 1 skipped (674)
  ... deps:check: no dependency violations (111 modules, 263 deps)
  ... proto:check ok / openshell:proto:check ok / verify:go ok / verify:py ok
  ... verify:cross-tenant ok / launcher:check clean / secret-scan: clean
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`deps:check` exit 0；`no-vendor-in-core` 持綠：spendguard import 只在 `adapters/spendguard/`）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (111 modules, 263 dependencies cruised)
  exit code: 0
  # no-vendor-in-core.test.ts：6 tests passed（含「real src tree 無 vendor-in-core 違規」）
  ```
- [x] low coupling / high cohesion 遵守（adapter 僅 import `../../port.js` + `iam/ids`；無 deep import / cyclic / 跨 vendor）
- [x] secret-scan 乾淨（adapter / test / ledger req fixture 無 secret-like 值）
  ```
  $ pnpm run secret-scan
  secret-scan: clean
  exit code: 0
  ```
- [x] 隔離測試（slice adapter test）通過
  ```
  $ node_modules/.bin/vitest run src/cost/adapters/spendguard/adapter.test.ts
  Test Files 1 passed (1)；Tests 11 passed (11)
  exit code: 0
  # 既有 cost contract harness（cost-gate-adapter.test.ts）：19 tests passed（含 SpendGuardCostGate 註冊）
  ```
- [x] Docs 更新（`vendor-adapters.md` §2.3 已述）
- [x] Adversarial code review = PASS（fresh-context、非作者、獨立 Opus 4.8；mutation 驗 hard-cap/fail-closed 測試非 theater；確認 estimate-缺/transport-throw 真的 deny 而非 fail-open）
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（adversarially probed：over-budget deny、overrun 後續鎖死、無前置 commit deny、ledger-throw fail-closed、credential 不入 ledger req）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `adapters/spendguard/` + contract factory 一行）。
- 可逆性: 安全可逆——純新增 adapter module，無外部副作用 / 無 audit append（ledger 為 in-process fake transport）。

## (8) Depends-on / blocks
- Depends-on: **P2-G**（CostGate port + contract harness，DONE）；既有 `iam/ids`。
- Blocks: SpendGuard 的 **live wire 整合 slice**（depends-on R1，提供真實 ledger transport）；**R12**（`release(reservationId)` follow-up，建在本 adapter 之上）。
- 確認 slice DAG 無 cycle: ☐ 是（R11-S3 → P2-G rank-0；單向）。
