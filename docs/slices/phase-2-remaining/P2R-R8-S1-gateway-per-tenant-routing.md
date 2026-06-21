# SLICE-P2R-R8-S1: TenantRouter — 跨租取不到 binding（連線/namespace 邊界，非 row filter）

- **Phase**: P2（R8 Enterprise 多租脊椎；對齊 three-surface P3 gateway-per-tenant）
- **Branch**: slice/p2r-r8-s1-gateway-per-tenant-routing
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: 估計 <= 1 day；net LOC <~180、files <~3（`src/tenant/router.ts` + `src/tenant/index.ts` + `src/tenant/router.test.ts`）、新增依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R8-S1 — `TenantRouter`：以 untrusted `AgentContext` 解出**該租專屬 `TenantBinding`**，跨租**結構性取不到別租 binding**，fail-closed，作為 gateway-per-tenant 的連線/namespace 邊界（非 row filter）。

## (2) Goal（一句話）
把「租戶邊界」變成 PDP 風格的可驗不變量：合法 `ctx` 只能解出**自己**那租的 binding，malformed / 未註冊 tenant → deny（不 fall through 到任何預設租）。

## (3) In-scope / Out-of-scope
- In-scope：
  - `TenantBinding`（不含 secret：`tenantId` + 不透明 `partitionId` + 不透明 `storeRef`）。
  - `TenantRouter.resolve(ctx: unknown): RouteResult`（`{ok:true, binding}` | `{ok:false, reason}`）。
  - deny-by-default：`parseAgentContext` 失敗、或 tenant 不在註冊表 → deny。
  - **結構性隔離**：router 不提供「列舉所有 binding」或「以任意字串取任意 binding」的 API；只能經 `ctx.tenantId` 取自己的。
- Out-of-scope（明確不做）：
  - per-tenant persistence repo 實體（`storeRef` 只是不透明 handle）→ **R8-S2**。
  - per-tenant kernel partition 行為（`partitionId` 只是不透明 id）→ **R8-S3**。
  - 真實「每租一進程/netns」部署物化 → 後續 deploy slice（見 design §2.2 取捨）。
  - reason 不得 echo `ctx` 任何值（只用靜態文字 / 欄位名）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 `src/tenant` module。`TenantRouter` 持有一個**註冊表**（`Map<tenantId, TenantBinding>`，建構時注入），
  `resolve` 先 `parseAgentContext(ctx)`（`src/iam/ids.ts:50-52`，fail-closed），成功後查表；查不到 → deny。
  router **不暴露 registry 本體**，呼叫者無法以任意字串取任意 binding（隔離自證）。
- **Modules touched（每個一句唯一責任）**：
  - `src/tenant/router.ts` — 唯一責任：把 untrusted ctx 解析+映射成該租 binding，跨租 fail-closed。
  - `src/tenant/index.ts` — 唯一責任：tenant module 的 public barrel（只匯出 `TenantRouter`/`TenantBinding`/`RouteResult`）。
- **PUBLIC interface（新增）**：
  - `export interface TenantBinding { readonly tenantId: string; readonly partitionId: string; readonly storeRef: string; }`
  - `export type RouteResult = { ok: true; binding: TenantBinding } | { ok: false; reason: string };`
  - `export class TenantRouter { constructor(bindings: ReadonlyMap<string, TenantBinding>); resolve(ctx: unknown): RouteResult; }`
- **Dependency direction（inward、acyclic）**：
  ```
  src/tenant/router.ts ──▶ src/iam/ids.ts (parseAgentContext)   # adapters/app → domain，無反向
  ```
  - 僅經 public surface 消費（`src/iam/ids.js`；無 deep import）: ☐ 是
    - **註**：`src/iam/ids` 目前是 `.dependency-cruiser.cjs` 的 **interim 允許項**（pre-barrel 入口，barrel-migration slice 後改為 `src/iam/index.ts`）；本 slice 沿用此既有允許項，不新增任何 deep-import 例外。
    - **`src/tenant` 即新 top-level module**（`$1=tenant`）：其 `index.ts` 為唯一公共 barrel；R8-S2/S4/S5 的 `src/tenant/<sub>/*` 皆為**同模組內部目錄**（dependency-cruiser `not-to-internal` 以 `^src/$1/` 視為 intra-module，合法），**不**是各自獨立的跨模組 public surface。
  - **top-level barrel 接線**：把 `export * from "./tenant/index.js"` 加入 repo 公共 barrel `src/index.ts`（沿既有 module 慣例）。
  - 新依賴宣告：`iam/ids`（既有 domain primitive）；方向=inward、cycle=無、理由=唯一合法的租戶身分來源。無 vendor import。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`src/tenant/router.test.ts`
- RED 測試清單：
  - [ ] headline：以 tenant-a 的合法 `ctx` resolve → `{ok:true}` 且 `binding.tenantId==="tenant-a"`；用 tenant-b 的 `ctx` → 解出 tenant-b 的 binding，**永不**回 tenant-a 的 binding。
  - [ ] deny-by-default：未註冊 tenant 的合法 `ctx` → `{ok:false}`，reason 含 `unknown tenant`（不 echo tenantId 值）。
  - [ ] fail-closed：malformed `ctx`（缺欄位 / 空 tenantId）→ `{ok:false}`，reason 含 `invalid agent context`。
  - [ ] 結構性隔離：`TenantRouter` 無公開方法可列舉或以任意字串取任意 binding（型別層 + 無 export registry）。
  - [ ] reason 不洩漏：planted secret-looking tenantId 不出現於任何 reason 字串。
- 首次紅燈證據（RED — 實作前 `src/tenant/router.ts` 不存在，import 解析失敗）:
  ```
  $ npx vitest run src/tenant/router.test.ts
  FAIL src/tenant/router.test.ts [ failed to resolve import "./router.js" ]
  exit code: 1
  ```
- GREEN 證據（實作後同一指令）:
  ```
  $ npx vitest run src/tenant/router.test.ts
  Test Files  1 passed (1)   Tests  8 passed (8)
  exit code: 0
  ```

## (6) Definition of Done（每條附指令證據；真實 exit code）
- [x] Test-first 成立（首次 RED 已貼於 §5；GREEN 後 `npx vitest run src/tenant/router.test.ts` → 8 passed, exit 0）
- [x] `pnpm run verify` exit 0（typecheck+lint+build+test+deps:check+proto+go+launcher+secret-scan 全綠；523 tests, 1 skipped）→ **exit 0**
- [x] `pnpm run deps:check` exit 0（90 modules / 212 deps cruised；no dependency violations；只新增 `src/tenant`，僅依賴 `iam/ids` barrel）→ **exit 0**
- [x] low coupling / high cohesion：depcruise 0 violations（無 cyclic / 跨 module deep import；僅經 `../iam/ids.js` public surface 消費）
- [x] secret-scan 乾淨（`pnpm run secret-scan` → `secret-scan: clean`）→ **exit 0**
- [x] Docs 更新（本 slice §5/§6 補真實 exit code；狀態 DONE）
- [x] Adversarial code review = PASS（fresh-context；偽造/變造 ctx、未註冊 tenant、空 tenantId、非物件 ctx、建構後 registry 變造皆 deny — 見 router.test.ts）
- [x] **Independent Verifier Pass**（安全不變量類：跨租隔離 + deny-by-default + fail-closed + reason 不洩漏 — 本 slice 已通過獨立審查）

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `src/tenant` module；無外部副作用、無資料遷移）。
- 可逆性：安全可逆（純函式邊界、in-memory registry、無 audit append）。

## (8) Depends-on / blocks
- Depends-on：P2-F（tenant-scoped PDP，已 merge；提供跨租 deny-by-default 語意基礎）。
- Blocks：R8-S2（per-tenant repo）、R8-S4（console）、R8-S5（maker-checker）、R8-S6（conformance）。
- 確認 slice DAG 無 cycle: ☐ 是（R8-S1 rank=1）
