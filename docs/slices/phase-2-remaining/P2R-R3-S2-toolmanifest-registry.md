# SLICE-P2R-R3-S2: ToolRegistry（register dup-id→deny、lookup、fail-closed）

- **Phase**: P2（R3 第二刀；P2 — tool registry）
- **Branch**: slice/p2r-r3-s2-toolmanifest-registry
- **Author**: agency-agents writer    **Adversarial reviewer**: <fresh-context Opus 4.8、非作者>
- **Size budget**: <= 0.5 day；net LOC <~140、files <~3（`src/tools/registry.ts` + `src/tools/registry.test.ts` + `src/index.ts` barrel 一行）、modules = 1（`tools`）、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R3-S2 — 新增 **`ToolRegistry`**：in-memory `Map<string, ToolManifest>`，提供 `register(manifest)`（每筆走 S1 `parseToolManifest`；重複 `name` → **拒絕**，fail-closed）、`lookup(name): ToolManifest | undefined`、`has(name): boolean`、`list(): readonly ToolManifest[]`。

## (2) Goal（一句話）
讓「哪些工具存在、各自的副作用契約是什麼」有**單一權威來源**，且註冊本身 deny-by-default（malformed manifest 或重複 name 絕不靜默接受）。

## (3) In-scope / Out-of-scope
- In-scope:
  - `ToolRegistry` class：`register` / `lookup` / `has` / `list`。
  - `register` 對 input 走 `parseToolManifest`（malformed → throw，fail-closed）；重複 `name` → throw（或回 `{ok:false}`，slice 內擇一並測之；預設 throw 以與 parse fail-closed 一致）。
  - 建構子可選擇性 seed 初始 manifest 陣列（每筆逐一 `register`，任一失敗即整體失敗，fail-closed）。
  - barrel export 一行。
- Out-of-scope（明確不做）:
  - PDP `tool:invoke` 串接 → **P2R-R3-S3**。
  - 持久化 / 多租分割 → 留給 **R8**。
  - 自動從 vendor 探索填 registry → 留給 **R11**。
  - 動態 unregister / 版本並存 → 後續（YAGNI）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 在 `tools` module 內新增狀態載體（registry）。registry **只**持有 manifest 並做存在性/重複判定；**不**做 policy 決策（那是 S3）。
- **Modules touched（唯一責任）**:
  - `src/tools/registry.ts` — 唯一責任：以 name 為鍵維護一組已驗證 ToolManifest，並對 register 做 fail-closed 驗證 + 重複拒絕。
- **PUBLIC interface（新增）**:
  - `export class ToolRegistry { constructor(seed?: readonly unknown[]); register(input: unknown): void; has(name: string): boolean; lookup(name: string): ToolManifest | undefined; list(): readonly ToolManifest[]; }`
- **Dependency direction（low coupling 自證）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    src/tools/registry.ts ──▶ src/tools/manifest.ts（同 module、S1 public surface）
    src/index.ts (barrel) ──▶ src/tools/registry.ts
    ```
  - 僅經 public surface 消費（無 deep import）: 是（只用 S1 export 的 `ToolManifest` / `parseToolManifest`）。
  - 新依賴宣告: 對 `manifest.ts`（S1）的 intra-module 依賴 — 方向=向內、cycle=無（S1 不 import registry）、理由=registry 必須驗證它存的 manifest。無第三方新增。
  - no-vendor-in-core: 綠。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/tools/registry.test.ts`
- RED 測試清單:
  - [ ] `register` 一個合法 manifest 後 `has(name)===true`、`lookup(name)` 回該 manifest、`list()` 含之。
  - [ ] 未註冊的 name → `has` false、`lookup` `undefined`（為 S3 的 deny 鋪路）。
  - [ ] **重複 name** 第二次 `register` → throw（fail-closed，不覆蓋、不靜默）。
  - [ ] **malformed manifest**（缺欄 / 未知欄 / 違反 S1 護欄）→ `register` throw（複用 S1 fail-closed）。
  - [ ] **seed 失敗原子性**：建構子 seed 含一筆 malformed → 建構 throw（不留半個 registry）。
  - [ ] 對抗式：`lookup(<空字串/非字串>)` → `undefined`/不 crash（deny-by-default，不誤命中）。
- 首次紅燈證據（貼 exit≠0；實作前填）:
  ```
  $ pnpm test src/tools/registry.test.ts
  ... FAIL（import ../tools/registry.js 失敗：模組不存在）...
  exit code: <填>
  ```

## (6) Definition of Done（每條附指令證據；實作時填）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: <0>
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；registry.ts 只 intra-module import S1、無 vendor）
- [ ] low coupling / high cohesion 遵守（registry 單一責任=存證+重複拒絕；不做 policy 決策）
- [ ] secret-scan 乾淨
- [ ] Docs 更新（design §2.2 registry 行為與本 slice 一致）
- [ ] Adversarial code review = PASS（fresh-context；mutation：重複 name 改為覆蓋 → dup 測試轉紅；register 跳過 parse → malformed 測試轉紅）— 摘要: <填>
- [ ]（安全不變量類）Independent Verifier Pass 已執行並 clean（probed dup-deny、malformed-deny、seed 原子性、lookup 不誤命中）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 registry.ts + 測試 + barrel 一行）。
- 可逆性: 安全可逆——in-memory、無外部副作用、無資料遷移、無 audit append。

## (8) Depends-on / blocks
- Depends-on: **P2R-R3-S1**（消費 `ToolManifest` / `parseToolManifest`）。
- Blocks: **P2R-R3-S3**（PDP 規則以 registry 的 `has`/`lookup` 判定未註冊）。
- 確認 slice DAG 無 cycle: 是（S2 rank=2，僅依賴 S1 rank=1）。
