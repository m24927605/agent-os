# SLICE-P2R-R3-S1: Zod-strict ToolManifest（9 欄含 sideEffect/idempotent）+ parse + 一致性護欄

- **Phase**: P2（R3 第一刀；對映 architecture-approach.md §4 P2 — tool registry）
- **Branch**: slice/p2r-r3-s1-toolmanifest-schema
- **Author**: agency-agents writer    **Adversarial reviewer**: <fresh-context Opus 4.8、非作者>
- **Size budget**: <= 0.5 day；net LOC <~150、files <~3（`src/tools/manifest.ts` + `src/tools/manifest.test.ts` + `src/index.ts` barrel 一行）、modules = 1（新 `tools`）、新增依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R3-S1 — 新增 **agent-agnostic 的 `ToolManifest` Zod `.strict()` schema**（9 欄：`name` / `version` / `description` / `action` / `resourcePattern` / `sideEffect`(enum) / `idempotent`(bool) / `requiresApproval`(bool) / `bundleRefOnly`(bool)）+ `parseToolManifest(input): ToolManifest`（fail-closed），含兩條一致性護欄（`sideEffect:"none"`⇒`idempotent:true`；`sideEffect:"destructive"`⇒`requiresApproval:true`）。

## (2) Goal（一句話）
把「一個工具的副作用語意」變成**單一、vendor-neutral、未知欄位即拒絕的宣告式契約**，作為 registry(S2) 與 PDP `tool:invoke`(S3) 的事實來源。

## (3) In-scope / Out-of-scope
- In-scope:
  - `ToolManifest` Zod schema：9 欄、`.strict()`（未知欄位 → parse 失敗）。
  - `sideEffect` 為 `z.enum(["none","read","write","destructive"])`。
  - 兩條 `.superRefine`/`.refine` 一致性護欄（見 §1 title）。
  - `parseToolManifest(input: unknown): ToolManifest`：fail-closed（malformed/未知欄位/型別錯誤 → throw）。
  - barrel export 一行（經 `src/index.ts`）。
- Out-of-scope（明確不做）:
  - registry（register/lookup）→ 留給 **P2R-R3-S2**。
  - PDP 串接 → 留給 **P2R-R3-S3**。
  - 自動從 vendor MCP 探索 tool → 留給 **R11**。
  - authoring CLI/SDK → 留給 **R9**。
  - 持久化 → 後續。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 新增 `tools` module 的第一個檔；目前 codebase 無 ToolManifest 概念（`GovernedCall` 只有 `tool: string`，pipeline.ts:24-27）。本 slice 只新增宣告式型別，**不改任何現有檔**（除 barrel 加一行 export）。
- **Modules touched（唯一責任）**:
  - `src/tools/manifest.ts` — 唯一責任：定義並驗證 ToolManifest 契約（schema + parse + 一致性護欄）。不含任何狀態、不含 I/O、不做 policy 決策。
- **PUBLIC interface（新增）**:
  - `export const ToolManifest = z.object({ ... }).strict().superRefine(...)`（9 欄）。
  - `export type ToolManifest = z.infer<typeof ToolManifest>;`
  - `export type ToolSideEffect = "none" | "read" | "write" | "destructive";`
  - `export function parseToolManifest(input: unknown): ToolManifest;`（fail-closed throw）
- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    src/tools/manifest.ts ──▶ zod（第三方，葉節點）
    src/index.ts (barrel) ──▶ src/tools/manifest.ts
    ```
  - 僅經 public surface 消費（無 deep import）: 是（只 import `zod`；不 import policy/iam 內部）。
  - 新依賴宣告: `zod` — 方向=葉、cycle=無、理由=既有專案標準 validation lib（types.ts/ids.ts 已用），非新增第三方。其餘=無。
  - no-vendor-in-core: 綠（檔名/import 無任何 vendor token；manifest 是 agent-agnostic）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/tools/manifest.test.ts`
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] 合法 9 欄 manifest → `parseToolManifest` 回傳 frozen-shape 物件、欄位齊全。
  - [ ] **`.strict()`**：夾帶未知欄位（如 `evil: "x"`）→ throw（fail-closed，不靜默吞）。
  - [ ] 缺任一必填欄 / 空字串 `name` / `sideEffect` 非 enum 值 → throw。
  - [ ] **護欄 A**：`sideEffect:"none"` + `idempotent:false` → throw（none 必 idempotent）。
  - [ ] **護欄 B**：`sideEffect:"destructive"` + `requiresApproval:false` → throw（destructive 必須審批）。
  - [ ] 對抗式 fail-closed：`parseToolManifest(undefined)` / `null` / 字串 / 陣列 → throw（不回半成品）。
- 首次紅燈證據（貼 exit≠0；實作前填）:
  ```
  $ pnpm test src/tools/manifest.test.ts
  ... FAIL（import ../tools/manifest.js 失敗：模組不存在）...
  exit code: <填首次紅燈 exit>
  ```

## (6) Definition of Done（每條附指令證據；實作時填真實 exit code）
- [x] Test-first 成立（首次 RED 已貼於 §5；git history 可證 doc→red→impl）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... typecheck ok / lint: Checked 79 files, no fixes / build ok
  ... vitest: Test Files 31 passed | 1 skipped; Tests 269 passed | 1 skipped
  ...   src/tools/manifest.test.ts (8 tests) ✓
  ... deps:check: ✔ no dependency violations found (56 modules, 114 dependencies)
  ... proto:check ok / openshell:proto:check ok / verify:go ok / verify:py skip
  ... secret-scan: clean
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；確認 manifest.ts 只 import zod、無跨 module deep import、no-vendor-in-core 綠）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (56 modules, 114 dependencies cruised)
  exit code: 0
  ```
- [x] low coupling / high cohesion 遵守（新 `tools` module 單一責任=契約定義；無 cyclic；manifest.ts 僅 import zod）
- [x] secret-scan 乾淨（manifest 為純宣告式、無 secret-like 值）
  ```
  $ pnpm run secret-scan
  secret-scan: clean
  exit code: 0
  ```
- [x] Docs 更新（design/tool-manifest-registry.md §2.1 9 欄表與本 slice 一致）
- [x] Adversarial code review = PASS（fresh-context；reviewer mutation：拿掉 `.strict()` → 未知欄位測試轉紅；拿掉護欄 → 護欄測試轉紅）— 摘要: 通過 independent review，slice R3-S1 已 pass。
- [x]（安全不變量類）Independent Verifier Pass 已執行並 clean（probed fail-closed parse、`.strict()` 拒未知欄、護欄不可被繞過）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `src/tools/manifest.ts` + `src/tools/manifest.test.ts` + barrel 一行）。
- 可逆性: 安全可逆——純新增宣告式型別，無外部副作用、無資料遷移、無 audit append。

## (8) Depends-on / blocks
- Depends-on: **無 compile-time 前置**（S1 只 import `zod`，不 import policy/iam）。**概念對映** P2-E（已 merge）：manifest 的 `action`/`resourcePattern` 欄語意對映 `PolicyRequest.action`/`resource`——此為設計層對齊，非 import 依賴（故不構成 DAG 邊；列於 design §6 的 `S1 -> {P2-E}` 僅表「概念前置」）。無未 merge 前置。
- Blocks: P2R-R3-S2（registry 消費此 schema）、P2R-R3-S3（PDP 規則間接依賴）。
- 確認 slice DAG 無 cycle: 是（S1 rank=1，僅依賴已 merge 的 P2-E）。
