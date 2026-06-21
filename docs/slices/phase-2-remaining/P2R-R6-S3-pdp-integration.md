# SLICE-P2R-R6-S3: PDP 整合 — inference:invoke → evaluatePolicy（PDP 唯一 deny 權威）

- **Phase**: P2（ITEM R6 inference routing gate — 第三刀；見 [`../../design/inference-routing-gate.md`](../../design/inference-routing-gate.md) §2.2 / §4.3）
- **Branch**: slice/p2r-r6-s3-pdp-integration
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、Opus 4.8>
- **Size budget**: <= 0.5 day；net LOC <~160、files <~4（`src/inference/pdp-adapter.ts` + `src/inference/pdp-adapter.test.ts` + `src/inference/index.ts` barrel 增一行 + **新建** `src/policy/index.ts` policy barrel）、modules = 1（消費 policy public surface）、新增依賴 = 0
  - **前置事實（verified-from-code）**：`src/policy/` **尚無** `index.ts` barrel（只有 `types.ts`/`evaluate.ts`/`dedup.ts`）。dependency-cruiser 的 `not-to-internal` rule（`.dependency-cruiser.cjs:33-44`）只允許跨 module 經對方的 `index.ts` barrel（或 interim 的 `src/iam/ids.ts`）；新 source file deep-import `../policy/types.js` 會被該規則擋下、且 `../policy/index.js` 目前不存在會 resolve 失敗。故本 slice 必須**順手新建** `src/policy/index.ts`（`export * from "./types.js"; export * from "./evaluate.js"; export * from "./dedup.js";`），讓 `inference → policy` 可經 barrel 合規（與既有 `cost/index.ts` 同模式）。
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R6-S3 — 新增 `toPolicyRequest()` + `evaluateInferencePolicy()`，把 vendor-neutral `InferenceRequest` 轉成 `PolicyRequest(action="inference:invoke", resource=<model/host>)` 餵給既有 PDP（`src/policy/evaluate.ts`）。**PDP 是唯一 deny 權威**：PDP deny 即 deny，gate 絕不翻轉。

## (2) Goal（一句話）
讓推論路由的「授權」由既有 PDP（deny-precedence / deny-by-default / fail-closed）裁決，gate 只做轉換與轉發、不新增第二個 deny 權威。

## (3) In-scope / Out-of-scope
- In-scope:
  - `toPolicyRequest(req: InferenceRequest): PolicyRequest`（action 固定 `"inference:invoke"`；resource 由 model+egressHost 衍生；帶入 AgentContext ids）。
  - `evaluateInferencePolicy(req, evaluate): PolicyDecision`，其中 `evaluate: (input) => PolicyDecision` 由建構期注入（解耦規則來源，design §4.3 取捨 3）。
  - 不變量：PDP deny → 回 deny（不翻轉）；轉換不得遺失/偽造 ids（malformed ids → PDP 自身 fail-closed deny）。
- Out-of-scope（明確不做）:
  - 不修改 PDP（`evaluate.ts` 不動）。
  - PDP 規則集的來源/管理（規則注入由呼叫方/上層提供）。
  - model / egress allowlist 判定（S1 / S2）；CostGate（S4）；組合 any-deny-wins（S4）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 在 `src/inference/` 加 PDP 轉接層；**重用** 既有 PDP（型別 `PolicyRequest`/`PolicyDecision`；`evaluatePolicy` 由呼叫方經注入提供，本層不直接 import 它），不重寫任何 policy 邏輯。順手新建 `src/policy/index.ts` barrel（讓跨 module 消費合規，見 size budget 前置事實）。
- **Modules touched（唯一責任）**:
  - `src/inference/pdp-adapter.ts` — `InferenceRequest` ↔ `PolicyRequest` 轉換 + 轉發 PDP 決策。
  - `src/inference/index.ts` — barrel 增 re-export 一行。
  - `src/policy/index.ts` — **新建** policy 模組 public barrel（re-export `types`/`evaluate`/`dedup`；無邏輯）。
- **PUBLIC interface（新增）**:
  - `function toPolicyRequest(req: InferenceRequest): PolicyRequest`。
  - `function evaluateInferencePolicy(req: InferenceRequest, evaluate: (input: unknown) => PolicyDecision): PolicyDecision`。
- **Dependency direction（inward、acyclic）**:
  ```
  inference/index.ts ──▶ pdp-adapter.ts ──▶ types.ts（intra-module）
  pdp-adapter.ts ──▶ policy/index.js（PolicyRequest / PolicyDecision 型別，本 slice 新建的 public barrel）
  src/policy/index.ts ──▶ {policy/types.ts, policy/evaluate.ts, policy/dedup.ts}（intra-module re-export，無新跨界依賴）
  ```
  - 僅經 public surface 消費（無 deep import）: ☐ 是（經本 slice 新建的 `../policy/index.js` barrel；**不** deep-import `../policy/types.js`/`../policy/evaluate.js`，以符合 `.dependency-cruiser.cjs:33-44` 的 `not-to-internal` 規則；`evaluate` 由注入傳入避免硬連線到 PDP 實作）。
  - 新依賴宣告: `inference → policy`：方向=inward（domain↔domain，同層 type 契約）、cycle=無（policy 不 import inference；新建的 `policy/index.ts` 只 re-export 同模組檔案）、理由=PDP 是唯一 deny 權威，gate 必須消費其型別契約；以注入 `evaluate` 函式降低對 PDP 具體實作的耦合。`inference` 已在 core from-list（S1 加入），`policy` 本就在 from-list（`.dependency-cruiser.cjs:60`）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/inference/pdp-adapter.test.ts`（`pdp-adapter.js` 不存在 → RED：import 失敗）。
- RED 測試清單:
  - [ ] **轉換正確**：`toPolicyRequest` 產生的 `PolicyRequest` 通過 `PolicyRequest.safeParse`（schema-valid），action=`"inference:invoke"`，ids 與輸入一致。
  - [ ] **PDP 唯一權威**：注入一個 `evaluate` stub 回 `deny` → `evaluateInferencePolicy` 回 `deny`（gate 不翻轉）。
  - [ ] PDP allow → 回 allow（透傳 effect + auditRequired=true）。
  - [ ] **fail-closed**：注入的 `evaluate` 對 malformed input 回 deny（沿用 PDP 既有 fail-closed）；`evaluate` throw → 視為 deny（轉接層包 try/catch fail-closed）。
  - [ ] reason 不洩值：透傳 PDP reason（PDP 既保證不回顯請求值，`evaluate.ts:1-9`）；轉接層不另加請求值。
- 首次紅燈證據（impl 不存在時，import 解析失敗 → 套件失敗）:
  ```
  $ node_modules/.bin/vitest run src/inference/pdp-adapter.test.ts   # pdp-adapter.ts 移除後重放
  ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯  (Failed to resolve import "./pdp-adapter.js")
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5：移除 `pdp-adapter.ts` 重放 → exit 1，import 解析失敗）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... typecheck ok / lint 110 files ok / build ok / test 449 passed | 1 skipped
      (含 src/inference/pdp-adapter.test.ts 11 tests passed) / deps:check ✔ no violations
      / proto:check ok / openshell:proto:check ok / verify:go ok / verify:py skip
      / secret-scan clean ...
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；74 modules / 159 deps cruised、`✔ no dependency violations found`；`inference → policy` 經 `src/policy/index.ts` barrel、inward、無 cycle、`not-to-internal` 未觸發即無 deep import）
- [x] low coupling / high cohesion 遵守（不修改 PDP；以注入 `evaluate` 解耦；無 vendor；`no-vendor-in-core` test 綠）
- [x] secret-scan 乾淨（`pnpm run secret-scan` exit 0 → `secret-scan: clean`）
- [x] Docs 更新（本 slice doc 連結回 design §2.2/§4.3）
- [x] Adversarial code review = PASS（fresh-context；PDP-deny 不可被轉接層翻轉、malformed/throw fail-closed、reason 不洩值皆對抗探測）— 摘要: 獨立審查通過、可合併（integrator 階段）。
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（PDP 唯一權威、fail-closed、reason non-leak 皆被抓；`verify` 重跑 exit 0）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `pdp-adapter.ts` + inference barrel 一行 + 新建的 `src/policy/index.ts`）。
- 可逆性: 安全可逆（純新增、不改 PDP；新建的 `src/policy/index.ts` 只 re-export，移除後既有 deep-import 之 test 仍可運作）。

## (8) Depends-on / blocks
- Depends-on: SLICE-P2R-R6-S1（`InferenceRequest` 型別）；P2-E（PDP / `PolicyRequest` / `PolicyDecision`）。
- Blocks: SLICE-P2R-R6-S4（組合）。
- 確認 slice DAG 無 cycle: ☐ 是。
</content>
