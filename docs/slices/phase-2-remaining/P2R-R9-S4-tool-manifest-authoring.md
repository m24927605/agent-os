# SLICE-P2R-R9-S4: ToolManifest authoring 範本 + 文件 + lint 驗收

- **Phase**: P2（R9 第四刀；Developer surface — ToolManifest authoring）
- **Branch**: slice/p2r-r9-s4-tool-manifest-authoring
- **Author**: agency-agents writer（Backend Architect）    **Adversarial reviewer**: <fresh-context Opus 4.8、非作者>
- **Size budget**: <= 0.5 day；net LOC <~120、files <~4（`docs/sdk/tool-manifest-authoring.md` + `src/sdk/templates/tool-manifest.example.json` + `src/sdk/templates/index.ts`（匯出範本路徑/物件）+ `src/sdk/templates/templates.test.ts`）、modules = 1（`sdk/templates`）、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R9-S4 — 交付 **ToolManifest authoring 體驗**：一個可複製的 9 欄合法範本（`tool-manifest.example.json`）+ authoring 文件（含一致性護欄說明）+ 測試證明「範本經 `parseToolManifest` 合法、一個刻意違規 fixture 被拒」。**不新增 schema 邏輯**（schema 屬 R3）。

## (2) Goal（一句話）
讓作者「複製範本 → 改值 → `agentos manifest lint`」就能產出**結構合法、護欄滿足**的 ToolManifest。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/sdk/templates/tool-manifest.example.json`：合法 9 欄範本（`name`/`version`/`description`/`action`/`resourcePattern`/`sideEffect`/`idempotent`/`requiresApproval`/`bundleRefOnly`），且滿足 R3 兩條一致性護欄（`sideEffect:"none"`⇒`idempotent:true`；`destructive`⇒`requiresApproval:true`）。
  - `src/sdk/templates/index.ts`：匯出範本（物件 + 解析後的型別），供 SDK 消費者程式化取用。
  - `docs/sdk/tool-manifest-authoring.md`：authoring 步驟、9 欄語意（連 R3 design §2.1）、護欄解釋、`agentos manifest lint <file>` 用法。
  - `src/sdk/templates/templates.test.ts`：範本經 `parseToolManifest` 成功；一個刻意違規 fixture（如 destructive 但 `requiresApproval:false`）經 parse → throw（護欄驗收）。
- Out-of-scope（明確不做）:
  - 任何 schema / parse 邏輯變更 → 屬 **R3**（本 slice 只消費）。
  - CLI 子命令邏輯 → 屬 **P2R-R9-S3**（本 slice 只當其驗收輸入）。
  - 範本的密碼學簽章 / provenance → 後續。
  - 多語言 SDK 範本（Python authoring）→ 後續（R9 Python 面在 S1 只做 credential-blind 骨架）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 目前無 authoring 資產；新增 `sdk/templates` 提供合法範本與文件。**不改** R3 schema、不改 CLI——純作者體驗層，驗收完全靠既有 `parseToolManifest`（R3）與 `manifest lint`（S3）。
- **Modules touched（唯一責任）**:
  - `src/sdk/templates/` — 唯一責任：提供合法 ToolManifest 範本與其程式化匯出；不含 schema 邏輯、不含 I/O。
- **PUBLIC interface（新增）**:
  - `src/sdk/templates/index.ts`：`export const exampleToolManifest: unknown`（原始 JSON 物件）+（可選）`export function loadExampleToolManifest(): ToolManifest`（經 R3 `parseToolManifest`）。
  - 文件 `docs/sdk/tool-manifest-authoring.md`（非程式介面）。
- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    src/sdk/templates/index.ts ──▶ src/sdk/index.ts（parseToolManifest，經 SDK barrel）
                               ──▶ ./tool-manifest.example.json（同 module 內資產）
    ```
  - 僅經 public surface 消費（無 deep import）: 是（parse 經 SDK barrel；不 deep-import R3 內部檔）。
  - 新依賴宣告: 無第三方新依賴。`templates → sdk` 單向、無 cycle、理由=範本驗收需 R3 parse。
  - no-vendor-in-core: 綠（範本為 agent-agnostic 示例、不含 vendor token、不含 secret）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/sdk/templates/templates.test.ts`
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] `exampleToolManifest` 經 `parseToolManifest` → 成功（範本是合法 9 欄、護欄滿足）。
  - [ ] 文件中宣稱的「違規範例」fixture（destructive + `requiresApproval:false`）經 parse → throw（護欄真的擋）。
  - [ ] 範本檔不含 secret-shaped 值、`bundleRefOnly` 示例只用 bundleRef 字串（如 `"github:PAT:prod"`）。
- 首次紅燈證據（貼 exit≠0；實作前填）:
  ```
  $ pnpm test src/sdk/templates/templates.test.ts
  ... FAIL（import ../templates/index.js / 範本檔不存在）...
  exit code: <填首次紅燈 exit>
  ```

## (6) Definition of Done（每條附指令證據；實作時填真實 exit code）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: <0>
  ```
- [ ] **authoring 驗收**：`agentos manifest lint src/sdk/templates/tool-manifest.example.json` exit 0；對違規 fixture exit 1（貼兩個 exit code）
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；`templates` 只經 SDK barrel、無 deep import、no-vendor-in-core 綠）
- [ ] low coupling / high cohesion 遵守（`templates` 單一責任=合法範本；無 schema 邏輯）
- [ ] secret-scan 乾淨（範本/fixture 無 secret-like 值；bundleRef 只是參照字串）
- [ ] Docs 更新（design/developer-sdk.md §2.2 S4；新增 `docs/sdk/tool-manifest-authoring.md`）
- [ ] Adversarial code review = PASS（fresh-context；reviewer mutation：把範本改成違規（destructive+免審批）→ `parseToolManifest` 測試應轉紅，證明範本受 R3 護欄約束）— 摘要: <填>
- [ ]（非安全不變量類：作者體驗 + 範本）以 §7 adversarial review 達成 Tier-2 acceptance，不另跑 Independent Verifier Pass

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `src/sdk/templates/` + `docs/sdk/tool-manifest-authoring.md`）。
- 可逆性: 安全可逆——純文件 + 範本資產，無外部副作用、無資料遷移、無 audit append。

## (8) Depends-on / blocks
- Depends-on: **P2R-R9-S3**（`manifest lint` 當驗收命令）、**R3**（`parseToolManifest` + 9 欄 + 護欄）。
- Blocks: 無（R9 作者體驗終點）。
- 確認 slice DAG 無 cycle: 是（S4 rank=4，依賴 S3(rank3) + R3，每條邊嚴格遞減）。
