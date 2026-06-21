# R5 設計文件 — Task / AgentSession FSM + resume ledger（crash-idempotent over P2-I pipeline）

> 2026-06-21。本文件是 [`phase-2-remaining/INDEX.md`](../slices/phase-2-remaining/INDEX.md) **R5** 的設計文件（doc-first，無 doc 不開工）。
> 方法論見 [`looping-engineering.md`](../standards/looping-engineering.md)、slice 範本見 [`slice-spec.md`](../standards/slice-spec.md)、
> 驗收見 [`test-and-acceptance.md`](../standards/test-and-acceptance.md)、review 見 [`adversarial-code-review.md`](../standards/adversarial-code-review.md)。
> 架構定位見 [`three-surface-architecture.md`](./three-surface-architecture.md)、[`five-piece-integration.md`](./five-piece-integration.md)。
> **AGENTS.md 在任何衝突上勝出。only command output is truth。**

---

## 1. 要解什麼（what）+ 為什麼（why）

P2-I 已交出 `runGovernedToolCall(deps, toolCall)`：把**單一** brain 提議的 ToolCall 走完受治理管線
（screen → policy → cost.reserve → **commit-before-effect** → effect → cost.commit），fail-closed、短路、
effect 只在 audit receipt 之後發生（`src/orchestration/pipeline.ts:53`）。**但真實 agent 的工作不是一次 ToolCall，
而是多步驟（multi-step）的 Task。** 缺口有三：

1. **沒有「一個 Task = 多個 governed step」的生命週期容器。** 目前每個 ToolCall 各自孤立，沒有把它們綁成
   一個有狀態、可觀察、可終止的工作單位（Task），也沒有一個承載「誰在跑這個 Task」的執行身份（AgentSession）。
2. **沒有 crash-resume。** 若 process 在第 3 步後 crash，重啟時無從得知「前 3 步已做、第 4 步沒做」，
   只能整個 Task 重跑——這會**重複真實外部 effect**（重複建 sandbox、重複付費、重複送出 egress），
   違反 P2-I 苦心建立的「no un-recorded effect」護城河的對偶面：「no **duplicated** effect」。
3. **沒有把「已發生的 effect」變成可重播的 append-only 真相。** P2-I 的 commit-before-effect 已把
   AuditEvent 寫進 WORM kernel（`src/commitgate/guard.ts:1`），但 orchestration 層沒有一個**resume ledger**
   把「step k 的 governed 結果（executed/denied + receipt）」記成 Task 範圍的 append-only 序列，供重啟後判定
   「哪些 step 已完成、不可再跑」。

**R5 補上這三塊**：Task FSM（多步容器的狀態機）+ AgentSession（執行身份）+ resume ledger（append-only、
content-hash dedup）+ crash-resume（重啟後 fold ledger，已完成的 step **零重複 external effect**），
**全部 compose 在 P2-I 既有 pipeline 之上**（不重寫 pipeline，靠依賴注入接 P2-I 的 `runGovernedToolCall`）。

### 為什麼現在做（de-risk 價值）
- 三 surface 最上層（R7 Personal 殼、R8 Enterprise 脊椎、R10 時光旅行）**全部 depends-on** 一個可重播、
  crash-safe 的 Task 概念：Personal 的 TaskTimeline 要從 WORM 重建（INDEX R7）、時光旅行的 Forensic Replay
  要 fold step 序列（INDEX R10）。R5 是它們的共同前置。
- crash-idempotency 是「治理可信」的硬需求：一個會在 crash 後重複扣款、重複送出對外動作的系統，
  其 audit 與 cost hard-cap 都會被繞過。R5 把 P2-I 的單步保證**延伸到多步、跨 crash**。

---

## 2. 架構（architecture）

### 2.1 三個新概念（皆 orchestration 層、vendor-neutral、零 vendor import）

```
            ┌────────────────────────── Task (FSM) ──────────────────────────┐
            │  status: pending → running → (completed | failed | aborted)     │
            │  steps: ordered list of governed step intents                   │
            │  cursor: index of next-to-run step                              │
            └───────────────┬─────────────────────────────────────────────────┘
                            │ each step runs through P2-I:
                            ▼
       AgentSession ──▶ runGovernedToolCall(deps, toolCall)  ──▶ ResumeLedger.append(StepRecord)
       (執行身份/correlation)        (P2-I，未改寫)                 (append-only, content-hash keyed)
                            ▲                                              │
                            └──────────── crash-resume: fold(ledger) ◀─────┘
                               已 append 成功的 step → 視為 done → 不重跑 effect
```

- **Task**：一個 multi-step 工作單位的**狀態機**。狀態 = `pending | running | completed | failed | aborted`
  （借鑑 NemoClaw onboard FSM 的 `StepStatus` 詞彙 `pending|in_progress|complete|failed|skipped`，
  見 `/tmp/nemoclaw/src/lib/state/onboard-session.ts:40`；R5 取 Task 層的最小子集）。Task 持有一個**有序的
  step intent list** 與一個 **cursor**（下一個要跑的 step index）。狀態轉移是**純函式 + 顯式 guard**
  （deny-by-default：未知 event / 非法轉移 → 拒絕，不靜默吞）。
- **AgentSession**：執行這個 Task 的**身份 + correlation**（sessionId、actorId/tenantId/projectId、startedAt）。
  對映 P2-I `GovernedCall.context`（`src/orchestration/pipeline.ts:24-27`）與 `AuditEvent` 已有的
  `actorId/tenantId/projectId/taskId`（`src/audit/event.ts:32-45`）——**不新造平行身份**，只把既有 ids 綁成
  session 視角。借鑑 NemoClaw `Session`（`sessionId/status/mode/startedAt/updatedAt`，
  `/tmp/nemoclaw/src/lib/state/onboard-session.ts:79-123`）的欄位選型。
- **ResumeLedger**：Task 範圍的 **append-only** step 記錄序列。每筆 `StepRecord` 以 **content-hash** 為 key
  （見 §2.3）。ledger 是 orchestration 層的薄抽象（port），**第二實作 = in-memory fake**（contract test），
  真實實作後續接 WORM kernel（R2 真實 ingest 後）。借鑑 NemoClaw「storing the hash (not just the env-name)」
  的 resume dedup 設計（`/tmp/nemoclaw/src/lib/state/onboard-session.ts:105-116`）。

### 2.2 compose over P2-I（不重寫）

R5 **不改 `pipeline.ts`**。Task runner 是一個更上層的 driver：對 Task 的每個 step，組出該 step 的 `toolCall`，
呼叫**注入進來**的 `runGovernedToolCall`（P2-I），把回傳的 `GovernedOutcome`（`executed{reservationId,receipt}`
或 `denied{stage,reason}`，`src/orchestration/pipeline.ts:48-50`）轉成一筆 `StepRecord` append 進 ledger，
再依結果推進 / 終止 Task FSM。低耦合靠**依賴注入**（同 P2-I / commitgate / brain-guard 模式）：runner 只 import
有 barrel 的 orchestration 型別（`runGovernedToolCall`、`GovernedOutcome` from `../orchestration/index.js`），
ledger 與 clock 由 composition root 注入。

### 2.3 crash-idempotency 的機制（content-hash dedup；no duplicate external effect）

這是 R5 的**安全不變量核心**，必須命令可驗：

- **step identity = content hash。** 每個 step 的 `stepKey = hash(taskId ‖ stepIndex ‖ canonical(intent))`。
  用 SHA-256 over 一個**決定性 canonical-JSON** 求穩定序列化後雜湊，**確保同一 step 在重啟後算出同一 key**
  （決定性）。**注意（verified-from-code）**：`src/audit/canonical.ts` 的可重用序列化器 `canonicalJson` 目前是
  **module-private**，且公共面 `canonicalizeAuditEvent(event: AuditEvent)`/`contentAddress(event)` 只吃**完整
  `AuditEvent`** 並會 `redactSecrets`——故**不能**直接餵任意 `intent`。R5 採「**同律不同碼**」：在
  `orchestration/task/stepkey.ts` 內實作一個**最小、純函式**的決定性 canonical-JSON（key 遞迴排序、fail-closed
  拒非有限數/未定義，與 `canonical.ts` 同紀律），**不 cross-module deep-import** audit 內部（avoids
  `not-to-internal` 違規）。若日後要收斂為單一 canonicalizer，**另開一個「把 `canonicalJson` 升為 audit 公共面
  + 新增 `src/audit/index.ts` barrel」的依賴/契約 slice**（不與本 R5 行為 slice 混）。
- **append-before-effect 已由 P2-I 保證。** P2-I 的 commit-before-effect 先 append AuditEvent→拿 receipt 才跑
  effect（`src/orchestration/pipeline.ts:78-94`、`src/commitgate/guard.ts:57-74`）。R5 的 resume ledger **沿用
  同一時序**：一筆 StepRecord 只有在 P2-I 回 `executed`（即 audit receipt 已在手、effect 已跑）後才 append。
- **resume = fold(ledger) → skip 已完成 step。** 重啟時 runner 先 fold 該 Task 的 ledger：對每個 step，
  若該 `stepKey` 已存在於 ledger（status=executed）→ **跳過、不再呼叫 `runGovernedToolCall`、不再跑 effect**，
  直接用 ledger 裡的既有 outcome 推進 cursor。**deny-by-default**：ledger 讀取失敗 / 記錄損毀 / hash 不一致
  → fail-closed（Task→failed），**絕不**「不確定就重跑」（重跑會重複 effect）。
  **（S4 已落地）** `resumeTask(deps, task)`（`src/orchestration/task/runner.ts`）即此入口：fold-before-run
  先用 `ledger.has(stepKey)` + `ledger.list(taskId)` 對每個 step 判定是否已 `executed`，是→跳過並回報於
  `skipped`、用既有 record 推進 FSM；遇第一個未完成 step 即交回**與 S3 完全相同**的 `driveRunningTask` 續跑。
  fail-closed 三條皆已測（`resume.test.ts`）：①`has`/`list` throw、②記錄 `stepKey` 與重算 key 不一致（損毀/竄改）、
  ③ ledger 有此 step 但 outcome=`denied`（denied 不當 done、不續跑）→ 一律 Task→failed 且 effect spy 不增加。
  double-resume 對已完成 ledger 重入仍 0 次新 effect。
- **為何不會重複 effect**：唯一會觸發 effect 的路徑是 `runGovernedToolCall`，而 runner 只在「ledger 裡沒有此
  stepKey 的 executed 記錄」時才呼叫它。crash 發生在 effect 之後、append StepRecord 之前的**窄窗**，由 P2-I 的
  AuditEvent（已在 WORM、key=taskId）作為**權威真相**回填——resume 先 reconcile WORM 再 fold ledger（見 §4 風險）。

---

## 3. 重用 vs 新增（reused vs new；honest capability gates）

### 重用（既有 port / fake / kernel，**不重造**）
| 重用項 | 來源（verified-from-code） | R5 如何用 |
|---|---|---|
| `runGovernedToolCall` / `GovernedOutcome` | `src/orchestration/pipeline.ts:48,53` | Task runner 對每個 step 呼叫它；**不改寫** |
| `commitBeforeEffect` 時序保證 | `src/commitgate/guard.ts:57-74` | StepRecord 只在 executed（receipt 在手）後 append；resume 時序的根 |
| `AuditEvent`（已含 `taskId`/`actorId`/`tenantId`/`projectId`） | `src/audit/event.ts:32-45` | AgentSession 身份直接對映；WORM 已 key by taskId，resume 權威真相 |
| 決定性序列化**紀律**（非直接 import） | `src/audit/canonical.ts:18-62`（`canonicalJson` 為 module-private；公共面只吃 `AuditEvent` 且 redact） | R5 **不直接 import**，而在 `stepkey.ts` 內以同律最小重寫求 `stepKey`（見 §2.3） |
| iam/ids（branded `TaskId/TenantId/...`） | `src/iam/ids.ts:18-22`（P2 已用；deps-cruiser interim 允許直 import `src/iam/ids.ts`） | AgentSession / StepRecord 的 id 型別，不新造；import path = `../../iam/ids.js`（非 `iam/index.js`，後者尚未存在） |
| zod `.strict()` schema 慣例 | `src/audit/event.ts:32`（既有 pattern） | Task/AgentSession/StepRecord schema 用 `.strict()` deny-by-default |

### 新增（R5 範圍）
- `src/orchestration/task/fsm.ts` — Task 狀態機（純函式轉移 + guard，deny-by-default）。
- `src/orchestration/task/session.ts` — AgentSession + Task/StepRecord schema（zod `.strict()`）。
- `src/orchestration/task/ledger.ts` — ResumeLedger port + in-memory fake（≥2 impl 的 fake 側）。
- `src/orchestration/task/runner.ts` — compose over P2-I：driver Task→step→`runGovernedToolCall`→ledger→FSM。
- 對應 `*.test.ts` + barrel 出口（`src/orchestration/index.ts` 一行）。

### 誠實能力閘（honest capability gates）
1. **WASM 不需要、XState 暫不引入。** INDEX R5 行寫「XState Task FSM」，但 XState 是新第三方依賴；依
   `slice-spec.md §3`「新增第三方依賴=0；若必要則單獨成一個 slice」，R5 **先以零依賴的純函式 FSM 落地**
   （狀態少、轉移顯式、更易對抗式 review）。若後續證明需要 XState 的 actor/parallel 能力，**另開一個獨立
   依賴 slice**——不與本 R5 行為 slice 混。**（inferred 設計取捨，非 INDEX 強制）**
2. **真實 WORM-backed ledger 不在 R5。** R5 的 ResumeLedger 真實實作（append 進 Go kernel）**depends-on R2**
   （TS→Go 真實 ingest client）。R5 只交 **port + in-memory fake**，crash-resume 用 fake 證明，
   留 WORM-backed 實作給 R2 之後的 slice。**（gate：R5 不超前 R2 的 kernel 依賴，符合 `slice-spec.md §2`）**
3. **真實 crash 不可在單元測試觸發。** crash-resume 用「**模擬 process 邊界**」測：在「effect 之後、append 之前」
   或「append 之後」切斷，重建一個 fresh runner + 同一 ledger，斷言 effect spy 的呼叫次數**不增加**。
   真實 OS-level crash 留給後續整合/assurance（Tier 3）。**（verified 能力邊界）**
4. **approval / 人類在環不在 R5。** Task 的 `paused-awaiting-approval` 狀態留給 R7 ApprovalInbox slice；
   R5 FSM 只含 `pending|running|completed|failed|aborted`。**（scope gate，避免蔓延）**

---

## 4. 取捨與風險（trade-offs + risks）

- **content-hash dedup 的決定性風險**：若 `toolCall` 含非決定性欄位（時間戳、隨機 nonce），同一 step 重啟後
  會算出不同 hash → 誤判為新 step → **重複 effect**。緩解：`stepKey` 只 hash **step intent 的決定性部分**
  （taskId+stepIndex+canonical(intent)），把非決定性執行時資料排除在 key 之外；canonicalize 已是 OCSF 對映的
  穩定序列化。對抗式 RED 必含「同 intent 重啟 → 同 stepKey → 不重跑」。
- **窄窗（effect 已跑、StepRecord 未 append）**：P2-I 的 AuditEvent 已在 WORM（先於 effect）。resume 先
  reconcile WORM（key=taskId 的 tool-invocation events）再 fold ledger；ledger 缺一筆但 WORM 有對應 receipt →
  視為已執行、回填 ledger、**不重跑**。**fail-closed**：WORM 與 ledger 衝突且無法判定 → Task→failed，不重跑。
- **append-only 的回退**：ledger 不可改寫（與 WORM kernel 同律，`slice-spec.md §7`）。回退靠 forward-correcting
  event（如 `Task aborted`），不改歷史。
- **低耦合代價**：runner 透過注入 `runGovernedToolCall` 而非 import 具體 deps，測試需在 composition root 接線
  P2-I 真實 fake——換來 orchestration 不 deep-import、無 cycle、無 vendor（`deps:check` 可驗）。

---

## 5. Slice 分解（4 個小 slice；皆 ≤ size budget）

| Slice | 檔案 | Title | Net LOC（估） | Depends-on |
|---|---|---|---|---|
| **P2R-R5-S1** | [P2R-R5-S1-…](../slices/phase-2-remaining/P2R-R5-S1-task-agentsession-fsm-types.md) | Task FSM（純函式轉移 + guard）+ AgentSession/Task/StepRecord schema（zod `.strict()`） | ~220 | P2-I |
| **P2R-R5-S2** | [P2R-R5-S2-…](../slices/phase-2-remaining/P2R-R5-S2-resume-ledger-port-fake.md) | ResumeLedger port（append-only）+ in-memory fake + content-hash `stepKey` 決定性 + contract test | ~200 | R5-S1 |
| **P2R-R5-S3** | [P2R-R5-S3-…](../slices/phase-2-remaining/P2R-R5-S3-task-runner-compose-over-p2i.md) | Task runner：compose over P2-I `runGovernedToolCall`，step→ledger→FSM 推進（happy + 短路） | ~260 | R5-S1, R5-S2, P2-I |
| **P2R-R5-S4** | [P2R-R5-S4-…](../slices/phase-2-remaining/P2R-R5-S4-crash-resume-idempotency-test.md) | crash-resume idempotency：fold(ledger) skip 已完成 step，**effect 零重複**（對抗式 RED） | ~180 | R5-S3 |

### Slice DAG（無 cycle）
```
P2R-R5-S1 -> { P2-I }                          # FSM + schema；只用既有 orchestration/iam/audit barrel
P2R-R5-S2 -> { P2R-R5-S1 }                     # ledger port + fake + content-hash；用 S1 的 StepRecord schema
P2R-R5-S3 -> { P2R-R5-S1, P2R-R5-S2, P2-I }    # runner compose；注入 P2-I 的 runGovernedToolCall
P2R-R5-S4 -> { P2R-R5-S3 }                     # crash-resume：在 S3 runner 上加 fold + idempotency 對抗式測試
```
> 無 cycle 證明：rank = 0（P2-I 已 DONE）/ 1（S1）/ 2（S2）/ 3（S3）/ 4（S4）；每條邊嚴格遞減 ⇒ DAG。
> 排序紀律：**契約先於消費者**——S1 先出 Task/StepRecord schema 與 FSM，S2 才能定義以 StepRecord 為單位的
> ledger，S3 才能把 P2-I 結果寫成 StepRecord 推進 FSM，S4 才能在 runner 上證明 crash-idempotency。

---

## 6. grounding 引用（verified-from-code vs inferred）

**verified-from-code（已讀原始碼，附 file:line）：**
- P2-I pipeline 與 `GovernedOutcome`：`src/orchestration/pipeline.ts:24,48,53,78-94`。
- commit-before-effect 時序：`src/commitgate/guard.ts:57-74`、`src/commitgate/index.ts:5`。
- AuditEvent 已含 `taskId/actorId/tenantId/projectId`：`src/audit/event.ts:32-45`。
- NemoClaw onboard FSM `StepStatus`（pending|in_progress|complete|failed|skipped）：
  `/tmp/nemoclaw/src/lib/state/onboard-session.ts:40`（`STEP_STATES` :43-53）。
- NemoClaw `Session` 欄位選型（sessionId/status/mode/startedAt/updatedAt/version/resumable）：
  `/tmp/nemoclaw/src/lib/state/onboard-session.ts:79-137`。
- NemoClaw resume dedup「storing the hash (not just the env-name)」：
  `/tmp/nemoclaw/src/lib/state/onboard-session.ts:104-116`。
- NemoClaw resume-repair 決策分類（terminal/nonterminal snapshot → repair/keep）：
  `/tmp/nemoclaw/src/lib/onboard/resume-repair-policy.ts:6-44`。
- OpenShell `SandboxPhase` 生命週期 enum（effect 對象的狀態模型參照）：
  `/tmp/openshell/proto/openshell.proto:401-408`。

**inferred（設計判斷，非直接抄碼）：**
- 「先零依賴純函式 FSM、XState 留獨立 slice」——依 `slice-spec.md §3` 依賴隔離規則推導。
- `stepKey = hash(taskId‖stepIndex‖canonical(intent))` 的具體組成——綜合 P2-I/canonical 與 NemoClaw hash-dedup
  推導的決定性 key 設計。
- resume 先 reconcile WORM 再 fold ledger 的窄窗處置——依 P2-I append-before-effect 不變量推導。
