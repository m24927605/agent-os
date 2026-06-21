# SLICE-P2-B: `no-vendor-in-core` dependency 規則 — 把可插拔 HARD CONSTRAINT 變 `verify` 可驗

- **Phase**: P2（five-piece-integration build sequence STEP 0 — 可插拔法則先於任何 adapter）
- **Branch**: slice/p2-b-no-vendor-in-core
- **Author**: <id>    **Adversarial reviewer**: <fresh-context、非作者>
- **Size budget**: <= 0.5 day；net LOC <~120、files <~7（`.dependency-cruiser.cjs` 增一條規則 + `src/build/no-vendor-in-core.test.ts` + `test/fixtures/pluggability/{bad,clean}/...`）、新增依賴 = 0
- **狀態**: **DONE**（merge；fresh-context IV = PASS、零 defect）

## (1) ID + Title
SLICE-P2-B — 在 `.dependency-cruiser.cjs` 新增 forbidden 規則 `no-vendor-in-core`（severity error），使「核心治理模組 import/命名任何 vendor（hermes/nemoclaw/openshell/agt/spendguard）」**即 fail `pnpm run verify`**。vendor 只能存在於自己的 adapter 模組。

## (2) Goal（一句話）
把 AGENTS.md 第三條 HARD CONSTRAINT（可插拔、無 forced vendor combination）從文件宣稱**變成指令可驗**：core 碰 vendor → `deps:check` 非零 → verify 紅。

## (3) In-scope / Out-of-scope
- In-scope：`no-vendor-in-core` 規則（from = 核心模組 `(iam|policy|audit|commitgate|orchestration|credential|approval|tools|cost|hosting|build)`，pathNot `/adapters/`；to = vendor token，邊界須涵蓋 `@scoped` 與 `-suffix` 命名）；fixtures（bad = core→vendor、clean = core→core）；測試（結構斷言 + 行為 depcruise + exit-code + regex lock-table）。
- Out-of-scope：「vendor 只能從自己的 adapter import」的**細規則**（待 adapter 目錄存在後另 slice）；任何 vendor adapter 實作本身。

## (4) Design + 模組 + 介面 + 依賴方向
- **Design delta**：純 build-gate 規則 + 測試；不動產品 code。
- **規則形狀**：`from.path = "(^|/)src/(iam|policy|audit|commitgate|orchestration|credential|approval|tools|cost|hosting|build)/"`、`from.pathNot = "(^|/)src/[^/]+/adapters/"`；`to.path = "(^|[/@])(hermes|nemoclaw|openshell|agt|spendguard)([/@.-]|$)"`（邊界接受 `/ @ . -` 與字串端，故 `@scope/` 與 `vendor-sdk` 都擋；拒絕 `magtools`/`fragment` 之類偶含子字串）。path-matched 故 unanchored fixture 能跑同一規則。
- **依賴方向**：規則 + 測試；測試 shell 出 `depcruise`（沿用 `verify-cascade.test.ts` 的 execFileSync 慣例）。

## (5) Test-first plan（RED 先行）
先寫 `src/build/no-vendor-in-core.test.ts`（規則尚未加 → RED）：
1. **結構**：load `.dependency-cruiser.cjs`，斷言有 `no-vendor-in-core`、severity `error`、`to` 含全部 5 個 vendor token、`from` 含 core 與 adapters 排除。
2. **行為**：`depcruise <bad-fixture> --output-type json` 的 violations 含 `no-vendor-in-core`；clean fixture 不含。
3. **exit-code**：`depcruise <bad-fixture>`（預設 output，鏡像 deps:check）exit≠0；clean exit 0。
4. **regex lock-table**：由 config 取 `to.path` 建 RegExp，斷言 match `@hermes/agent`/`openshell-sdk`/`hermes-agent/...` 等危險形式、不 match `magtools`/`fragment`/真實 core 路徑。
5. **real src**：`depcruise src` 無 `no-vendor-in-core` violation。
> 預期首次 RED：結構斷言 + 行為「FIRES」失敗（規則不存在）。

## (6) Definition of Done（每條附指令證據 — 實測）
- [x] **first RED**（規則未加）：`vitest run no-vendor-in-core.test.ts` → **4 failed | 2 passed**（exit≠0）。
- [x] `pnpm run verify` **exit 0**（加規則後；68 tests、deps 0 violations、secret-scan clean）。
- [x] `deps:check` 綠；IV 親植 `openshell-sdk`/`@hermes/agent`/bare 三種 vendor import fixture → 預設 output exit≠0；benign `magtools`/`fragment` → exit 0（非 no-op）。
- [x] secret-scan clean。
- [x] **Adversarial review = PASS**（fresh-context IV，零 defect；mutation：weaken severity → 2 紅、刪 vendor token → 4 紅）。

## (7) Rollback
revert 該 commit 即移除規則 + 測試 + fixtures（無產品 code 受影響）。

## (8) Depends-on / blocks
- Depends-on：P0/P1 已 merge 的 dependency-cruiser gate（`deps:check` 已串 verify）。
- Blocks：P2-A（adapter 增生前先鎖法則）；間接所有後續 vendor adapter slice。
