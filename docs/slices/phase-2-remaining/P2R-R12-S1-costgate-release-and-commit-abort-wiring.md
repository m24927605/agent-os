# P2R-R12-S1: CostGate `release(reservationId)` + commit-abort 接線（abort 釋放被 hold 的預留）

- **Phase**: P2（five-piece — CostGate 槽位收尾；ITEM R12 of [phase-2-remaining/INDEX.md](./INDEX.md)）
- **Branch**: slice/p2r-r12-s1-costgate-release-commit-abort
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~180、files <~6（`src/cost/{port.ts,null.ts,in-memory.ts}` + `src/test-contracts/cost-gate-adapter.test.ts` + **既有** `src/orchestration/pipeline.ts`（改 abort 分支）+ **既有** `src/orchestration/pipeline.e2e.test.ts`（擴一條 abort→release 斷言））、modules ≤ 2（cost + orchestration 接線）、新增依賴 = 0、新建檔 = 0（皆擴既有檔）
- **狀態**: **DONE**

## (1) ID + Title
P2R-R12-S1 — 在 CostGate port 新增 `release(reservationId)`（歸還仍 RESERVED 的預留：`held -= reserved`、`settled` 不變），於兩個 in-tree impl 實作，並把 `commitBeforeEffect` 的 **abort 路徑**接上 `release`，關閉「reserve-then-abort 預算洩漏」。

## (2) Goal（一句話）
讓「reserve 成功但 effect 之前 abort」能**透過 `release(reservationId)` 歸還被 hold 的預留**，使 hard-cap 不被 reserve-then-abort 慢性侵蝕。

## (3) In-scope / Out-of-scope
- In-scope：
  - port 新增 `release(ctx:unknown, reservationId:string): Promise<ReleaseResult>` + `ReleaseResult` 型別 + `CostEvent.phase` union 加 `"release"` + `denyRelease` builder（fail-closed，沿用 `contextOrError`）。
  - `InMemoryCostGate.release`：仍 RESERVED → `held -= reserved`、`reservations.delete`、`settled` 不變、回 `released`；未知/已終結 reservationId → `denied`（冪等、deny-by-default，不重複歸還、不扣負）。
  - `NullCostGate.release`：一律 `denied`（deny-all，fail-closed）。
  - contract harness 擴 release 不變量（factory over [Null, InMemory]）。
  - **修改既有** `runGovernedToolCall`（`src/orchestration/pipeline.ts:53-106`）的 abort 分支（`:90-93`，已 import `cost`/`commitgate` barrel：`:16-17`）：reserve 成功後若 `commitBeforeEffect` 回 `aborted`，呼叫 `deps.cost.release(toolCall.context, reservation.reservationId)` 歸還預留（不新建 helper、不讓 commitgate import cost）。
- Out-of-scope（明確不做）：
  - 真實 SpendGuard `Release` RPC adapter → 留給 **R11**（vendor adapter）。
  - TTL 過期自動 release / 背景 reaper → 留給 R11 / R6。
  - 把 release 接進真實 inference egress + 餵 WORM kernel → 留給 **R6 / R2**。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：CostGate 從 reserve/commit 兩態補成 reserve/commit/**release** 三態（auth/capture/**void**）。`release` 是與 `commit` 互斥的第三條終結邊；既有 `runGovernedToolCall` 的 abort 分支（`src/orchestration/pipeline.ts:90-93`，目前 inline 註解已記「reservation remains held … no release op yet — tracked follow-up」）改為觸發 `release`。
- **Modules touched（唯一責任）**：
  - `src/cost/port.ts` — CostGate 契約：新增 release 邊與其結果/事件型別 + fail-closed builder。
  - `src/cost/in-memory.ts` — deterministic 預算閘：實作 release 歸還語義 + 冪等防 double-release。
  - `src/cost/null.ts` — fail-closed deny-all：release 一律 denied。
  - `src/orchestration/pipeline.ts`（既有）— `runGovernedToolCall` abort 分支：abort ⇒ `cost.release`（已注入 `CostGate`，經 barrel `:16-17`，零 deep-import）。
- **PUBLIC interface（新增/變更）**：
  - `type ReleaseResult = { status:"released"; event:CostEvent } | { status:"denied"; reason:string; event:CostEvent }`
  - `CostEvent.phase: "reserve" | "commit" | "release"`（union 加一項）
  - `interface CostGate { reserve(...); commit(...); release(ctx:unknown, reservationId:string): Promise<ReleaseResult>; }`
  - `function denyRelease(ctx:unknown, reason:string): ReleaseResult`
  - orchestration：**無新公開簽章**——只在既有 `runGovernedToolCall` 的 abort 分支內加一次 `await deps.cost.release(...)`（行為變更：abort 不再洩漏 held 預留）。
- **Dependency direction（inward、acyclic）**：
  - 箭頭圖：
    ```
    orchestration/pipeline.ts ──▶ cost(barrel) + commitgate(barrel)   [注入，無 deep-import；箭頭已存在於 :16-17]
    cost/{null,in-memory}.ts ──▶ cost/port.ts ──▶ iam/ids
    ```
  - 僅經 public surface 消費（無 deep import）: ☐ 是（commitgate 不得被 cost import；接線只在 orchestration 上層）
  - 新依賴宣告：**無新跨 module / 第三方依賴**。orchestration→cost / →commitgate 經各自 barrel；方向向內、無 cycle；理由＝關閉預算洩漏（既有缺口，非 YAGNI 擴張）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`src/test-contracts/cost-gate-adapter.test.ts`（擴 release 不變量，沿用既有 `ADAPTERS` factory over [Null, InMemory]：`:20-23`）、`src/orchestration/pipeline.e2e.test.ts`（既有，擴一條 abort→release 斷言；不新建檔）。
- RED 測試清單（每條對應一行為/不變量）：
  - [ ] InMemory：reserve(est) ok → release(reservationId) → `released`，且**之後可再 reserve 到原額度**（held 已歸還；用「release 後同額度 reserve 成功、release 前會 hard-cap」鎖定）。
  - [ ] InMemory：release `settled` 不變（release 後 commit 其他預留的 overrun 判定不受影響）。
  - [ ] 安全對抗式 fail-closed / deny-by-default：
    - [ ] release 未知 reservationId → `denied`（never throw）。
    - [ ] **double-release**：同一 reservationId release 兩次，第二次 `denied`，且 `held` **不被扣成負**（不可重複歸還）。
    - [ ] release 已 commit 的 reservationId → `denied`（互斥終結邊）。
    - [ ] 壞 ctx → `denied`（fail-closed，contextError 進 event）。
  - [ ] Null：release 一律 `denied`（deny-all）。
  - [ ] credential-blind 結構斷言：release 介面只收 `reservationId:string`，無 secret/credential 欄位名。
  - [ ] orchestration（`runGovernedToolCall`）：注入會 reject 的 `appender`（⇒ commitBeforeEffect `aborted`），reserve ok 後 abort ⇒ `cost.release` 被呼叫、預留歸還（用「abort 後同額度可再 reserve」鎖定，且 `cost.commit` **未**被呼叫）；正常路徑（appender resolve）則 commit、**不** release。
- 首次紅燈證據（貼 exit≠0；實作前填）。**兩條 RED 各自先見其紅**——(a) port/impl 層、(b) orchestration 接線層:
  ```
  # (a) port + impls 缺 release
  $ pnpm test src/test-contracts/cost-gate-adapter.test.ts
  ... FAIL (release is not a function / property 'release' missing on CostGate) ...
  exit code: 1

  # (b) abort 仍洩漏 held（pipeline 未接 release）— 此 RED 在 (a) 的型別/impl 補上後才會跑到
  $ pnpm test src/orchestration/pipeline.e2e.test.ts
  ... FAIL (after abort, re-reserve same budget denied — reservation still held; cost.release not called) ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5；git history 證 doc→red→impl）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  > typecheck (tsc --noEmit) ... ok
  > lint (biome check src) ... Checked 171 files. No fixes applied.
  > build (tsc -p tsconfig.build.json) ... ok
  > test (vitest run) ... Test Files 69 passed | 1 skipped (70); Tests 703 passed | 1 skipped (704)
  >   - src/test-contracts/cost-gate-adapter.test.ts (30 tests) PASS
  >   - src/orchestration/pipeline.e2e.test.ts (9 tests) PASS
  >   - src/inference/gate.test.ts (17 tests) PASS
  >   - src/cost/adapters/spendguard/adapter.test.ts (11 tests) PASS
  > deps:check ... ✔ no dependency violations found (113 modules, 266 dependencies cruised)
  > proto:check / openshell:proto:check / verify:go / verify:py / verify:cross-tenant / launcher:check ... ok
  > secret-scan ... clean
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；no-vendor-in-core enforcing；cost 在 core from-list）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (113 modules, 266 dependencies cruised)
  exit code: 0
  ```
- [x] low coupling / high cohesion 遵守（commitgate **未**被 cost import；接線只在 orchestration；無新跨 module / cyclic 依賴 — deps:check exit 0 證；release 純 cost↔orchestration，無 cycle）
- [x] secret-scan 乾淨（source/log/artifact/fixture/snapshot/trace 無 secret-like 值；release 介面 credential-blind — 只收 `reservationId:string`）
  ```
  $ pnpm run secret-scan
  secret-scan: clean
  exit code: 0
  ```
- [x] Docs 更新（`docs/design/follow-ups.md` §2.1 標記 DONE 並註記 SpendGuard 真實 release_session 仍留 R11；與此 slice 對齊）
- [x] Adversarial code review = PASS（fresh-context；mutation 驗證 double-release / abort-release 測試非 theater）— Slice R12-S1 通過獨立 review（INTEGRATOR 接手前置條件）。
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（adversarially probe：double-release 不歸負、abort 必 release、commit 後不可 release、壞 ctx fail-closed）— 對應斷言見 `src/test-contracts/cost-gate-adapter.test.ts` + `src/orchestration/pipeline.e2e.test.ts`，全綠。

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 port 第三條邊 + 2 impl 的 release + orchestration helper）。
- 可逆性: 安全可逆——純記憶體狀態機邏輯，無外部副作用、無 audit append（本 slice 的 CostEvent 尚未進 WORM kernel）。

## (8) Depends-on / blocks
- Depends-on: **P2-G**（CostGate port + InMemory/Null + contract harness，已 DONE）、**P2-C**（commitgate `commitBeforeEffect` 的 `aborted` 分支，已 DONE）。
- Blocks: **R11**（真實 SpendGuard `Release` adapter over 此 port）、**R6**（inference routing gate 串 reserve/commit/release）。
- 確認 slice DAG 無 cycle: ☐ 是（`P2R-R12-S1 -> {P2-G, P2-C}`，皆 rank 較低之已 DONE slice；與 P2R-R12-S2 無邊）
