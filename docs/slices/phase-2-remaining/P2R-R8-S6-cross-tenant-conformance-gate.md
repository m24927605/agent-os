# SLICE-P2R-R8-S6: release-blocking 跨租 conformance（任一邊界漏租 → verify exit≠0）

- **Phase**: P2（R8 Enterprise 多租脊椎；對齊 three-surface P3 **release-blocking** 跨租 conformance）
- **Branch**: slice/p2r-r8-s6-cross-tenant-conformance-gate
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: 估計 <= 1 day；net LOC <~220、files <~4（`src/tenant/conformance/cross-tenant.conformance.test.ts` + `kernel/internal/partition/partition_conformance_test.go` + `package.json` 加 `verify:cross-tenant` 子關卡 + 接進 `verify`）、新增依賴 = 0。**module 數：跨 TS + Go 兩 plane（gate slice 本質需重證兩 plane）= 2 code module + 1 config，於 slice-spec §3 hard cap（3）內；純測試 + 1 行 script，無新 runtime 公共面，認知負荷小，不拆分。**
- **狀態**: **DONE**（branch `slice/p2r-r8-s6-cross-tenant-conformance-gate`；gate 已接進 `verify`；RED 對 4 種漏租 mutation 皆 exit≠0、移除後 exit 0，證據見 §5；DoD 全綠見 §6，已 merge 進 main）

## (1) ID + Title
SLICE-P2R-R8-S6 — 一條 **release-blocking 跨租 conformance**：以 fixture/property 斷言 R8 三邊界（routing / per-tenant repo / per-tenant kernel partition）+ maker-checker **任一漏租即 exit≠0**，並**掛進 `pnpm run verify`**，使「跨租結構不可能」成為每次提交都重證的 structural gate。

## (2) Goal（一句話）
把「跨租隔離」從設計宣稱升級為**release-blocking 指令真相**：任一邊界出現跨租洩漏（取得別租 binding/repo、別租 key 驗過、maker-checker 跨租放行）→ conformance 紅 → `verify` 紅 → pre-commit guard 擋 → 不得 merge。

## (3) In-scope / Out-of-scope
- In-scope：
  - TS 跨租 conformance：對 R8-S1 router、R8-S2 repo、R8-S5 maker-checker 各斷言一條跨租洩漏即 fail 的不變量。
  - Go partition conformance：對 R8-S3 斷言「A 租 Append 不改 B 租頭」「別租 key 驗 A 租 checkpoint 必拒」（沿用 `conformance/go_verifies_ts_test.go:148-150` 形狀）。
  - 新增 `verify:cross-tenant` script 並接進 `pnpm run verify` 鏈（release-blocking gate）。
  - **RED 證據（gate slice 特例）**：對一個刻意植入的「漏租」mutation（例如 router 回別租 binding），conformance **必 exit≠0**；移除 mutation 後 exit 0。
- Out-of-scope（明確不做）：
  - 新的隔離機制（本 slice 只**重證**既有 S1–S5，不新增能力）。
  - 真實 Postgres / multi-process 部署的 conformance → 後續 deploy/vendor slice。
  - 效能基準（CI 慢是刻意取捨，design §3 取捨 5）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 `src/tenant/conformance` + `kernel/internal/partition` 的 conformance 測試，並在 `package.json`
  加 `"verify:cross-tenant"`（跑 TS conformance + Go partition conformance），插入既有 `verify` 鏈
  （沿 `phase-2/INDEX.md §2` 的 verify 子關卡形態：`... && pnpm run verify:cross-tenant && ...`）。conformance 為
  fixture/property 驅動：列舉「跨租嘗試」矩陣，每格期望 deny/false/exit≠0。
- **Modules touched（唯一責任）**：
  - `src/tenant/conformance/cross-tenant.conformance.test.ts` — 唯一責任：斷言 TS 三點（router/repo/maker-checker）跨租隔離不變量。
  - `kernel/internal/partition/partition_conformance_test.go` — 唯一責任：斷言 kernel partition 跨租密碼學隔離。
  - `package.json`（薄改）— 唯一責任：把 cross-tenant conformance 變成 `verify` 的 release-blocking 子關卡。
- **PUBLIC interface（新增）**：無新 runtime 公共面（僅測試 + 1 個 npm script）。本 slice 不引入新型別。
- **Dependency direction（inward、acyclic）**：
  ```
  cross-tenant.conformance.test.ts ──▶ src/tenant (S1) / persistence (S2) / maker-checker (S5)  # 只經 public surface
  partition_conformance_test.go    ──▶ internal/partition (S3)                                  # 既有 internal 方向
  ```
  - 僅經 public surface 消費（無 deep import；script 不改 runtime 程式）: ☐ 是
  - 新依賴宣告：無新 runtime 依賴；測試經各 module barrel 消費既有公共面。無 vendor import。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`src/tenant/conformance/cross-tenant.conformance.test.ts`、`kernel/internal/partition/partition_conformance_test.go`
- RED 測試清單（gate slice：以植入 mutation 取得首次紅燈）：
  - [x] routing 漏租：植入「router 回 `[...bindings.values()][0]`（回別租 binding）」mutation → TS conformance **2 fail**（exit≠0）；移除後 exit 0。
  - [x] repo 漏租：植入「`forTenant` 回 `[...partitions.values()][0]`（忽略 closure-bind、共用一 Map）」mutation → TS conformance **3 fail**；移除後 exit 0。
  - [x] partition 漏租：植入「所有 partition 共用第一租 signer（shared key）」mutation → Go `TestConformanceCrossTenantWrongKeyRejected` **fail**（別租 key 竟驗過）；移除後 exit 0。
  - [x] maker-checker 漏租：植入「`if (false)` 跳過 cross-tenant deny」mutation → TS conformance **2 fail**；移除後 exit 0。
  - [x] gate 接線：`pnpm run verify:cross-tenant` 在任一上述 mutation 存在時 **exit≠0**；插入 `verify` 鏈（`... && pnpm run verify:py && pnpm run verify:cross-tenant && pnpm run launcher:check && ...`）→ release-blocking。
- 首次紅燈證據（已實測）:
  ```
  # routing 漏租 mutation 存在時
  $ node_modules/.bin/vitest run src/tenant/conformance
   ❯ ... (11 tests | 2 failed)
   FAIL ... boundary 1 — routing (R8-S1) ...
   Test Files  1 failed (1)   Tests  2 failed | 9 passed (11)        # exit code: 1

  # partition shared-key 漏租 mutation 存在時
  $ go test ./internal/partition -run Conformance
   --- FAIL: TestConformanceCrossTenantWrongKeyRejected (0.01s)
   FAIL github.com/agent-os/kernel/internal/partition                # exit code: 1

  # 全部 mutation 移除後（最終工作樹）
  $ pnpm run verify:cross-tenant
   verify:cross-tenant: TS plane — cross-tenant.conformance  →  11 passed (11)
   verify:cross-tenant: Go plane — internal/partition -run Conformance  →  ok
   verify:cross-tenant: ok                                           # exit code: 0
  ```

## (6) Definition of Done（每條附指令證據；整合者實測）
- [x] Test-first 成立（gate RED：植入漏租 → exit≠0；移除 → exit 0，皆已貼於 §5）
- [x] `pnpm run verify` exit 0（且**包含** `verify:cross-tenant` 子關卡）— 實測 `VERIFY_EXIT=0`（gate 鏈含 `... && pnpm run verify:py && pnpm run verify:cross-tenant && pnpm run launcher:check && pnpm run secret-scan`）
- [x] `pnpm run verify:cross-tenant` exit 0（無 mutation 時）— 實測 `CROSS_TENANT_EXIT=0`（TS `11 passed (11)` + Go `internal/partition -run Conformance ok`）；植入任一漏租 mutation 時 exit≠0（release-blocking，§5 已貼 4 種 mutation 紅燈）
- [x] `pnpm run deps:check` exit 0（實測 `DEPS_CHECK_EXIT=0`）；`cd kernel && golangci-lint run` 綠（實測 `GOLANGCI_EXIT=0`）
- [x] low coupling / high cohesion：conformance 只經 public surface 重證 S1–S5，無新能力、無 cyclic（`deps:check` 綠佐證）
- [x] secret-scan 乾淨（`pnpm run verify` 內 `secret-scan: clean`；conformance fixture 無 secret-like 值；per-tenant key 為 runtime 組裝）
- [x] Docs 更新（design §2.7 已標「已接線（R8-S6 落地）」；本 slice §6 補實測證據並標 DONE）
- [x] Adversarial code review = PASS（fresh-context、非作者獨立 Opus 4.8；本 slice 通過獨立審查後交付整合）
- [x] **Independent Verifier Pass**（gate 對 §5 所列 ≥4 種跨租漏租 mutation 皆 exit≠0；移除後 exit 0）

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 conformance 測試 + 從 `verify` 鏈拔掉 `verify:cross-tenant`）。
- 可逆性：安全可逆（純測試 + script；回退僅降低保護強度，無資料/外部副作用）。**注意**：拔掉此 gate 會解除跨租 release-blocking 保護，回退須經 review 確認非為了「繞紅燈」。

## (8) Depends-on / blocks
- Depends-on：R8-S1、R8-S2、R8-S3、R8-S5（重證其全部隔離不變量）。
- Blocks：（R8 收尾 gate）後續 Enterprise 面任何新邊界 slice 必須維持此 conformance 綠。
- 確認 slice DAG 無 cycle: ☐ 是（R8-S6 rank=4，依賴 rank≤3）
