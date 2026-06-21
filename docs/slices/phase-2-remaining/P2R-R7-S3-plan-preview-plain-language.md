# SLICE-P2R-R7-S3: PlanPreview（白話投影）

- **Phase**: P2（R7 Personal 零技能殼 — plan-preview-before-effect 不變量）
- **Branch**: slice/p2r-r7-s3-plan-preview
- **Author**: Frontend Developer（agency-agents）   **Adversarial reviewer**: fresh-context 獨立 Opus 4.8（非作者）
- **Size budget**: <= 1 day；net LOC <~120、files <~4（`src/personal/plan/{preview.ts,index.ts}` + `preview.test.ts` + barrel 一行）、modules = 1（`personal/plan`）、新增依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R7-S3 — 新增 `renderPlanPreview(intent)`：把 `StructuredIntent` 模板化成**零技能可讀的白話計畫**（步驟清單 + 受影響資源 + 成本/風險摘要），**非 LLM 生成**、deterministic、出口先過 redaction。

## (2) Goal（一句話）
把結構化意圖翻成人話計畫預覽，作為 S4 ApprovalInbox 顯示給使用者核准的內容——讓「同意前看得懂」成立。

## (3) In-scope / Out-of-scope
- In-scope：
  - `renderPlanPreview(intent): PlanPreview`：`{ title, steps:string[], affectedResources:string[], summary }`，全部由 intent 結構模板化生成。
  - 出口 redaction：preview 文字經 `src/audit/redact.ts`，保證不洩漏 intent 內可能殘留的 secret-like 值。
  - deterministic：同 intent → 同 preview（snapshot 可驗）。
- Out-of-scope（明確不做）：
  - LLM 潤飾文案（capability gate G1，inactive）。
  - 實際成本數字精算（用 intent 的粗估欄；精算屬 CostGate/R6，不在此）。
  - 核准動作本身 → S4（本 slice 只 render，不 approve）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 `personal/plan` 模組；純函式（intent→preview）；無既有行為變更。
- **Modules touched（唯一責任）**：
  - `src/personal/plan/preview.ts` — 唯一責任：把 StructuredIntent 投影成白話 PlanPreview。
  - `src/personal/plan/index.ts` — barrel。
- **PUBLIC interface（`src/personal/plan/index.ts`）**：
  - `interface PlanPreview { title:string; steps:string[]; affectedResources:string[]; summary:string }`。
  - `function renderPlanPreview(intent:StructuredIntent, deps?:{ redact?:(s:string)=>string }): PlanPreview`。
- **Dependency direction（inward、acyclic）**：
  ```
  personal/plan ──▶ personal/intent (StructuredIntent type)   personal/plan ──▶ audit/redact
  ```
  - 僅經 public surface 消費（`personal/intent` 自有 barrel + `src/audit` barrel——後者由 **B0** 提供；
    **不**經頂層 `src/index.ts`）：☐ 是（reviewer 跑 `deps:check`）。
  - 新依賴宣告：`personal/intent`（type-only，inward、無 cycle）；`audit`（出口 redaction `redactSecrets`，
    inward、不變量 4）。core 無 vendor。
  - **barrel 前置（command-verifiable）**：`src/audit` 無 `index.ts`，故依賴 **B0** 先 merge，否則對
    `audit/redact.ts` 的 deep-import 會令 `pnpm run deps:check` **exit≠0**（design §2.2 barrel 缺口）。

## (5) Test-first plan（RED 先行）
- 測試檔：`src/personal/plan/preview.test.ts`（preview 不存在 → RED）。
- RED 測試清單：
  - [ ] 一個含 N 步的 intent → `steps.length === N`、每步為白話字串、`affectedResources` 列出 intent.targets。
  - [ ] deterministic：同 intent 兩次呼叫 → 深度相等（snapshot）。
  - [ ] **credential non-leak（對抗式）**：intent 欄殘留 secret canary（runtime 組裝）→ preview 任一欄**不含**該 canary（經 redaction）。
  - [ ] 空/極小 intent → 仍產出非空 title/summary（不丟例外、零技能友善）。
- 首次紅燈證據：
  ```
  $ pnpm test src/personal/plan/preview.test.ts
  ... FAIL (renderPlanPreview / module not found) ...
  exit code: 1   ← RED seen before impl
  ```
  - GREEN 後（merge 前）：`pnpm test src/personal/plan/preview.test.ts` → 5 passed，exit 0。

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（§5 首次 RED → impl 後 GREEN：`pnpm test src/personal/plan/preview.test.ts` 5 passed, **exit 0**）。
- [x] `pnpm run verify` **exit 0**（typecheck && lint && build && test && verify:go && secret-scan 全綠）。
- [x] `pnpm run deps:check` **exit 0**（`✔ no dependency violations found (82 modules, 191 dependencies cruised)`；
      `personal/plan` 只經 `personal/intent` barrel + `audit` barrel 消費、無 cycle、無 vendor、inward；**不** import 頂層 `src/index.ts`）。
- [x] low coupling / high cohesion 遵守（純函式 + 可注入 redactor；唯一責任 = intent→preview 投影）。
- [x] secret-scan 乾淨（`secret-scan: clean`，canary runtime 組裝）。
- [x] Docs 更新（`src/index.ts` barrel 已加 `export * from "./personal/plan/index.js";`）。
- [x] Adversarial code review = PASS（fresh-context 獨立 Opus 4.8）— 摘要：deterministic 模板投影、出口 redaction 經 audit barrel、無 deep-import、credential non-leak 對抗式測試通過。
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（credential non-leak 出口投影對抗式探測 + 重跑 `pnpm run verify` exit 0）。

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `personal/plan` 模組 + barrel 一行）。
- 可逆性：安全可逆（純新增、無外部副作用）。

## (8) Depends-on / blocks
- Depends-on：S1（StructuredIntent）；**B0**（audit barrel，供出口 redaction 經 `deps:check` 接受的 import）。
- Blocks：S4（ApprovalInbox 顯示 preview 供核准）。
- 確認 slice DAG 無 cycle：☐ 是（S3 rank 2，僅依賴 rank 1 的 S1 與先 merge 的 B0）。
