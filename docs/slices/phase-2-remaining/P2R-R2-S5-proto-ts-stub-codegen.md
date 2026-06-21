# SLICE-P2R-R2-S5: proto TS-stub codegen + proto:check TS drift gate（契約，無消費者）

- **Phase**: P2（R2 — 契約刀：跨 plane proto 的 TS stub 生成；契約先於消費者，slice-spec §9）
- **Branch**: slice/p2r-r2-s5-proto-ts-stub-codegen
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 0.5 day；net LOC <~80（`scripts/proto-gen.sh`/`proto-check.sh` 擴充；生成的 TS stub 為 **generated**，不計 net LOC）、files <~4、modules <~1、**新增依賴 = TS proto codegen 工具（devDependency；非 runtime RPC client）**
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R2-S5 — 擴充 [`scripts/proto-gen.sh`](../../../scripts/proto-gen.sh)（目前只有 `--go_out`/`--go-grpc_out`，
[`:5-9`](../../../scripts/proto-gen.sh)）生成 [`proto/ingest.proto`](../../../proto/ingest.proto) 的 **TS stub**，並擴充
[`scripts/proto-check.sh`](../../../scripts/proto-check.sh)（已掛在 `verify` 內，[`package.json:23,28`](../../../package.json)）讓
TS stub 漂移時 `proto:check` exit≠0。**此 slice 不引入任何 runtime RPC 依賴、不寫任何消費者**——它只把跨 plane
型別化契約的 TS 面固定下來，供 S6 adapter depends-on。

## (2) Goal（一句話）
在不引入 runtime RPC 依賴、不接任何消費者下，先把 proto 的 TS stub 生成與 drift gate 固定，作為契約先於消費者的最早一刀。

## (3) In-scope / Out-of-scope
- In-scope：
  - 選定 TS codegen 路徑（connect-es / ts-proto / buf），新增為 **devDependency**（codegen 工具，非 runtime）。
  - `scripts/proto-gen.sh` 增一段 TS 生成（輸出到固定目錄，例如 `src/runtime/_generated/ingest/`，標 generated）。
  - `scripts/proto-check.sh` 增「重生成後 `git diff` 應為空」的 TS 校驗（鏡像既有 Go 校驗作法）。
- Out-of-scope（明確不做）:
  - 任何 `AppendTransport` 實作 / RPC 連線 / runtime RPC 依賴 → 留給 S6。
  - composition-root 接線 → 留給 S7。
  - 改 `proto/ingest.proto` 本身（契約已存在且穩定；本 slice 只生成既有契約的 TS 面）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：`proto-gen.sh`/`proto-check.sh` 各增 TS 生成/校驗段；新增一個 **generated** TS stub 目錄。
  無手寫 runtime 程式、無 runtime 依賴。
- **Modules touched（唯一責任）**:
  - `scripts/proto-gen.sh` / `scripts/proto-check.sh` — 「生成並校驗 proto 的 TS stub（與 Go 對等的契約產物）」。
- **PUBLIC interface**:
  - 生成的 TS 型別/stub（generated 契約面；由 S6 adapter import）。新增 `proto:gen` 的 TS 產物與 `proto:check` 的 TS drift 關卡。
- **Dependency direction（inward、acyclic）**:
  ```
  proto/ingest.proto ──(codegen)──▶ generated TS stub（葉節點；無人 import，直到 S6）
  ```
  - 僅經 public surface 消費: ☑ 是（本 slice 無消費者）
  - 新依賴宣告：
    - `<TS proto codegen 工具>`：方向=dev-only（build-time），cycle=無，理由=產出跨 plane 契約的 TS 面；非 runtime 依賴，不入 `dependencies`。

## (5) Test-first plan（先寫的 RED 測試）
- 校驗指令: `pnpm run proto:check`（codegen 是 script，非 vitest test runner；RED 證據用 drift gate，鏡像 slice-spec §5 對 linter-類 gate 的 RED 作法）。
- RED 證據清單:
  - [ ] **drift RED**：先擴充 `proto:gen` 但**故意不 commit 生成的 TS stub**（或人為改一個 byte）→ `pnpm run proto:check` **exit≠0**（紅燈）。
  - [ ] 重生成並 commit 後 → `pnpm run proto:check` **exit 0**（綠燈）。
  - [ ] fail-closed：`proto-check.sh` 在 codegen 工具缺失 / 生成失敗時 **exit≠0**（不得靜默當通過）。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm run proto:check
  ... TS stub drift detected ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（drift RED 已貼於 §5）
  ```
  $ printf '\n// drift-canary\n' >> src/runtime/_generated/ingest/ingest.ts && pnpm run proto:check
  proto:check: FAIL — ingest.ts drifted from proto/ingest.proto (run: pnpm run proto:gen)
  exit code: 1
  # restored byte-for-byte → pnpm run proto:check → exit code: 0
  ```
- [x] `pnpm run verify` exit 0（含 `proto:check` 之 TS drift 校驗）
  ```
  $ pnpm run verify
  typecheck ✓ | lint: Checked 58 files ✓ | build ✓ | test: 22 files, 159 tests passed ✓
  deps:check: no dependency violations found (40 modules, 82 dependencies) ✓
  proto:check: go ok / ts ok / ok ✓ | verify:go: ok ✓ | verify:py: skip ✓ | secret-scan: clean ✓
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；generated stub 無被 core import、無 cycle）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (40 modules, 82 dependencies cruised)
  exit code: 0
  ```
- [x] low coupling / high cohesion 遵守（契約產物為葉節點；無消費者、無 runtime 依賴；type-only ts-proto，僅入 devDependencies）
- [x] secret-scan 乾淨（生成 stub 無 secret-like 值）
  ```
  $ pnpm run secret-scan
  secret-scan: clean
  exit code: 0
  ```
- [x] Docs 更新（`proto:gen` 新增 TS 生成、`proto:check` 新增 TS drift gate 的記錄 — `kernel/README.md` P2R-R2-S5 條目）
- [x] Adversarial code review = PASS（mutation：刪掉 TS drift 校驗段 → drift RED 無法轉紅，立即被抓；獨立 review 已通過）
- [x] （非安全不變量類 slice — 契約/工具）Independent Verifier Pass 非必需；以 §7 adversarial review 達成 Tier-2 acceptance（slice-spec §6.6 消歧）

## (7) Rollback
- `git revert <merge-sha>`（移除 proto-gen/proto-check 的 TS 段 + generated 目錄 + devDependency）。
- 可逆性: 安全可逆（build-time 契約產物，無 runtime 副作用、無 audit append）。

## (8) Depends-on / blocks
- Depends-on: P1 kernel proto（[`proto/ingest.proto`](../../../proto/ingest.proto) 契約已存在且穩定）。
- Blocks: SLICE-P2R-R2-S6（adapter import 生成的 TS stub）。
- 確認 slice DAG 無 cycle: ☑ 是（S5 為契約葉節點，只被 S6 depends-on）
