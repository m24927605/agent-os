# Adversarial Code Review — 每個 slice 的強制對抗式審查標準

> **狀態：BINDING（強制）。** 本文件規範 [AGENTS.md](../../AGENTS.md) **HARD CONSTRAINT B**（per-slice
> adversarial code review）。它與 [`slice-spec.md`](./slice-spec.md)（slice 的定義與切分紀律）互為一組：
> slice-spec 說「一個 slice 長什麼樣」，本文件說「一個 slice 如何被 BREAK 過才准 merge」。
>
> 上層契約：AGENTS.md §「Looping Engineering」#9 與 §「Definition of Done」最後兩條。本文件**不放寬**任何
> 上層不變量；它只是把「對抗式審查」這一步寫成可被指令驗證、可被稽核的具體程序。語言：繁體中文，保留英文技術術語。

---

## 0. TL;DR（一頁讀完）

- **沒有 PASS verdict 就不 merge。** 自審（self-review）**永遠不算數**。Reviewer 必須是 fresh-context、
  與作者不同身分的獨立角色，其職責是 **BREAK 這個 slice**，不是確認它能動。
- **Reviewer 的預設立場是 refute-by-default（駁回優先）：** 在他親手跑出的指令輸出證明 slice 守住每一條
  不變量之前，verdict 預設為 **FAIL**。「看起來對」不是證據。
- **只信指令輸出（only command output is truth）：** Reviewer **必須親自重跑** `pnpm run verify` 與
  dependency-boundary check，並把真實 exit code / 輸出貼進 verdict。作者自述「我跑過了」一律不採信。
- **八個攻擊面，逐一試破：** deny-by-default bypass、fail-closed、credential leak（6 個 sink）、
  cross-tenant crossing、audit gap/tamper、idempotency（resume）、**low coupling / high cohesion**
  （illegal/cyclic deps、concern leakage、deep imports）、以及 slice 自身宣稱的行為。
- **結構化 verdict：** 採用 §4 的固定格式（含每個攻擊面的 probe + 該 probe 的真實指令輸出 + 結論）。
- **MERGE GATE：** verdict = **PASS** 且 §5 的 checklist 全綠，才可 merge。任何 FAIL/BLOCKER → 作者修 →
  **重新對抗式審查**（不是補審，是 re-review），直到 PASS。
- **與其他 gate 的關係：** 對抗式審查是 **per-slice**、merge 前的閘；Independent Verifier Pass 是
  **per-task**、done 前的閘；Codex Review Gate 是 **per-stage**（spec/plan/task/final）的閘。三者疊加、
  互不取代（§6）。

---

## 1. 為什麼需要它（與本架構的綁定）

Agent OS 的 moat 不是隔離，而是「從 agent 信任邊界**之外**、在動作路徑**之內**產生、且第三方可獨立驗證的證據」
（見 [architecture-approach.md](../research/architecture-approach.md) §1）。這意味著正確性是 adversarial 的：
我們的對手不是「打字打錯的同事」，而是「會主動找 deny-by-default 縫隙、會試圖讓 credential 漏進 log、會試圖
跨租戶讀取、會試圖讓 side effect 發生但 audit 不落地的 untrusted agent」。

對抗式審查把這種威脅模型搬進**開發流程本身**：每個 slice 在 merge 前，都先讓一個「假裝是攻擊者的審查者」打過一遍。
這跟 AGENTS.md「assume the agent process is untrusted」是同一個哲學，只是套用在 reviewer 身上——reviewer
**假裝程式碼是 untrusted 的**，要證明它擋不住攻擊。

它同時是 **HARD CONSTRAINT A（low coupling / high cohesion）的執法現場之一**：耦合/內聚不是只靠
dependency-boundary check 這條自動化指令把關，它也是對抗式審查的一個**阻斷性維度**（blocking dimension）——
即使自動化檢查放行，reviewer 仍須主動找「概念越界、deep import、責任膨脹」這類工具難以全捕捉的設計腐化。

---

## 2. 角色與獨立性（fresh context 的硬性定義）

| 角色 | 是誰 | 必要條件 |
|---|---|---|
| **Author（作者）** | 寫這個 slice 的 agent / 工程師 | 提交 slice + 自證材料（§3.1）。**不得**自任 reviewer。 |
| **Adversarial Reviewer（對抗式審查者）** | 另一個 agent session 或另一個人 | **Fresh context**（見下）；身分與作者不同；職責是 BREAK，不是 bless。 |

**Fresh context 的硬性定義**（三者皆須滿足，否則該審查無效，merge gate 視為未通過）：

1. **不共享作者的對話/記憶體：** Reviewer 不得在「寫這個 slice 的同一個 session/上下文」裡做審查。必須是
   新開的 session，或不同的人。理由：同一上下文會繼承作者的盲點與「這樣寫應該沒問題」的合理化。
2. **只看交付物，不看作者的辯解：** Reviewer 的輸入是 diff + slice spec + 對外契約（proto/Zod/`index.*`），
   **不是**作者「我本來想……」的口述。Reviewer 從交付物本身推導 slice 該守的不變量。
3. **不同身分跑指令：** Reviewer 親手跑 §0 的指令（在乾淨 checkout 上），不接受作者貼來的輸出截圖/log。
   呼應 architecture-approach.md「被審計者結構上無法改寫 audit」——審查的真相來源不能由被審查者提供。

> **退化保護：** 若環境只有單一 agent（例如 Personal 模式下的單人開發），「fresh context」以**新 session +
> 清空相關上下文 + 在 clean worktree 重跑指令**達成；並建議疊加 `/codex` challenge 模式（見 §6.3）作為第二個
> 獨立意見。**單一 session 內的自審永遠不滿足本標準。**

---

## 3. 程序（Author → Reviewer → Gate）

### 3.1 Author 提交包（submission packet）

Author 在請求審查時，必須附上以下、且僅以下交付物（reviewer 不看其他口述）：

- **Slice diff**：對應一個符合 [`slice-spec.md`](./slice-spec.md) 的、小而可獨立驗證的變更。
- **Slice spec 連結**：這個 slice 宣稱要交付什麼行為、屬於 11 層中的哪一層、其 public surface 是什麼。
- **RED→GREEN 證據**：先寫的 failing test（RED）與其現在 green 的證據（呼應 TDD；見 §3.3 commands）。
- **本地 verify 結果**：`pnpm run verify` 的 exit code（**僅作參考；reviewer 必重跑，不採信此值**）。

> Author **不得**附「請放行」「這個 edge case 不重要」之類的辯解。Reviewer 預設 refute；辯解不改變預設。

### 3.2 Reviewer 的任務循環（capped loop）

Reviewer 執行一個 **capped loop**（cap 是安全控制，呼應 AGENTS.md「no unbounded loops」）：

1. 在 **clean checkout / worktree** 取得 slice。
2. 親手跑 §3.3 的**必跑指令**，把真實輸出留存。
3. 對 §4 的**八個攻擊面**逐一設計 probe，嘗試 BREAK（refute-by-default）。
4. 填寫 §4 的結構化 verdict（每個攻擊面要嘛附「試破指令 + 輸出 + 仍守住」的證據，要嘛標 FAIL 並附 repro）。
5. 給出最終 verdict：**PASS / FAIL**。

- **Cap：審查迭代上限 = 3。** 若 reviewer 在 3 輪內無法判定（例如環境壞掉、無法重跑指令），**停止並標記
  `BLOCKED`**（視同未通過、不得 merge），升級給人處理。不得「跑不出來就當它過」（那是 fail-open，違反全域
  fail-closed 原則）。
- Reviewer **找到的第一個 BLOCKER 不必然停手**：鼓勵在一輪內盡量列齊所有問題，減少 author 的 round-trip；
  但任何一個未解的 BLOCKER 都使 verdict = FAIL。

### 3.3 Reviewer 必跑指令（only command output is truth）

Reviewer **必須親自**在 clean checkout 上跑這些指令，並把**真實輸出**貼進 verdict。缺任何一條 = 審查無效。

```bash
# 1) 通用閘：typecheck && lint && build && test && secret-scan（單一真相來源）
pnpm run verify
echo "verify exit: $?"          # 必須為 0

# 2) 依賴邊界檢查（HARD CONSTRAINT A 的自動化執法；見 §4.7）
#    具體工具：TS = dependency-cruiser / eslint-plugin-boundaries（檢測 cyclic / illegal / deep import）；
#    Python SDK = import-linter；Go evidence kernel = depguard + internal/ package 邊界。
#    本檢查 MUST 被 wire 進 `pnpm run verify`（見 §7 與 architecture-approach.md Phase 0）。
#    在它尚未被併入 verify 之前，reviewer 仍須**獨立**執行對應指令並貼輸出，例如：
pnpm run depcheck                # 或 npx depcruise --config .dependency-cruiser.cjs src
echo "depcheck exit: $?"        # 必須為 0（無 cyclic / 無 illegal cross-module / 無 deep import）

# 3) 針對性重跑 slice 宣稱覆蓋的測試（確認 RED→GREEN 真實存在、且現在 green）
pnpm test -- <slice 相關測試路徑>
echo "targeted test exit: $?"   # 必須為 0

# 4) RED 重現程序（command-verifiable；不接受「相信 reviewer 會手動還原」的口述）
#    把實作還原（stash 對應 hunk 或 revert 對應 commit），重跑該 slice 的測試，
#    必須 exit≠0（證明測試真的在斷言該行為，而非 always-green）；再 restore 後 exit 0。
git stash push -- <slice 實作檔路徑>        # 或 git revert --no-commit <impl-commit>
pnpm test -- <slice 相關測試路徑> ; echo "RED 重現 exit: $?"   # 必須 != 0（紅）
git stash pop                                # 或還原 revert
pnpm test -- <slice 相關測試路徑> ; echo "GREEN 還原 exit: $?" # 必須 == 0（綠）
```

> **§4.8 的 HELD 證據要求：** 上述第 4 步的「RED 輸出尾段（exit≠0）」與「GREEN 還原輸出尾段（exit 0）」
> **兩段都必須貼進 verdict**。若 reviewer 未執行或未貼出此兩段，§4.8（claimed behavior / RED→GREEN 真實性）
> **只能標 `N/A`（並附結構性理由），不得標 `HELD`**——因為「RED→GREEN 為真」此時尚無 command output 佐證。

> 若 `depcheck`/`depcruise` 尚未存在於本 repo（**現況確實如此**），reviewer **不得**因此跳過第 4.7 維度——
> 他必須改以人工追溯 import graph（並貼出追溯指令與結論），且在 verdict 把「依賴邊界檢查工具缺席」標為一個
> **MAJOR-with-tracking**（帶 owner 的 release-blocking 追蹤項，**非硬 BLOCKER**；理由見 §5）——這本身就是
> HARD CONSTRAINT A 的系統性執法缺口，由 §7 路線圖的 `SLICE-P0-003` 收口。**只要 reviewer 已親跑等效指令並
> 貼輸出，本 slice 不因「工具尚未自動化」而被擋 merge；但缺口追蹤項在 `SLICE-P0-003` merge 前持續存在。**

---

## 4. 八個攻擊面 + 結構化 verdict 格式

Reviewer 對下列每一面**逐一**填寫。每一面的判定只有兩種合法結尾：**(a)** 附上「我用這條指令試破、輸出證明它仍
守住」的證據而判 `HELD`；或 **(b)** 附上 repro（指令 + 觀察到的破口）而判 `BROKEN`。**不准**只寫「看起來沒問題」。

> 攻擊面是否適用視 slice 觸碰的層而定。若某攻擊面對本 slice **不適用**（例如純 UI 文案 slice 不碰 credential），
> reviewer 須明確標 `N/A` 並用一句話說明為何結構上不可能觸及該風險——**不可留白**。留白視為未審。
>
> **核心安全四面的 `N/A` 反濫用規則（防 N/A 成為逃逸口）：** 對 **1. deny-by-default、2. fail-closed、
> 3. credential leak（6 sinks）、5. audit gap/tamper** 這四個核心安全不變量，標 `N/A` 的門檻**更高**：
> reviewer 的結構性理由**必須引用該 slice 所屬的 11 層中的哪一層**，並說明**該層在架構上結構性不可觸及**
> 對應的能力/sink/路徑（例如「本 slice 只在 `domain` 層新增純值物件，結構上不持有 credential、不產生
> sandbox 副作用、不寫 audit sink」）。**純『本 slice 沒碰到』不足以構成 `N/A`**——那只是「作者沒注意到」
> 的合理化，視同留白＝未審，reviewer 須改以 `HELD`（附試破指令）或 `BROKEN`（附 repro）作結。

### Verdict 模板（複製填寫）

```
# Adversarial Review Verdict — slice: <slice-id / 標題>
Reviewer: <身分，須 != author>      Context: FRESH (新 session / 清空上下文)
Checkout: <commit SHA on clean worktree>

## Commands re-run by reviewer (only command output is truth)
- pnpm run verify            -> exit <0/非0>   <貼關鍵輸出尾段>
- deps（depcruise / 工具缺席時 per-language 等效指令）-> exit <0/非0>  <貼輸出尾段+缺席則貼追蹤項>
- pnpm test -- <paths>       -> exit <0/非0>   <貼關鍵輸出尾段>
- RED 重現（§3.3 第4步）：RED -> exit <非0>   GREEN 還原 -> exit <0>   <貼兩段尾段>

## Attack surfaces  (HELD / BROKEN / N/A) — refute-by-default
1. Deny-by-default bypass ....... [HELD|BROKEN|N/A]  probe: <指令/輸入>  evidence: <輸出>
2. Fail-closed .................. [HELD|BROKEN|N/A]  probe: <…>          evidence: <…>
3. Credential leak (6 sinks) .... [HELD|BROKEN|N/A]  probe: <…>          evidence: <…>
4. Cross-tenant crossing ........ [HELD|BROKEN|N/A]  probe: <…>          evidence: <…>
5. Audit gap / tamper ........... [HELD|BROKEN|N/A]  probe: <…>          evidence: <…>
6. Idempotency / resume ......... [HELD|BROKEN|N/A]  probe: <…>          evidence: <…>
7. Low coupling / high cohesion . [HELD|BROKEN|N/A]  probe: <…>          evidence: <…>
8. Claimed behavior (spec) ...... [HELD|BROKEN|N/A]  probe: <…>          evidence: <…>

## Findings  (每筆: severity = BLOCKER|MAJOR|MINOR ; 附 repro)
- [BLOCKER] <一句問題> | repro: <指令/輸入> | observed: <輸出> | invariant: <被破壞的不變量>
- ...

## VERDICT: PASS | FAIL | BLOCKED
（PASS 僅當：上列必跑指令皆能跑出且 exit 0、RED 重現兩段成立、八面皆 HELD 或 N/A（核心安全四面的 N/A 滿足
反濫用規則）、且無任何未解 BLOCKER/MAJOR finding（工具缺席的 MAJOR-with-tracking 例外，見 §5）。
任一必跑指令**無法跑出 exit code** → 一律 BLOCKED，不得 PASS。）
```

下面逐一給出每個攻擊面的「該怎麼試破」與「HELD 的證據長相」。

### 4.1 Deny-by-default bypass
- **試破角度：** 餵入 slice 沒列在 allow rule 的 action/resource、未知能力、空 rule set、只含萬用字元的
  pattern（`*`/`**`），確認結果是 `deny`。試 `matchResource` 的繞過（例如 `../` 路徑逃逸、URL 編碼、
  大小寫、結尾斜線）。
- **HELD 證據：** 一條測試或 REPL 輸出顯示未知請求 → `effect: "deny"` 且 `auditRequired: true`，且
  reason 只含欄位名/靜態字串（不回放請求值）。對照種子實作 `src/policy/evaluate.ts`：萬用字元-only pattern
  被拒、無 match → deny。
- **BROKEN 範例：** 任何「未知 → allow」、「萬用字元放行過寬」、「新增 capability 預設 allow」。

### 4.2 Fail-closed
- **試破角度：** 餵 malformed input、缺 context、null/undefined、超大/畸形 payload、讓內部拋例外（mock 依賴
  丟錯），確認結果是 **deny / 拒絕 / 安全降級**，**不是** allow，也不是 crash 後被上層當成成功。
- **HELD 證據：** `evaluatePolicy(garbage, rules)` → `deny("malformed … fail-closed")`；error path 走
  `catch → deny`（見 `src/policy/evaluate.ts`）；`createAuditEvent` 缺欄位 → throw（不產生 partial event，
  見 `src/audit/event.ts`）。
- **BROKEN 範例：** 例外被吞掉後回 allow；try/catch 把錯誤吞成「成功但沒做事」；schema 用 `model_construct`
  類快路徑繞過 runtime 驗證。

### 4.3 Credential leak — 6 個 sink（逐一檢查）
- **6 個 sink（AGENTS.md 明列）：** ① workspace 檔案 ② logs ③ artifacts ④ snapshots ⑤ traces ⑥ test
  fixtures。**外加** audit payload（architecture-approach.md：raw secret 絕不進 persistence/audit）。
- **試破角度：** 在 slice 路徑放一個 canary secret，跑 slice，然後搜尋上述每一個 sink 是否出現該值或其衍生
  （base64/URL-encoded/前綴）。檢查錯誤訊息、reason 字串、序列化輸出是否回放了 secret。確認 secret 只以
  lease metadata + reference 流動（不以明文持久化）。
- **HELD 證據：** `pnpm run secret-scan` 輸出 `secret-scan: clean`（注意：該掃描**只印 `file:line`、絕不印
  值**，本身不能成為 leak 源）；加上 reviewer 自設 canary 後在 6 個 sink grep 皆 0 命中。
- **BROKEN 範例：** error/log 含 token；audit `reason` 回放了請求中的 secret；fixture 內嵌真 key；
  redaction filter 對某 sink 失效。

### 4.4 Cross-tenant crossing
- **試破角度：** 以 tenant A 的 context 嘗試讀/寫 tenant B 的 task/credential/log/sandbox/policy/artifact。
  試 missing/forged `tenantId`、tenant 邊界的 off-by-one、共用 cache/單例洩漏鄰租資料。確認隔離是
  **by construction**（gateway/DB-per-tenant、per-tenant 簽章金鑰），不是一個容易漏掉的 `if (caller.tenant
  === row.tenant)`。
- **HELD 證據：** 一條 conformance 測試顯示 A→B 存取被 deny 且 audited；branded `TenantId`
  （`src/iam/ids.ts`）在型別層阻擋誤用、且**搭配 runtime 驗證**（型別不是 runtime 邊界）。
- **BROKEN 範例：** 任何 `tenant_id` row-filter 取代結構隔離；shared singleton 跨租洩漏；per-tenant key
  退化成 shared key。

### 4.5 Audit gap / tamper
- **試破角度：** 製造「side effect 發生但事件沒落地」的窗口（在 commit-before-effect 之前殺進程）。試送
  欄位不全的事件、試讓 sequence 出現 gap、試「重寫/刪除已寫入事件」。確認 evidence kernel 路徑是
  append-only、hash-chained、monotonic-sequence + gap detection，且 control plane **無改寫權**。
- **HELD 證據：** 每個 privileged action 皆 emit 完整 `AuditEvent`（actor/tenant/project/task/sandbox?/
  action/resource/policy_decision/timestamp/request_id/result，見 `src/audit/event.ts`）；
  synchronous-commit-before-effect 有測試覆蓋；篡改/亂序被 verifier 偵測。
- **BROKEN 範例：** 先放行 side effect 再寫 audit（毀證窗口）；partial event 被接受；可從 control plane
  改寫歷史；缺 `request_id`/`tenant_id` 等必填欄位。

### 4.6 Idempotency / resume
- **試破角度：** 中斷後重放同一 task/操作，確認外部 side effect **不重複**、audit history 不遺失、lease 不被
  重複鑄造。試重送相同 request_id、模擬 crash-then-resume。
- **HELD 證據：** resume ledger / CAS optimistic concurrency 使重放為 no-op 或安全合併；測試顯示「resume
  不產生第二次外部寫入」。
- **BROKEN 範例：** resume 觸發第二次扣款/送信/credential 鑄造；audit 在 resume 後出現重複或斷裂。

### 4.7 Low coupling / high cohesion（HARD CONSTRAINT A — 阻斷性維度）
- **試破角度（自動化 + 人工雙軌）：**
  - **自動化：** 跑 §3.3 的 dependency-boundary check。確認**無 cyclic dependency**、**無 illegal
    cross-module dep**（例如 adapter 反向被 domain 依賴、跨 plane 直連對方 internals）、**無 deep import**
    （越過某模組 `index.*` / 宣告介面去 import 它的內部檔案）。
  - **人工：** 工具抓不全的設計腐化要靠 reviewer 主動找：
    - **Concern leakage（概念越界）：** policy 邏輯漏進 adapter？credential 處理漏進 UI？audit 形狀漏進
      orchestration？跨 11 層（CLI/UI · orchestration · approval · tool registry · policy · credential ·
      sandbox adapter · inference · audit · persistence · tenant/IAM）是否有責任串味。
    - **Cohesion 退化：** 這個 module 是否被塞了第二個責任（god module）？函式是否做了與其名稱無關的事？
    - **跨 plane 契約純度：** TS control plane / Go kernel / Python SDK / UI 之間是否只透過 typed
      contract（proto / Zod）溝通，而非互讀 internals？
    - **依賴方向：** 是否維持 inward-pointing（domain ← application ← adapters）？有沒有 adapter 細節
      （OpenShell proto 形狀、DB schema）洩進 domain？
- **HELD 證據：** dependency check exit 0 的輸出 + reviewer 一句結論「責任單一、僅經 public surface 使用、
  依賴無環且向內」。
- **BROKEN 範例：** 任何 cyclic dep；`import '.../other-module/src/internal/foo'`；policy 決策在
  adapter 內被硬編；一個 PR 把兩個不相干責任塞進同一 module。
- **執法力度：** 本維度與其他七面**同級**——一個未解的耦合/內聚 BLOCKER 同樣使 verdict = FAIL。AGENTS.md
  明訂「coupling/cohesion 是對抗式審查的 explicit, blocking dimension」。

### 4.8 Claimed behavior（slice spec 對齊）
- **試破角度：** slice spec 宣稱「做 X」。Reviewer 試「X 的 edge case / 反例 / 邊界值」確認真的做到 X，且
  **沒有偷做 spec 沒宣稱的事**（scope creep 也是一種 finding）。確認 RED→GREEN 真實存在：把實作還原，對應
  測試應該 RED。
- **HELD 證據（須貼兩段指令輸出）：** spec 列的行為皆有對應 green 測試；並依 §3.3 第 4 步**貼出**「還原
  實作後測試 RED（exit≠0）」與「還原回去後 GREEN（exit 0）」兩段輸出尾段，證明測試真的在測這件事、不是
  always-green。**缺這兩段輸出 → 本面只能標 `N/A`，不得標 `HELD`。**
- **BROKEN 範例：** 測試恆綠（沒斷言或斷言永真）；實作做了 spec 外的事；宣稱的行為其實沒被測。

---

## 5. MERGE GATE（沒有 PASS 不准 merge）

一個 slice **僅當**下列全部成立才可 merge：

- [ ] Reviewer 是 **fresh-context 且 != author**（§2 三條件全滿足）。
- [ ] Reviewer **親自重跑**且 **`pnpm run verify` exit 0**（reviewer 貼的真實輸出，不是 author 的）。
- [ ] **依賴邊界檢查通過**（HARD CONSTRAINT A）：
      - **工具已 wired 進 verify 時：** reviewer 親自重跑 `pnpm run deps:check`（depcruise）exit 0。
      - **工具尚未 wired 進 verify 時（現況；已核實 repo 無 depcheck/dependency-cruiser）：** reviewer
        **親跑 per-language 等效指令**（TS：`npx depcruise --config .dependency-cruiser.cjs src` 或人工追溯
        import graph；Python：`lint-imports`；Go：`go vet` + depguard）**並貼出輸出與結論**；且把「尚未 wire
        depcheck into verify」登記為一個**帶 owner 的 release-blocking 追蹤項**（severity = **MAJOR-with-tracking**，
        **非 BLOCKER**）。此追蹤項在 §7 的 Phase 0 待辦中歸零前持續存在，但**不**阻擋個別 slice merge——
        前提是 reviewer 已親跑等效指令並貼輸出。
- [ ] §4 八個攻擊面**皆 `HELD` 或 `N/A`**（每個 `N/A` 附結構性理由，且核心安全四面的 `N/A` 須滿足 §4 的
      反濫用規則），**無任何 `BROKEN`**。
- [ ] **無未解的 `BLOCKER` 或 `MAJOR` finding。**（`MINOR`，以及上一條的 **MAJOR-with-tracking**（工具缺席）
      可附帶 owner 的追蹤項放行，由 reviewer 裁量；其餘 `MAJOR` 不可帶傷 merge。）
- [ ] **若任一必跑指令無法產生 exit code（環境/工具故障、無法在 clean checkout 重跑）：verdict 一律 =
      `BLOCKED`（視同未過、不得 merge），且不得勾選任何 PASS 條件**（與 §3.2 cap 規則的 fail-closed 對齊）。
- [ ] RED→GREEN 證據成立（TDD：先有 failing test，且依 §3.3 的 RED 重現程序由 reviewer 親自確認）。
- [ ] **VERDICT: PASS**。

> **為何工具缺席不是硬 BLOCKER（消除本文件內部死鎖）：** 已核實 repo 目前無 `deps`/`dependency-cruiser`
> 設定。若把「工具缺席」一律標為硬 BLOCKER，則依「無未解 BLOCKER 才可 merge」這條，**每個 slice 都會帶一個
> 未修 BLOCKER → 整條 pipeline 鎖死**（含 `SLICE-P0-003` 這個「負責把工具接上」的 slice 本身也無法 merge）。
> 因此本標準採 **MAJOR-with-tracking**：reviewer 仍須親跑等效指令證明這個 slice 守住低耦合（不放過 HARD-A
> 的逐 slice 把關），但「工具尚未自動化」這個**系統性缺口**以帶 owner 的 release-blocking 追蹤項管理，由
> `SLICE-P0-003` 收口。`SLICE-P0-003` merge 後，本條退化為「`pnpm run deps:check` exit 0」的硬性要求。

**未通過時：** Author 修 → **重新對抗式審查**（fresh context、重跑指令、重填 verdict）。這不是「補一句已修」，
是一次完整的 re-review——因為修補可能引入新破口。

**連續失敗保護（呼應「卡住 3 次重新評估」）：** 同一 slice 連續 **3 次** re-review 仍 FAIL → **停止逐點修補，
退一步重評 slice 邊界/設計**（很可能 slice 切太大或職責不清，違反 slice-spec / HARD CONSTRAINT A）。並依
AGENTS.md，若同一類 finding 出現兩次，先寫進 [`docs/guardrails.md`](../guardrails.md)（symptom → root cause
→ guardrail）再繼續。

**禁止事項（hard no）：** 不得為了讓 verdict 變 PASS 而：弱化/停用測試或安全檢查、`git commit --no-verify`、
放寬 deny-by-default、把 secret 寫進任何 sink、用 `//nolint` / `eslint-disable` 偷繞依賴邊界檢查。任何此類
行為使該 merge 無效並須回退。

---

## 6. 與其他 gate 的組合（互補、不互相取代）

三道閘各有不同的範圍、時機與「fresh context」對象，**疊加生效**：

| Gate | 範圍 | 時機 | 真相來源 | 本文件的關係 |
|---|---|---|---|---|
| **Adversarial Code Review**（本文件，HARD CONSTRAINT B） | **per-slice** | **merge 前** | reviewer 親跑 `pnpm run verify` + depcheck | 是它本身 |
| **Independent Verifier Pass**（AGENTS.md #7, dev-loops Tier 2） | **per-task**（多個 slice 合成的 task） | task「done」前 | 獨立者重跑 `pnpm run verify` + coverage，對抗式探 invariants | 同源精神、不同層級——見 §6.1 |
| **Codex Review Gate**（CLAUDE.md，`codex-review.sh`） | **per-stage**：spec / plan / task / final | 階段轉換 | `codex-review.sh <stage> <target>` 的 JSON `approved` | 第三方獨立意見——見 §6.2 |

### 6.1 與 Independent Verifier Pass
- **層級不同：** 對抗式審查鎖在**單一 slice 的 merge**（小、頻繁、merge gate）；Independent Verifier Pass
  鎖在**一個 task 的驗收**（task 由多個已 merge 的 slice 構成，done gate）。
- **不取代：** 通過 N 次 slice 對抗式審查**不豁免** task 級 Independent Verifier Pass——後者驗的是「合起來
  仍守住 invariants、且整體 verify + coverage 綠」，會抓到 slice 間的交互破口。
- **共用工具：** 兩者都「fresh context + 親跑 `pnpm run verify` + 對抗式探 deny-by-default / fail-closed /
  audit / credential」。把本文件 §4 的攻擊面當成 Independent Verifier Pass 的探測清單即可一致複用。

### 6.2 與 Codex Review Gate（stage gates）
- Codex gate 是**階段**級的第三方意見（spec/plan/task/final），由 `codex-review.sh` 產生 JSON verdict
  （`approved: true/false`），CLAUDE.md 規定每 stage `CODEX_REVIEW_ITERATION` 從 1 起、最多 5 次、連 3 次
  失敗轉全局策略。
- **組合方式：** slice 的對抗式審查在 **task stage 的 Codex gate 之前/之內**反覆發生（每併一個 slice 一次）；
  待該 task 的所有 slice 都 PASS 並 merge，才跑 task-stage Codex gate：
  ```bash
  BASELINE=$(git rev-parse HEAD)   # task 開始時固定
  CODEX_REVIEW_ITERATION=1 ~/.claude/hooks/codex-review.sh task "$BASELINE" --project-dir "$PWD"
  ```
- **不取代：** Codex `approved: true` **不**豁免任一 slice 的對抗式審查；反之亦然。三者皆綠才算數。

### 6.3 Personal 模式的退化路徑
單人/單 agent 環境下，用 `/codex` 的 **challenge 模式**作為「另一個對抗式意見」來補足獨立性，並以新 session +
clean worktree 重跑指令達成 fresh context（§2 退化保護）。仍須產出 §4 的結構化 verdict。

---

## 7. 可執行性與路線圖（讓本標準變成指令，而非口號）

本標準的多數要求**已經**可被現有指令驗證：

- `pnpm run verify`（= typecheck && lint && build && test && secret-scan）已存在，是 §3.3 第 1 條的真相來源。
- `pnpm run secret-scan`（`scripts/scan_secrets.sh`）已存在，是 §4.3 的真相來源，且設計上只印 `file:line`、
  不印值。
- `.githooks/pre-commit` 已在 commit 前強制 `pnpm run verify`，是 fail-closed 的事前防線。

**尚待補上以完全執法 HARD CONSTRAINT A（§3.3 第 2 條）：**

1. **把 dependency-boundary check 併入 `pnpm run verify`**（architecture-approach.md Phase 0 已列為待辦：
   「wire a dependency-boundary check into verify」）。建議具體工具：
   - **TS control plane / SDK / CLI / UI：** `dependency-cruiser`（`depcruise`，可檢 cyclic / orphan /
     forbidden cross-module / deep import）或 `eslint-plugin-boundaries`。新增 `package.json` script
     `depcheck`，並掛進 `verify`。
   - **Python agent shim：** `import-linter`（contracts: layered / forbidden / independence）。
   - **Go evidence kernel：** `depguard`（golangci-lint）+ `internal/` package 邊界（編譯器級強制）。
2. **在工具落地前**，§3.3 已規定 reviewer 須人工追溯 import graph，並把「工具缺席」標為 process BLOCKER——
   使這個缺口本身被看見、被追蹤，而不是被默許。

> 任何聲稱「本 slice 守住低耦合」的說法，在 dependency-boundary check（自動或人工）給出輸出之前，一律不採信
> （only command output is truth）。

---

## 8. 一句話總結

**每個 slice 都先被一個 fresh-context、refute-by-default 的審查者親手用真實指令試破過八個攻擊面（含
低耦合/高內聚），拿到結構化 PASS verdict，才准 merge——沒有指令輸出，就沒有「守住」；沒有 PASS，就沒有
merge。**
