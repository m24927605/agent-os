# SLICE-P2R-R9-S2: TS SDK author barrel（`src/sdk/index.ts` 最小 re-export + Fakes，無 deep import）

- **Phase**: P2（R9 第二刀；Developer surface — TS SDK）
- **Branch**: slice/p2r-r9-s2-ts-sdk-author-barrel
- **Author**: agency-agents writer（Backend Architect）    **Adversarial reviewer**: <fresh-context Opus 4.8、非作者>
- **Size budget**: <= 0.5 day；net LOC <~120、files <~3（`src/sdk/index.ts` + `src/sdk/index.test.ts` + `src/index.ts` barrel 加一行 `export * from "./sdk/index.js"`）、modules = 1（新 `sdk`）、新增依賴 = 0
- **前置硬約束（dependency-cruiser `not-to-internal`）**：`.dependency-cruiser.cjs` 的 `not-to-internal` 規則只允許跨 module **經 `src/<module>/index.ts` barrel** 消費（`from: ^src/([^/]+)/`、`to.pathNot: ^src/[^/]+/index\.ts$`）。`src/sdk/index.ts` 受此規則約束（root `src/index.ts` 是唯一豁免聚合點）。故本 slice **只能** import 「有 `index.ts` barrel」的 module：`src/runtime/brain/index.ts`、`src/cost/index.ts`、`src/hosting/index.ts`、`src/runtime/substrate/index.ts`（皆已存在）。**R3 的 `ToolManifest`/`parseToolManifest` 目前只經 root `src/index.ts` 對外、無 `src/tools/index.ts`；`src/policy/` 亦無 `index.ts`**——見 §8「前置」。
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R9-S2 — 新增 **author-facing 的 SDK barrel** `src/sdk/index.ts`，**只**收斂 re-export 第三方作者需要的最小公共面：R3 `ToolManifest`/`parseToolManifest`/`ToolSideEffect`、**四個有 barrel 的 Port 介面型別（Brain/CostGate/AgentHosting/Substrate）**、既有 `Fake*`/in-memory adapters；**不** export core 治理內部、**不** deep-import 任何 module 內部（受 `not-to-internal` 強制）。

## (2) Goal（一句話）
給開發者一個**最小、收斂、與 core 內部解耦**的 SDK 入口，讓他們「寫一次、對著穩定契約作者」而不洩漏治理內部。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/sdk/index.ts`：re-export（**只**經各 module 既有 `index.ts` barrel，**非** deep import；受 `not-to-internal` 強制）:
    - R3：`ToolManifest`、`parseToolManifest`、`ToolSideEffect`——**經 `src/tools/index.ts` barrel**。⚠️ 該 barrel **目前不存在**（R3-S1 只新增 `src/tools/manifest.ts` 並經 **root** `src/index.ts` 對外，未建 module barrel）。本 slice **不得** deep-import `src/tools/manifest.ts`（會違反 `not-to-internal` → `deps:check` 紅），也**不得**從 root `src/index.ts` re-import（會與「root 再 export sdk」形成 `no-circular` 紅）。處置見 §8「前置硬條件」：須 R3 先補 `src/tools/index.ts` barrel。
    - Port 介面型別：**Brain/CostGate/AgentHosting/Substrate**（四個，各經其 `index.ts`，皆已存在）。**Policy 不在此 slice**——`src/policy/` 無 `index.ts` barrel，且 policy 是評估器/型別而非「作者面 Port」，re-export 它既違反 `not-to-internal`、又洩漏治理內部（與 §10 trade-off 收斂作者面相悖）。
    - 作者測試用 Fakes：`FakeBrain`（經 `src/runtime/brain/index.ts`，**非** 直 import `fakes.ts`）、in-memory cost/hosting（經各 `index.ts`）、substrate fake（經 `src/runtime/substrate/index.ts`）——讓作者本機跑 contract。
  - `src/index.ts` 加一行 `export * from "./sdk/index.js"`（讓 SDK 面可被一致消費）。**注意方向**：`src/sdk/index.ts` **絕不** import root `src/index.ts`（單向：root → sdk → 各 module barrel），否則 `no-circular` 紅。
  - `src/sdk/index.test.ts`：斷言 SDK barrel **export 了**作者面符號、且**未** export 指定的 core 內部符號（防洩漏）。
- Out-of-scope（明確不做）:
  - CLI → 留給 **P2R-R9-S3**。
  - authoring 範本/文件 → 留給 **P2R-R9-S4**。
  - npm publish / 版本化發布 → 後續。
  - 新增任何行為邏輯（本 slice 純 re-export + 防洩漏斷言）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: core 目前只有 `src/index.ts`（`src/index.ts:9-26`）混合 export 治理內部；新增 `src/sdk/` 作為**收斂的作者面**，只 re-export 作者需要的最小集合。不改任何被 re-export 的 module（純聚合）。
- **Modules touched（唯一責任）**:
  - `src/sdk/index.ts` — 唯一責任：聚合並收斂「作者面公共契約」；不含邏輯、不含狀態、只 re-export 既有 barrel 符號。
- **PUBLIC interface（新增）**:
  - `src/sdk/index.ts` re-export 集合（作者面）：`ToolManifest` / `parseToolManifest` / `ToolSideEffect`；**四個** Port 介面型別（Brain/CostGate/AgentHosting/Substrate）；`FakeBrain` 等 fakes。
- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle；**單向**，sdk 不回指 root）:
    ```
    src/index.ts ──▶ src/sdk/index.ts ──▶ { src/tools/index.ts(R3 須補), src/runtime/brain/index.ts, src/cost/index.ts, src/hosting/index.ts, src/runtime/substrate/index.ts }
    ```
  - 僅經 public surface 消費（無 deep import）: 是（**只** import 各 module 的 `index.ts`，**不** import `.../internal/*` 或具體實作檔內部）。
  - 新依賴宣告: 無第三方新依賴；新增的 module-to-module 依賴皆為「sdk → 既有 barrel」單向、無 cycle、理由=收斂作者面。
  - no-vendor-in-core: 綠（`sdk` 不含 vendor token；只 re-export vendor-neutral 契約與 fakes，不 re-export 任何真 vendor adapter）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/sdk/index.test.ts`
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] SDK barrel export 了作者面符號（`parseToolManifest` 為 function、Port 型別可匯入、`FakeBrain` 可建構）。
  - [ ] **防洩漏**：SDK barrel **未** re-export 指定的 core 內部符號（如 policy 評估器 / audit kernel 內部）——以「該符號從 sdk 匯入應為 undefined / 型別不存在」型斷言守住收斂面。
  - [ ] **無 deep import / 無 cycle（命令化）**：`pnpm run deps:check` exit 0；對「在 sdk 內 deep-import `src/tools/manifest.ts` 或從 root `src/index.ts` re-import」的刻意違規 fixture，`deps:check` 必須 exit≠0（紅），移除後 exit 0。
  - [ ] 用 SDK 匯出的 `parseToolManifest` 對合法 9 欄範本 → 成功；對未知欄位 → throw（證明 re-export 的是 R3 真 schema，非影本）。
- 首次紅燈證據（貼 exit≠0；實作前填）:
  ```
  $ pnpm test src/sdk/index.test.ts
  ... FAIL（import ../sdk/index.js 失敗：模組不存在）...
  exit code: <填首次紅燈 exit>
  ```

## (6) Definition of Done（每條附指令證據；實作時填真實 exit code）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: <0>
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；確認 `sdk` 只 import 各 module barrel、無 deep import、無 cycle、no-vendor-in-core 綠）
- [ ] low coupling / high cohesion 遵守（`sdk` 單一責任=聚合作者面；無新跨 module 邏輯依賴）
- [ ] secret-scan 乾淨（純 re-export、無 secret-like 值）
- [ ] Docs 更新（design/developer-sdk.md §2.2 S2 與本 slice 一致）
- [ ] Adversarial code review = PASS（fresh-context；reviewer mutation：在 sdk barrel 加一條 core-internal re-export → 防洩漏測試應轉紅；deep-import 一個 internal 檔 → `deps:check` 應紅）— 摘要: <填>
- [ ]（非安全不變量類：純收斂面）以 §7 adversarial review 達成 Tier-2 acceptance，不另跑 Independent Verifier Pass

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `src/sdk/` + barrel 一行）。
- 可逆性: 安全可逆——純聚合 re-export，無外部副作用、無資料遷移、無 audit append。

## (8) Depends-on / blocks
- **前置硬條件（dependency-cruiser）**：本 slice 要經 barrel re-export R3 契約，但 R3-S1 只把 `parseToolManifest` 經 **root** `src/index.ts` 對外，**未建 `src/tools/index.ts` module barrel**。在 `not-to-internal` 下，sdk **無合法路徑** import R3。處置二選一（須在實作前定案，否則 `deps:check` 必紅）：
  - **(A 推薦)** 由 R3 增補一個 `src/tools/index.ts` barrel（`export * from "./manifest.js"`）——應改為 R3 的 slice 範圍（契約先於消費者，slice-spec §9）；本 S2 **depends-on** 該 barrel。
  - **(B)** 若 R3 不補 barrel，則本 slice 須**自行**新增 `src/tools/index.ts`（+1 file，仍在尺寸內），並在 §3/§4 明列為本 slice 觸及之 module（modules 變 2：`sdk` + `tools`-barrel-only，仍 ≤ hard cap 3）。
- Depends-on: **R3**（`ToolManifest`/`parseToolManifest`/`ToolSideEffect` 已 merge）**+ `src/tools/index.ts` barrel（見上「前置硬條件」）**、P2 ports（`src/runtime/brain/index.ts`、`src/cost/index.ts`、`src/hosting/index.ts`、`src/runtime/substrate/index.ts`，皆已 merge 且有 barrel）。
- Blocks: P2R-R9-S3（CLI 消費 SDK barrel）、P2R-R9-S4（authoring 經 CLI）。
- 確認 slice DAG 無 cycle: 是（S2 rank=2；依賴已 merge 的 R3 + `tools` barrel + P2 port barrels；sdk 單向不回指 root）。
