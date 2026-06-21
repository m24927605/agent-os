# SLICE-P2R-R8-S4: operator console 唯讀 fleet/timeline 投影資料契約 + 租戶綁定

- **Phase**: P2（R8 Enterprise 多租脊椎；對齊 three-surface P3 operator console）
- **Branch**: slice/p2r-r8-s4-operator-console-contract
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: 估計 <= 1 day；net LOC <~200、files <~3（`src/tenant/console/projection.ts` + `projection.test.ts` + barrel 追加）、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R8-S4 — operator console 的**唯讀投影資料契約**：給定 `TenantBinding`，產出該租 fleet（agent 清單）+ timeline（從該租 repo 重建）投影；**結構上只看得到該租**，不含任何特權寫入。

## (2) Goal（一句話）
把「一個畫面開公司」的最小可驗片落地：console 投影只經 `binding` 取該租資料，跨租 fleet/timeline **結構性不可見**，且投影是**純唯讀**（無任何改動公司的副作用）。

## (3) In-scope / Out-of-scope
- In-scope：
  - `ConsoleProjection.forTenant(binding): { fleet(): Promise<FleetView>; timeline(): Promise<TimelineView> }`。
  - `FleetView` = 該租 agent 清單投影（從 R8-S2 repo 讀，沿用 hosting 形狀）；`TimelineView` = 該租事件投影（從該租 repo 重建，唯讀）。
  - **唯讀**：投影介面**無**任何 mutate 方法；租戶被 `binding` closure-bind（無 tenantId 參數可跨租）。
- Out-of-scope（明確不做）：
  - 任何**特權動作**（暫停 agent、調預算、改 policy）→ 走 PDP + commit-before-effect，**R8-S5** / 後續動作 slice。
  - per-agent 成本/預算數字接 `src/cost`（P2-G）、policy 決策接 PDP 的**實際接線** → 後續 console-wiring slice（本 slice 只定投影契約 + 租戶綁定 + 唯讀性）。
  - React/前端像素 → 體驗層 slice（R7 風格）。
  - timeline 直接讀 kernel partition 鏈（R8-S3）→ 後續；本 slice 從 R8-S2 repo 投影（解耦，避免本 slice 跨 plane）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 `src/tenant/console`。`ConsoleProjection` 以 `binding`（R8-S1）取得該租 `TenantScopedRepo`
  （R8-S2 `TenantStore.forTenant`），把 repo 內容投影成 `FleetView`/`TimelineView`。投影介面**不暴露任何寫方法**，
  且**無 tenantId 參數**——console 看到別租 fleet 結構上不可能（design §2.5）。
- **Modules touched（唯一責任）**：
  - `src/tenant/console/projection.ts` — 唯一責任：把單租 repo 投影成唯讀 fleet/timeline view，租戶 closure-bind。
- **PUBLIC interface（新增）**：
  - `export interface FleetView { readonly tenantId: string; readonly agents: readonly { sandboxId: string; agentName: string; phase: string }[]; }`
  - `export interface TimelineView { readonly tenantId: string; readonly events: readonly { seq: number; summary: string }[]; }`
  - `export interface TenantConsole { fleet(): Promise<FleetView>; timeline(): Promise<TimelineView>; }`
  - `export class ConsoleProjection { constructor(store: TenantStore); forTenant(binding: TenantBinding): TenantConsole; }`
- **Dependency direction（inward、acyclic）**：
  ```
  src/tenant/console/projection.ts ──▶ src/tenant (TenantBinding) ──▶ src/tenant/persistence (TenantStore/Repo)
  ```
  - 僅經 public surface 消費：`src/tenant/console/*` 與 `binding`/`TenantStore` 同屬 **top-level module `src/tenant`**，引用為 **intra-module**（dependency-cruiser `^src/$1/` 合法）；對 `src/tenant` 外部無 deep import: ☐ 是
  - 新依賴宣告：`TenantBinding`（R8-S1）、`TenantStore`（R8-S2）皆為同模組型別（intra-module）；方向=inward、cycle=無、理由=投影必須經 binding+repo。無 vendor import。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`src/tenant/console/projection.test.ts`
- RED 測試清單：
  - [ ] headline 隔離：A、B 兩租各 put 不同 agent；A 租 console `fleet()` 只含 A 的 agent，B 的不可見；`timeline()` 同理。
  - [ ] 唯讀性：`TenantConsole` 型別**無**任何 mutate 方法（型別層證唯讀）；投影呼叫不改 repo 內容。
  - [ ] 租戶 closure-bind：`fleet()/timeline()` 簽名**無** tenantId 參數（無法跨租）。
  - [ ] fail-closed：以未註冊 binding `forTenant` → 透傳 R8-S2 的 fail-closed throw（不回空/別租 view）。
  - [ ] 投影不洩漏：planted secret-looking value 不出現在 view 的 summary（投影只取允許欄位）。
- 首次紅燈證據（待實作填）:
  ```
  $ pnpm test src/tenant/console/projection.test.ts
  ... FAIL ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據；待實作覆蓋）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
- [ ] `pnpm run deps:check` exit 0（`src/tenant/console` 為 `src/tenant` 同模組內部目錄，intra-module 引用合法；no-vendor-in-core 綠）
- [ ] low coupling / high cohesion：純唯讀投影、無跨 module deep import、無 cyclic
- [ ] secret-scan 乾淨（projection/test 無 secret-like 值；view 不含 secret 欄位）
- [ ] Docs 更新（design §2.5；本 slice）
- [ ] Adversarial code review = PASS（fresh-context；嘗試用 A binding 看 B 租 fleet、嘗試經投影 mutate 皆失敗）
- [ ] **Independent Verifier Pass**（跨租隔離 + 唯讀性 + fail-closed；mutation：投影忽略 binding/混租必被抓）

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `src/tenant/console`；純唯讀、無副作用）。
- 可逆性：安全可逆（無寫入、無 audit append、無遷移）。

## (8) Depends-on / blocks
- Depends-on：R8-S1（binding）、R8-S2（per-tenant repo）。
- Blocks：後續 console-wiring（接 cost/policy）、特權動作 slice（經 R8-S5 maker-checker）。
- 確認 slice DAG 無 cycle: ☐ 是（R8-S4 rank=3）
