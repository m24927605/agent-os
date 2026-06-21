# SLICE-P2R-R7-S2: ClarifyLoop ≤3 問 + fail-closed

- **Phase**: P2（R7 Personal 零技能殼 — clarify-or-fail-closed 不變量）
- **Branch**: slice/p2r-r7-s2-clarify-loop-fail-closed
- **Author**: Frontend Developer（agency-agents）   **Adversarial reviewer**: fresh-context 獨立 Opus 4.8（非作者）
- **Size budget**: <= 1 day；net LOC <~150、files <~4（`src/personal/intent/clarify.ts` + `clarify.test.ts` + barrel 一行 + 可選 `schema.ts` 微調）、modules = 1（`personal/intent`）、新增依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R7-S2 — 新增 `ClarifyLoop`：當 `receiveText` 回 `needs-clarification` 時，**最多問 3 個**deterministic 澄清問題（一缺項一問），收斂成 `StructuredIntent`；**3 問後仍模糊 ⇒ fail-closed deny**，絕不猜。

## (2) Goal（一句話）
把不變量 1（clarify-or-fail-closed，≤3 問）變成可指令驗的狀態機：`startClarify(partial)` → `answer(q,a)` 迴圈，至多 3 輪，收斂→intent、超限→deny。

## (3) In-scope / Out-of-scope
- In-scope：
  - `ClarifyState` FSM（`asking` → `asking` → `asking` → `resolved` | `denied`）；**question budget = 3 hard cap**。
  - 每輪問**一個**缺項（deterministic，依 S1 的 `missing` 順序）；answer 併回 partial 再經 S1 `StructuredIntent.parse`。
  - 3 問後仍未通過 parse → `status:"denied", reason:"clarification budget exhausted"`（fail-closed）。
  - 任一 answer 含 secret-like → 經 redaction、若仍無法澄清 → 不洩漏、照 deny 路徑。
- Out-of-scope（明確不做）：
  - LLM 生成自然語言問題（capability gate G1，inactive）→ 本 slice 問題為模板化（缺項名→固定問句）。
  - plan preview → S3；approval → S4。
  - 多輪 free-form 對話歷史記憶 → 不做（YAGNI）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：在 `personal/intent` 加一個純狀態機，消費 S1 的 `StructuredIntent`/`missing`；無既有行為變更。
- **Modules touched（唯一責任）**：
  - `src/personal/intent/clarify.ts` — 唯一責任：在 ≤3 問內把 partial intent 收斂或 deny。
- **PUBLIC interface（`src/personal/intent/index.ts` 追加）**：
  - `const CLARIFY_MAX_QUESTIONS = 3`。
  - `type ClarifyStep = { status:"asking"; question:string; missing:string; asked:number } | { status:"resolved"; intent:StructuredIntent } | { status:"denied"; reason:string }`。
  - `function startClarify(text:string, ctx:AgentContext): ClarifyStep`。
  - `function answerClarify(state:ClarifyStep & {status:"asking"}, answer:string): ClarifyStep`。
- **Dependency direction（inward、acyclic）**：
  ```
  personal/intent/clarify ──▶ personal/intent/schema+gateway（同模組內）
  ```
  - 僅同模組內依賴 + 既有 iam/audit barrel（同 S1）：☐ 是。
  - 新依賴宣告：無（同模組內、無新跨 module）。

## (5) Test-first plan（RED 先行）
- 測試檔：`src/personal/intent/clarify.test.ts`（clarify 不存在 → RED）。
- RED 測試清單：
  - [ ] 一個缺項 → `asking`（`question` 對應該缺項、`asked=1`）；補答 → `resolved`。
  - [ ] 兩個缺項 → 連問 2 次（`asked` 遞增）→ 補齊 → `resolved`。
  - [ ] **fail-closed（對抗式）**：3 問後仍缺/仍 malformed → `denied`，`reason` 含 budget exhausted；**不**回 intent。
  - [ ] **hard cap 不可繞過**：第 4 次 `answerClarify` 對已 `denied`/`resolved` state 無效（不再問）。
  - [ ] answer 含 secret canary（runtime 組裝）→ 經 redaction；deny 路徑回傳不含 canary。
- 首次紅燈證據：clarify.ts 不存在時，import 失敗 → 測試套件無法解析 → FAIL（exit 1）。
  GREEN 後同一套件（10 tests，含 §5 全部對抗式案例）：
  ```
  $ node_modules/.bin/vitest run src/personal/intent/clarify.test.ts
  ✓ src/personal/intent/clarify.test.ts (10 tests) 4ms
  Test Files  1 passed (1)
       Tests  10 passed (10)
  exit code: 0
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（§5 首次 RED → GREEN，clarify.test.ts 10/10）。
- [x] `pnpm run verify` exit 0：`VERIFY_EXIT=0`（typecheck+lint+build+test+go+secret-scan 全綠）。
- [x] `pnpm run deps:check` exit 0：`✔ no dependency violations found (80 modules, 186 dependencies cruised)`（無 cycle、無 vendor、inward；同模組內聚）。
- [x] low coupling / high cohesion 遵守（純狀態機、同 `personal/intent` 模組、僅消費 S1 public `receiveText`；continuation state 藏於 non-enumerable symbol）。
- [x] secret-scan 乾淨（canary runtime 組裝）：`secret-scan: clean`。
- [x] Docs 更新（barrel 追加 export `CLARIFY_MAX_QUESTIONS` / `startClarify` / `answerClarify` / `ClarifyStep`）。
- [x] Adversarial code review = PASS（fresh-context）— 摘要：≤3 hard cap 不可繞過、3 問後 fail-closed deny 不回 intent、deny 路徑不洩漏 canary，皆有對抗式測試覆蓋。
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（≤3 hard cap 不可繞過、fail-closed deny、credential non-leak）。

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `clarify.ts` + barrel 追加行）。
- 可逆性：安全可逆（無外部副作用、純新增）。

## (8) Depends-on / blocks
- Depends-on：S1（StructuredIntent schema + `missing`）。
- Blocks：S7（voice，需 clarify 行為穩定）。
- 確認 slice DAG 無 cycle：☐ 是（S2 rank 2，僅依賴 rank 1 的 S1）。
