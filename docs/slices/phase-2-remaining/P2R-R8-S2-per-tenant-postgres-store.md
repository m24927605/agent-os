# SLICE-P2R-R8-S2: per-tenant persistence port + in-memory 第二實作（跨租取不到 repo）

- **Phase**: P2（R8 Enterprise 多租脊椎；對齊 three-surface P3 per-tenant Postgres）
- **Branch**: slice/p2r-r8-s2-per-tenant-postgres-store
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: 估計 <= 1 day；net LOC <~220、files <~4（`src/tenant/persistence/port.ts` + `in-memory.ts` + `port.contract.test.ts` + barrel 追加）、新增依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R8-S2 — vendor-neutral `TenantStore` persistence port：`forTenant(binding) → TenantScopedRepo`，**一租一獨立 repo handle**，附 in-memory 第二實作 + contract test，證明「拿 A 租 repo 永遠看不到 B 租資料」。

## (2) Goal（一句話）
把「per-tenant Postgres」的隔離不變量變指令可驗：經 `binding` 取得的 repo **只能**讀寫該租資料，跨租讀/寫**結構性取不到**（fail-closed），用 contract test 對 ≥2 實作鎖死（滿足可插拔硬性約束）。

## (3) In-scope / Out-of-scope
- In-scope：
  - `TenantStore` port：`forTenant(binding: TenantBinding): TenantScopedRepo`（未註冊/未知 binding → throw fail-closed，**不**建空 repo）。
  - `TenantScopedRepo` 最小 CRUD-ish 介面（`put(key,value)` / `get(key)` / `list()`），全部**隱含**綁該租，呼叫面**無 tenantId 參數**（無法跨租）。
  - in-memory 第二實作（per-tenant `Map`，沿用 `src/hosting/in-memory.ts:25-27` 形狀）。
  - vendor-neutral **contract test**：對任一 `TenantStore` 實作斷言跨租隔離不變量。
- Out-of-scope：
  - 真實 Postgres adapter（connection pool / 分片 / DSN）→ 後續 vendor adapter slice（design §5）。
  - schema/migration（expand-contract）→ 真 PG adapter 帶。
  - reason/error 不得 echo binding 內任何值。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 `src/tenant/persistence`。port 以 `binding`（R8-S1 的 `TenantBinding`）為唯一 scope 鑰匙；
  `forTenant` 對未註冊 binding fail-closed throw。`TenantScopedRepo` 的方法簽名**不含 tenantId**——租戶被 closure-bind 進
  repo 實例，呼叫者沒有任何參數可指定別租 ⇒ 跨租 by construction 不可能（這是「非 row filter」的具體落地）。
- **Modules touched（唯一責任）**：
  - `src/tenant/persistence/port.ts` — 唯一責任：定義 vendor-neutral per-tenant persistence 契約（無 vendor、無 secret）。
  - `src/tenant/persistence/in-memory.ts` — 唯一責任：port 的確定性 in-memory 第二實作，每租獨立 Map。
- **PUBLIC interface（新增）**：
  - `export interface TenantScopedRepo { put(key: string, value: unknown): Promise<void>; get(key: string): Promise<unknown | undefined>; list(): Promise<readonly string[]>; }`
  - `export interface TenantStore { forTenant(binding: TenantBinding): TenantScopedRepo; }`
  - `export class InMemoryTenantStore implements TenantStore { constructor(registered: ReadonlySet<string> /* partitionIds */); forTenant(b): TenantScopedRepo; }`
- **Dependency direction（inward、acyclic）**：
  ```
  src/tenant/persistence/in-memory.ts ──▶ port.ts ──▶ (TenantBinding from src/tenant/index)
  ```
  - 僅經 public surface 消費：本 slice 檔案位於 **同一 top-level module `src/tenant`** 之下（`src/tenant/persistence/*`），故對 `TenantBinding` 的引用是 **intra-module**（dependency-cruiser `not-to-internal` 以 `^src/$1/` 視為合法）；對 `src/tenant` 外部不新增任何 deep import: ☐ 是
  - `src/tenant/persistence/*` 之公共型別經 **`src/tenant/index.ts` re-export** 對外（不另立第二個跨模組 barrel）。
  - 新依賴宣告：`TenantBinding`（同 module R8-S1 型別，intra-module）；方向=inward、cycle=無、理由=binding 是 repo 的 scope 鑰匙。無 vendor import。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`src/tenant/persistence/port.contract.test.ts`（contract harness，跑於 in-memory 實作）
- RED 測試清單：
  - [ ] headline 隔離：A 租 repo `put("k","va")`、B 租 repo `put("k","vb")` → A 租 `get("k")==="va"`、B 租 `get("k")==="vb"`、互不可見；A 租 `list()` 不含 B 租 key。
  - [ ] 結構性無跨租參數：`TenantScopedRepo` 方法簽名**無** tenantId 參數（型別層證 by-construction 隔離）。
  - [ ] fail-closed：對未註冊 binding 呼叫 `forTenant` → throw（不回空 repo、不回別租 repo）。
  - [ ] 可插拔：同一 contract test 對「第二個（fake/變體）實作」亦綠（≥2 impl + contract test）。
- 首次紅燈證據（待實作填）:
  ```
  $ pnpm test src/tenant/persistence/port.contract.test.ts
  ... FAIL ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... secret-scan: clean
  VERIFY_EXIT=0
  ```
- [x] `pnpm run deps:check` exit 0（`src/tenant/persistence` 為 `src/tenant` 同模組內部目錄，intra-module 引用合法；對外型別經 `src/tenant/index.ts` re-export；no-vendor-in-core 綠）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (92 modules, 217 dependencies cruised)
  DEPS_EXIT=0
  ```
- [x] 可插拔硬性約束：port vendor-neutral + **≥2 impl**（`InMemoryTenantStore` + `DelegatingTenantStore`）+ contract test 全綠
  ```
  $ node_modules/.bin/vitest run src/tenant/persistence/port.contract.test.ts
  ✓ src/tenant/persistence/port.contract.test.ts (12 tests) 3ms
  Test Files  1 passed (1) | Tests  12 passed (12)
  TEST_EXIT=0
  ```
- [x] low coupling / high cohesion：無 cyclic / 跨 module deep import；僅 public surface 消費（deps:check exit 0 證）
- [x] secret-scan 乾淨（port/impl/test 無 secret-like 值；verify 內 `secret-scan: clean`）
- [x] Docs 更新（本 slice §6 + `src/tenant/index.ts` barrel re-export R8-S2）
- [x] Adversarial code review = PASS（fresh-context；嘗試以 B 租 repo 讀 A 租 key 皆失敗）
- [x] **Independent Verifier Pass**（跨租隔離 by construction + fail-closed；mutation：移除租戶 closure-bind 必被抓）

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `src/tenant/persistence`；in-memory 無外部副作用）。
- 可逆性：安全可逆（無真實 DB、無遷移、無 audit append）。

## (8) Depends-on / blocks
- Depends-on：R8-S1（提供 `TenantBinding` 作為 scope 鑰匙）。
- Blocks：R8-S4（console 投影讀 per-tenant repo）、R8-S6（conformance 重證 repo 隔離）。
- 確認 slice DAG 無 cycle: ☐ 是（R8-S2 rank=2）
