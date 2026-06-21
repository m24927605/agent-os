# SLICE-P2R-R9-S3: CLI `agentos`：`manifest lint`（消費 R3 parse）+ `verify`（relay verifier exit）

- **Phase**: P2（R9 第三刀；Developer surface — CLI）
- **Branch**: slice/p2r-r9-s3-cli-manifest-lint-and-verify
- **Author**: agency-agents writer（Backend Architect）    **Adversarial reviewer**: <fresh-context Opus 4.8、非作者>
- **Size budget**: <= 1 day；net LOC <~200、files <~4（`src/cli/main.ts` + `src/cli/main.test.ts` + `src/cli/index.ts` barrel + `package.json` 加一個 `bin`/script 入口一行）、modules = 1（新 `cli`）、新增依賴 = 0（用 Node 內建 `process.argv` + `node:child_process`）
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R9-S3 — 新增薄 CLI `agentos`，兩個 exit-code 化子命令：`agentos manifest lint <file>`（讀 JSON → `parseToolManifest` → 合法 exit 0 / 不合法 exit 1）與 `agentos verify --chain <f> --pubkey <f>`（spawn release verifier binary 並 relay 其 exit code）；零新第三方依賴、fail-closed（未知子命令/缺參數 → 非 0）。

## (2) Goal（一句話）
給作者/稽核者一條**命令列、只看 exit code** 的入口去 lint ToolManifest 與離線驗鏈。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/cli/main.ts`：用 `process.argv` 解析子命令；`manifest lint <file>` → 讀檔 → SDK 的 `parseToolManifest` → 成功 print ok + exit 0 / 失敗 print reason 到 stderr + exit 1。
  - `agentos verify --chain <f> --pubkey <f>`：用 `node:child_process` spawn S5 產出的 verifier binary（路徑可由 `AGENTOS_VERIFIER_BIN` 覆寫；缺 binary → 明確錯誤 + 非 0），**relay** 其 exit code（0=intact、1=broken、2=bad input）。
  - fail-closed 解析：未知子命令、缺必要參數、缺檔 → 非 0 退出。
  - `package.json` 加一個 `bin` 或 `scripts` 入口讓 CLI 可被叫用（一行）。
- Out-of-scope（明確不做）:
  - 互動式 scaffold / TUI → 後續。
  - 引入 commander/yargs 等 CLI 框架 → 不做（零依賴；若日後需要，單獨成 slice，slice-spec §3）。
  - authoring 範本與文件 → 留給 **P2R-R9-S4**。
  - verifier binary 本身的 build → 留給 **P2R-R9-S5**（本 slice 只 spawn + relay，binary 缺席時測試用既有 Go source build 的 verifier 或 mock 路徑驗 relay 行為）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 目前無 CLI；新增 `src/cli/` 把 R3 parse（經 SDK barrel）+ verifier（`kernel/cmd/verifier/main.go:22-71` 的 exit 0/1/2 語意）暴露成命令列。CLI 是**薄 relay 層**：parse 委派 R3、驗鏈委派既有 verifier，不重實作任何邏輯。
- **Modules touched（唯一責任）**:
  - `src/cli/main.ts` — 唯一責任：把 argv 解析成「呼叫 SDK parse / spawn verifier」並以 exit code 回應；不含 schema 邏輯、不含驗鏈邏輯。
- **PUBLIC interface（新增）**:
  - CLI 介面（非函式簽章而是命令契約）：`agentos manifest lint <file>` → exit 0/1；`agentos verify --chain <f> --pubkey <f>` → relay 0/1/2。
  - `export function runCli(argv: string[]): Promise<number>`（testable entrypoint，回傳 exit code，比照 `verifyMain` 的 testable-entrypoint pattern，`kernel/cmd/verifier/main.go:26-27`）。
- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    src/cli/main.ts ──▶ src/sdk/index.ts（parseToolManifest）
                    ──▶ node:child_process / node:fs（stdlib）
                    ──▶ (spawn) kernel verifier binary（進程邊界，非 import）
    ```
  - 僅經 public surface 消費（無 deep import）: 是（parse 經 SDK barrel；verifier 經**進程 spawn**，不 import Go/kernel 內部）。
  - 新依賴宣告: 無第三方新依賴（Node 內建 `process`/`child_process`/`fs`）。`cli → sdk` 單向、無 cycle、理由=暴露作者面。
  - no-vendor-in-core: 綠（`cli` 不含 vendor token；verifier 是 vendor-neutral kernel 產物）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/cli/main.test.ts`（呼叫 `runCli(argv)` 斷言回傳 exit code）
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] `manifest lint <合法 9 欄範本>` → `runCli` 回 0。
  - [ ] `manifest lint <夾帶未知欄位 / 缺欄位>` → 回 1（fail-closed，stderr 有 reason）。
  - [ ] **fail-closed 解析**：未知子命令 / 缺 `<file>` / 缺 `--pubkey` → 回非 0（不靜默 exit 0）。
  - [ ] `verify` 子命令在 verifier binary 缺席（`AGENTOS_VERIFIER_BIN` 指向不存在）→ 明確錯誤 + 非 0（fail-closed，不假裝 intact）。
  - [ ] `verify` relay：對一個會回 exit 1 的 verifier（mock/fixture binary）→ `runCli` 回 1（relay 不吞 broken）。
- 首次紅燈證據（貼 exit≠0；實作前填）:
  ```
  $ pnpm test src/cli/main.test.ts
  ... FAIL（import ../cli/main.js 失敗：模組不存在）...
  exit code: <填首次紅燈 exit>
  ```

## (6) Definition of Done（每條附指令證據；實作時填真實 exit code）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: <0>
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；`cli` 只 import sdk barrel + stdlib、無 deep import、no-vendor-in-core 綠）
- [ ] low coupling / high cohesion 遵守（`cli` 單一責任=argv→exit-code relay；驗鏈/parse 不重實作）
- [ ] secret-scan 乾淨（CLI/測試 fixture 無 secret-like 值；任何 pubkey/chain fixture 為公開測試資料）
- [ ] Docs 更新（design/developer-sdk.md §2.2 S3 與本 slice 一致）
- [ ] Adversarial code review = PASS（fresh-context；reviewer mutation：讓未知子命令 fallthrough exit 0 → fail-closed 測試應轉紅；讓 verify 在 binary 缺席時 exit 0 → 應轉紅）— 摘要: <填>
- [ ]（安全不變量類：fail-closed/relay 不吞 broken）Independent Verifier Pass 已執行並 clean（probed：未知/缺參數/缺 binary 皆非 0；relay 不把 broken 變 intact）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `src/cli/` + `package.json` bin 一行）。
- 可逆性: 安全可逆——CLI 為唯讀（lint）/ 唯讀驗鏈（verify relay），無外部副作用、無資料遷移、無 audit append。

## (8) Depends-on / blocks
- Depends-on: **P2R-R9-S2**（SDK barrel 提供 `parseToolManifest`）、**R3**（schema）。verifier binary 由 **P2R-R9-S5** 產出；本 slice 不硬性 block 於 S5（缺 binary 時 `verify` fail-closed 報錯，測試用 mock/source-build 驗 relay；S5 merge 後 CLI 即指向 release binary）。
- Blocks: P2R-R9-S4（authoring 用 `manifest lint` 當驗收）。
- 確認 slice DAG 無 cycle: 是（S3 rank=3，依賴 S2(rank2) + R3；對 S5 為**執行期可選**依賴，非編譯/DAG 硬邊，不成 cycle）。
