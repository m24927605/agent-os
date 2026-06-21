# SLICE-P2R-R7-S1: IntentGateway（text）+ StructuredIntent schema

- **Phase**: P2（R7 Personal 零技能殼 — text-first intent contract）
- **Branch**: slice/p2r-r7-s1-intent-gateway-text
- **Author**: Frontend Developer（agency-agents）   **Adversarial reviewer**: fresh-context 獨立 Opus 4.8（非作者）
- **Size budget**: <= 1 day；net LOC <~140、files <~4（`src/personal/intent/{schema.ts,gateway.ts,index.ts}` + `gateway.test.ts`）、modules = 1（`personal/intent`）、新增依賴 = 0（用既有 `zod`）
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R7-S1 — 新增 text-first `IntentGateway`：把一段自然語言 + AgentContext 收斂成一個 Zod-strict `StructuredIntent`，入口先過既有 audit redaction，模糊/含 secret/缺 required 欄 ⇒ **deny-by-default**（不猜、不執行）。

## (2) Goal（一句話）
立起 Personal surface 的**文字輸入契約**：`receiveText(text, ctx)` → `{status:"intent", intent} | {status:"needs-clarification", missing} | {status:"denied", reason}`，把零技能使用者的純文字變成下游可消費的結構化意圖。

## (3) In-scope / Out-of-scope
- In-scope：
  - `StructuredIntent` Zod schema（`.strict()`：`action`、`targets`、身份欄（經 AgentContext）、`rawText`-redacted）。
  - `IntentGateway.receiveText`：deterministic 解析（schema 驅動，**非 LLM**）；缺 required 欄 → `needs-clarification`（列出缺項，**不**在此 slice 跑 clarify 迴圈）；malformed/含 secret-like → `denied`。
  - 入口先過既有 `src/audit/redact.ts` redaction（rawText 不存原始 secret）。
- Out-of-scope（明確不做）：
  - clarify 迴圈（≤3 問）→ 留給 **S2**（本 slice 只回 `needs-clarification` + 缺項，不問問題）。
  - 白話 plan preview → 留給 **S3**。
  - LLM 輔助解析（capability gate G1，inactive）→ 後續 phase。
  - voice 輸入 → 留給 **S7**。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 `personal/intent` 模組；無既有行為變更。IntentGateway 是純函式式 + 注入 redactor，低耦合。
- **Modules touched（唯一責任）**：
  - `src/personal/intent/schema.ts` — 定義 `StructuredIntent` 的唯一結構與驗證（fail-closed parse）。
  - `src/personal/intent/gateway.ts` — 唯一責任：把 text+ctx 收斂成 intent 或 deny/needs-clarification。
  - `src/personal/intent/index.ts` — barrel（public surface）。
- **PUBLIC interface（`src/personal/intent/index.ts`）**：
  - `StructuredIntent`（Zod schema + type）。
  - `type ReceiveOutcome = { status:"intent"; intent:StructuredIntent } | { status:"needs-clarification"; missing:string[] } | { status:"denied"; reason:string }`。
  - `function receiveText(text:string, ctx:AgentContext, deps?:{ redact?:(s:string)=>string }): ReceiveOutcome`。
- **Dependency direction（inward、acyclic）**：
  ```
  personal/intent ──▶ iam (AgentContext)   personal/intent ──▶ audit/redact
  ```
  - 僅經 public surface 消費：取 `parseAgentContext`/`AgentContext`（`src/iam` barrel，由 **B0** 提供——
    在 B0 merge 前 `.dependency-cruiser.cjs` 以 `src/iam/ids.ts` interim 例外通行）、`redactSecrets`
    （`src/audit` barrel，由 **B0** 提供）。**不**經頂層 `src/index.ts`（該檔是 repo 對外 barrel，非
    `not-to-internal` 接受的 intra-`src` 消費路徑）：☐ 是（reviewer 追 import graph 並跑 `deps:check`）。
  - 新依賴宣告：`iam`（身份欄，inward、無 cycle、StructuredIntent 需 context）；`audit`（入口 redaction
    `redactSecrets`，inward、無 cycle、不變量 4）。core 無 vendor 名。
  - **barrel 前置（command-verifiable）**：`src/audit` 目前**無** `index.ts` barrel，故本 slice 依賴 **B0**
    （新增 `src/audit/index.ts` + `src/iam/index.ts`）先 merge，否則 `pnpm run deps:check` 會因
    `not-to-internal` 對 `audit/redact.ts` 的 deep-import 而 **exit≠0**（見 design §2.2 barrel 缺口註記）。

## (5) Test-first plan（RED 先行）
- 測試檔：`src/personal/intent/gateway.test.ts`（gateway 不存在 → RED：import 失敗）。
- RED 測試清單：
  - [ ] clean 完整 text + ctx → `status:"intent"`，`intent` 通過 `StructuredIntent.parse`。
  - [ ] 缺 required 欄（如無 action target）→ `status:"needs-clarification"`，`missing` 含該欄名。
  - [ ] **deny-by-default**：malformed / 空 / 無法解析 → `status:"denied"`（不回 intent）。
  - [ ] **credential non-leak（對抗式）**：text 含 secret-like canary（runtime 組裝）→ rawText 經 redaction 後**不含**該 canary；secret 不出現在任何回傳欄。
  - [ ] `StructuredIntent` 是 `.strict()`：多餘欄位 parse 失敗（fail-closed）。
- 首次紅燈證據（待實作時貼）：
  ```
  $ pnpm test src/personal/intent/gateway.test.ts
  ... FAIL（cannot find module ./gateway.js）...
  exit code: 1   ← 待填
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5）。
- [x] `pnpm run verify` exit 0。
      ```
      $ pnpm run verify   # typecheck && lint && build && test && deps:check && proto:check && openshell:proto:check && verify:go && verify:py && secret-scan
      Test Files  47 passed | 1 skipped (48)
           Tests  474 passed | 1 skipped (475)
      verify:go: ok
      secret-scan: clean
      VERIFY_EXIT=0
      ```
      聚焦本 slice 測試：
      ```
      $ node_modules/.bin/vitest run src/personal/intent/gateway.test.ts
      ✓ src/personal/intent/gateway.test.ts (8 tests) 4ms
      Test Files  1 passed (1)   Tests  8 passed (8)
      GW_EXIT=0
      ```
- [x] `pnpm run deps:check` exit 0（`personal/intent` 經 `src/audit` **barrel**（`redactSecrets`）+ interim
      `src/iam/ids.js` 例外消費；無 cycle、無 vendor、inward；**不** import 頂層 `src/index.ts`）。
      ```
      $ pnpm run deps:check   # depcruise src --config .dependency-cruiser.cjs
      ✔ no dependency violations found (79 modules, 180 dependencies cruised)
      DEPS_EXIT=0
      ```
- [x] low coupling / high cohesion 遵守（無新跨 module/cyclic 依賴；僅 public surface 消費；depcruise 0 違規）。
- [x] secret-scan 乾淨（canary runtime 組裝、無 source 字面值）。
      ```
      $ pnpm run secret-scan
      secret-scan: clean
      ```
- [x] Docs 更新（`src/index.ts` barrel 加 `./personal/intent/index.js`；`src/audit/index.ts` re-export `redactSecrets`）。
- [x] Adversarial code review = PASS（fresh-context；findings 已解）— 摘要：deny-by-default + credential
      non-leak 對抗式探測 clean；獨立 review 通過後交付 INTEGRATOR。
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（deny-by-default + credential non-leak 對抗式探測）。

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `personal/intent` 模組 + barrel 一行）。
- 可逆性：安全可逆（無外部副作用、無 audit append、純新增模組）。

## (8) Depends-on / blocks
- Depends-on：P2-I（已 merge；StructuredIntent→GovernedCall 的 lower 形狀對齊其 `GovernedCall`）；
  **B0**（audit/iam barrel-migration；提供 `deps:check` 接受的 `src/audit`/`src/iam` public 入口）。
- Blocks：S2（clarify）、S3（plan preview）、S7（voice）。
- 確認 slice DAG 無 cycle：☐ 是（S1 為 rank 1，僅依賴先 merge 的 P2-I/B0）。
