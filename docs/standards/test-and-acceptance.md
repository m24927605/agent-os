# 測試策略與驗收標準（Test & Acceptance Standard）

> 本文件是 Agent OS 的**測試策略 + 驗收標準**，是 build playbook 的一部分。它**體現並強制**
> `AGENTS.md` 的 Looping Engineering 與兩條 hard constraint，並把每一條驗收準則寫成
> **command-verifiable**（可由指令的 exit code 證明）。保留英文技術術語。
>
> **狀態：Accepted。** 對任何 AI agent 與人類貢獻者皆 binding。與 `AGENTS.md` 衝突時 `AGENTS.md` 勝；
> 本文件只把 `AGENTS.md` 的測試/驗收條款具體化為可執行規則。
>
> 對照：`AGENTS.md`（§Looping Engineering、§Definition of Done、§Low coupling/high cohesion）、
> `docs/dev-loops.md`（四層 loop 體系）、`docs/research/architecture-approach.md`（Two-Plane Polyglot：
> TS control plane / Go evidence kernel / Python SDK / TS UI）、
> `docs/standards/slice-spec.md` 與 `docs/standards/adversarial-code-review.md`（slice 與對抗式評審；本文件引用之）。

---

## 0. 第一原則（不可違反）

1. **只信指令輸出（only command output is truth）。** 沒有任何「測試已過 / 已實作 / 安全」的宣稱被接受，
   除非有一條**真實指令**的 exit code 證明它。Agent 自述一律不算數。本文件每一節都提供 `bash` 區塊作為
   該條準則的**判定指令**——這些指令是契約，不是示意。
2. **單一通用 gate。** `pnpm run verify`（= `typecheck && lint && build && test && secret-scan`）是
   「它能不能運作」的**唯一真相來源**。任何測試/檢查最終都必須能被 `pnpm run verify` 的 exit code 收斂。
   跨語言（Go kernel、Python SDK）的 gate 以子指令掛入（§9），由 root `verify` 編排，使「一條指令 = 全綠」成立。
3. **Test-first TDD（RED 先行）。** 任何新行為，**先寫會失敗的測試（RED）**，再實作到綠（GREEN），再 refactor。
   實作不得先於其測試存在並失敗。本文件 §1 把 RED→GREEN→REFACTOR 寫成可稽核的指令序列。
4. **Deny-by-default + fail-closed 是被測對象，也是測試的預設立場。** 凡 unknown / malformed / 內部錯誤，
   期望值一律是 `deny` / `throw` / 非零 exit；任何「預期 allow」的測試都必須指向一條**明確的 allow rule**。
5. **Credentials NEVER。** 測試與 fixture **不得**包含真實 secret；secret-shaped 值只能以 §3.2 的 canary 機制
   出現，且 canary 必須被 redaction/secret-scan 攔下。任何把 secret 寫進 workspace/logs/artifacts/snapshots/
   traces/fixtures 的行為都是 critical failure，由 §3 的 6-sink 套件強制。
6. **Capped loops、無 unbounded loop。** 任何收斂 loop（含修綠 loop）必須宣告 iteration cap（見 `docs/dev-loops.md`）。
   測試本身**不得**含無界等待、無界 retry、或無 timeout 的 polling。

---

## 1. TDD：RED → GREEN → REFACTOR（可指令稽核）

TDD 是 `AGENTS.md` 的硬性方法論。本節把它降為**可由指令證明的三步**，套用於每一個 slice
（slice 定義見 `docs/standards/slice-spec.md`）。

### 1.1 三步契約

| 階段 | 規則 | 判定指令（exit code 即真相） |
|---|---|---|
| **RED** | 先提交（或暫存）一個**會失敗**的測試，描述目標行為。此刻實作尚不存在或不滿足。 | `pnpm vitest run <new-test-file>` **必須非零退出**（測試紅）。 |
| **GREEN** | 寫**最小**實作讓該測試通過，不破壞既有測試。 | `pnpm vitest run <new-test-file>` 退出 0；且 `pnpm test` 退出 0（未回歸）。 |
| **REFACTOR** | 在測試持續綠的前提下整理結構（降耦合、提高內聚）。 | `pnpm run verify` 退出 0（含 typecheck/lint/build/test/secret-scan + §8 boundary check）。 |

### 1.2 RED 必須真的紅（防「假測試」）

對抗式評審（§7）必須驗證 RED 是**因為斷言失敗**而紅，不是因為 import 錯誤、語法錯、或測試從未執行。
判定方式：在實作的 commit 上 `git stash` 掉實作、單獨跑新測試，確認它**因斷言失敗**而非零退出；
反向 mutation（暫時把實作改壞）後測試仍須轉紅。任何「拿掉實作測試仍綠」的測試 = 無效測試，評審 **REJECT**。

```bash
# RED 證據：在實作尚未存在/已被移除時，新測試必須失敗（而非 error/skip）。
pnpm vitest run src/<module>/<feature>.test.ts ; echo "exit=$?  (RED 期望 != 0)"
```

### 1.3 禁止為了綠而弱化

`AGENTS.md` 明令：**不得**停用/刪除/弱化測試或安全檢查來讓 loop 變綠，**不得** `--no-verify`。
所有 `it.skip` / `it.todo` / `describe.skip` / `// eslint-disable` / `// @ts-ignore` / `//nolint` 視為
**待審負債**，必須在 slice 的對抗式評審中逐一說明理由，否則 REJECT。CI 對這些標記做計數 gate（§9.4）。

---

## 2. 測試分類學（Test Taxonomy）

每個 slice 依其性質選取對應層級；**安全敏感 slice 至少要有 unit + adversarial + 對應的 §3 conformance**。

| 層級 | 問什麼 | 工具 | 放哪 | 何時必備 |
|---|---|---|---|---|
| **Unit** | 單一函式/模組的行為（含 fail-closed 邊界） | TS: `vitest`；Go: `go test`；Py: `pytest` | 與被測檔同目錄 `*.test.ts` / `*_test.go` / `test_*.py` | 一律必備 |
| **Contract** | 跨模組/跨平面的**公開契約**（proto / Zod schema）不漂移 | proto golden + Zod round-trip + buf breaking | `*/contract/` | 凡跨 plane 或暴露 public surface |
| **Property-based** | 對「所有輸入」成立的代數不變量（child⊆parent、budget 單調遞減、redaction 冪等） | `fast-check`（TS）/ `hypothesis`（Py）/ `testing/quick`（Go） | `*.prop.test.ts` | capability algebra（c20）、budget（c10）、redaction、序列化 |
| **Adversarial conformance** | 「攻擊者能不能破壞不變量」——release-blocking 安全套件 | vitest + 專屬 runner（見 §3） | `conformance/` | 每個 pillar；release gate |
| **Cross-plane integration** | TS ↔ Go ingest 完整性、TS ↔ OpenShell adapter | 進程級 integration harness | `integration/` | evidence kernel、OpenShell adapter |

**分類學的耦合紀律（hard constraint A）：** 測試只能透過被測模組的**public surface**（`index.*` / 宣告的介面 /
proto / Zod）耦合，**不得 deep-import 別的模組內部**來「方便斷言」。違反者由 §8 的 dependency-boundary check
在 `pnpm run verify` 內以非零 exit 攔下，且是對抗式評審的 blocking 維度。

---

## 3. Per-Pillar Release-Blocking Conformance Suites（核心）

這是把 `AGENTS.md` 的 8 個 custom security loop 與 7 大 pillar 落成**會擋發布**的測試套件。
每個套件都有一條**單一判定指令**，exit 0 才算過。套件以 vitest tag 標記，由 `pnpm run conformance` 聚合執行。

> **聚合判定指令（release gate；任一子套件非零即非零）：**
> ```bash
> pnpm run conformance   # = vitest run --dir conformance ；exit 0 才放行 release
> ```
> `conformance` 亦掛入 §9 的跨語言 release gate，使 Go/Python 子套件一併納入。
>
> **各套件的 gating phase 與「尚未到位」處置（誠實揭露，避免被當成現可跑）：** 本節多數 conformance 套件
> 針對的子系統（task orchestration / OpenShell adapter / sandbox lifecycle / gateway-per-tenant）**在現況
> scaffold 尚不存在**（`src/` 目前只有 policy / audit / iam）。因此每個套件標注其 **gating phase**，並套用與
> §8 相同的 **no-op-until-present / fail-closed-when-present** 規則：
> - **3.1 deny-by-default**：P0（被測對象 `src/policy/evaluate.ts` **已存在**）→ **現可跑**。
> - **3.2 credential non-leak（6 sinks）**：value-scanning 出口為 P0 `SLICE-P0-004`（RED-first）→ 該 slice 前為**預期紅**。
> - **3.3 tenant-isolation**：**P3**（gateway-per-tenant 落地）→ 在 tenant 子系統存在前 skip exit 0；存在卻無套件即 fail-closed。
> - **3.4 audit-completeness**：P0（`src/audit/event.ts` **已存在**）→ **現可跑**。
> - **3.5 idempotency/resume**：**P2**（orchestration / resume ledger 落地後）。
> - **3.6 sandbox-escape** 與 **3.7 managed-path**：**P2/P3**（OpenShell adapter / sandbox lifecycle 落地後）。
>
> 規則：套件對應子系統**不存在時 skip exit 0（明確標 PENDING，非偽綠）；存在卻缺對應套件時 fail-closed 非零**。
> fresh-context verifier 因此**不會**把「尚未到位的套件」誤判為通過、也不會誤判為無故失敗。每個套件隨其 gating
> phase 的首個 slice 以 RED-first 落地（不得後補）。

### 3.1 Deny-by-Default Conformance（Policy Deny-by-Default Loop）

**Goal：** 每一種能力對 unknown 請求一律 deny；malformed / 缺 context / 內部錯誤一律 fail closed 為 deny。

必涵蓋五種能力：**file / network / process / inference / credential**。對每種，至少各一條：
(a) unknown resource → `deny`；(b) malformed input（`unknown` 直接餵入）→ `deny`；(c) 只在有明確 allow rule 時
→ `allow`；(d) 純萬用字元 pattern（`*` / `**`）→ 視為過寬被拒（對照現有 `matchResource`）。

```bash
pnpm vitest run conformance/deny-by-default.conformance.test.ts
# 期望：5 能力 × {unknown, malformed, wildcard-too-broad} 全部 effect==="deny"；
#       唯一 allow 的 case 必須命中具名 rule。exit 0 才算過。
```

**Exit condition：** 所有 unknown / malformed 被 deny 且 `auditRequired===true`；無任何「silent allow」。

### 3.2 Credential Non-Leak Conformance — across ALL 6 sinks（Credential Non-Leak Loop）

**Goal：** credential 永不出現在 6 個 sink：**workspace files / logs / artifacts / snapshots / traces / test fixtures**。

> **現況（CURRENT；已核實 `src/audit/redact.ts`）——本套件的前提，不可被誤讀為「已成立」：**
> 現有 redactor **只依 key 名 redact**（`SECRET_KEY.test(key)` → `[REDACTED]`），**value-scanning 尚未
> 實作**（檔內自註：「Scanning string VALUES … is the full loop #3 follow-up」）。**因此：把 canary 值放進
> 一個非 secret-key 的 free-form 欄位（`action` / `message` / `resource` 字串），目前 redactor 不會把它
> scrub 成 `[REDACTED]`。** 本文件**不主張**現有 key-based redactor 已能滿足 6-sink 斷言。
>
> **落地方式（RED-first slice，非「對照既有測試」）：** value-scanning redaction 由
> `docs/standards/engineering-standards.md` §7.3 綁定的 **RED-first slice（`SLICE-P0-004`，F3）** 落地：
> **先寫一個會失敗的 canary 測試**（canary 放進 free-form 欄位 → 期望輸出 `[REDACTED]`，此刻**紅**，證明
> 目前是 convention 非 enforced）→ 實作 value-scanning redactor → 轉綠。在該 slice merge 前，6-sink
> conformance 套件**本身就是紅的**（這正是 test-first 要的狀態），不得宣稱已過。

**機制（canary，不是真 secret）：** 測試注入一個**已知的 canary sentinel 值**（明顯非真實憑證），讓它流經
各 sink 的**輸出路徑**，然後斷言該 canary **不出現**在任一 sink 的輸出，而 redaction 標記 `[REDACTED]`
出現。canary 值本身**只在記憶體中構造、不寫入任何 fixture 檔**。

> **canary 與第 6 sink（secret-scan）的共存機制（binding，消除自相矛盾）：** 若 canary 的字面值整段
> 出現在原始碼中，會被第 6 sink 的 `scan_secrets.sh` 高訊號 pattern 命中，使 sinks 1–5 測試與 sink 6
> 要求（secret-scan clean）互相矛盾。**本文件採行的 binding 機制 = 「runtime 組裝」：** canary 在測試執行時
> **由片段於記憶體拼裝**（例如 `["CANARY", "SECRET", uuid].join("-")`），使**完整 pattern 在靜止原始碼中
> 從不成形**，因此 `scan_secrets.sh` 不命中、第 6 sink 維持 clean，而 runtime 仍得到完整 canary 去測 sinks 1–5。
> （**替代**：在 `scan_secrets.sh` 加一條具名 allowlist 例外並於 `docs/guardrails.md` 說明理由——本文件**不
> 採用**此替代，以免在掃描器上開洞；除非 runtime 組裝不可行，否則一律用 runtime 組裝。）

| Sink | 斷言 | 判定點 |
|---|---|---|
| workspace files | 任何寫入 workspace 的內容經 redaction，canary 不落地 | 寫出路徑攔截器 + 讀回比對 |
| logs | 結構化 log 序列化後不含 canary | log serializer = `serializeAuditEvent` 路徑 |
| artifacts | Artifact payload 經 redaction | artifact writer |
| snapshots | sandbox snapshot metadata 不含 canary | snapshot serializer |
| traces | span / event 屬性經 redaction | trace exporter shim |
| test fixtures | repo 內**任何** fixture/source 不含真 secret-shaped 值 | `pnpm run secret-scan`（只印 `file:line`，不印值） |

```bash
pnpm vitest run conformance/credential-non-leak.conformance.test.ts   # 6 sinks 行為斷言
pnpm run secret-scan                                                   # 第 6 sink（fixtures/source）靜態掃描
# 期望：兩者皆 exit 0；canary 不出現於任一輸出；secret-scan 輸出只含 file:line。
```

**Exit condition：** 6 sink 全綠；secret-scan clean；輸出中找不到 canary 原值，只見 `[REDACTED]`。

> **強制：** 此套件**故意先 RED**——新增一個把 canary 寫進**某非 secret-key free-form 欄位**的測試，先確認
> 它**目前未被攔**（測試紅，因為現有 key-based redactor 不掃 value）→ 實作 value-scanning redactor → 綠。
> redaction 必須是 property-based 冪等：`redact(redact(x)) === redact(x)`（`*.prop.test.ts`）。
> **此 6-sink 套件的「綠」以 `SLICE-P0-004`（value-scanning）merge 為前提；在那之前它是預期的紅（RED-first）。**

### 3.3 Tenant-Isolation Conformance（Tenant Isolation Loop）

**Goal：** tenant A 在結構上**無法**讀寫 tenant B 的 task / credential / log / sandbox / policy / artifact。

架構是 **gateway-per-tenant + database-per-tenant**（非 `tenant_id` row filter），所以測試要證的是
「跨租請求被拒並 audited」而非「filter 寫對了」。對 6 種資源各一條 cross-tenant 嘗試：

```bash
pnpm vitest run conformance/tenant-isolation.conformance.test.ts
# 對 task/credential/log/sandbox/policy/artifact：tenant-A 持 A 的 context 嘗試取 B 的資源
# 期望：每一條 → deny + AuditEvent{result:"denied", tenantId: A 的}；無任何跨租成功路徑。
```

**Exit condition：** 所有 cross-tenant 嘗試被 deny 且各產生一條完整 AuditEvent；branded `TenantId`
（`src/iam/ids.ts`）使 A 的 id 不可被當作 B 使用。**此套件 release-blocking（c3 直接產品化此不變量）。**

### 3.4 Audit-Completeness Conformance（Audit Completeness Loop）

**Goal：** 每個敏感動作產生**形狀完整**的 AuditEvent。

對照現有 `src/audit/event.ts`：必含 `eventId, requestId, timestamp, tenantId, projectId, taskId,
actorId, action, resource, policyDecision, result`，`sandboxId` 視情況。`createAuditEvent` 對缺欄位
**throw**（無 partial event）——這是 fail-closed，必須有測試證明。

```bash
pnpm vitest run conformance/audit-completeness.conformance.test.ts
# 期望：完整事件可序列化且 11 必填欄位皆 defined；任一必填欄位缺失 → createAuditEvent throw。
```

**Exit condition：** 完整事件全欄位驗證通過；任一缺欄位/空白 id/whitespace-only action 觸發 throw。

### 3.5 Idempotency / Resume Conformance（Task Resume Idempotency Loop）

**Goal：** 被中斷的 task 可安全 resume，**不重複外部副作用、不遺失 audit 歷史**。

```bash
pnpm vitest run conformance/idempotency-resume.conformance.test.ts
# 模擬：task 在「副作用已提交」與「副作用未提交」兩個切點被中斷後 resume。
# 期望：相同 idempotency key 的外部 write 只發生一次；resume 後 audit chain 連續、無 gap、無重複 effect。
```

**Exit condition：** 重放同一 idempotency key 不產生第二次外部 write；resume 後 evidence 序列連續（接 §4 的 gap detection）。

### 3.6 Sandbox-Escape Regression（Sandbox Escape Regression Loop）

**Goal：** sandbox escape 嘗試**安全失敗並被 audited**。

```bash
pnpm vitest run conformance/sandbox-escape.conformance.test.ts
# 嘗試：讀 host 檔、存取未授權 mount、繞過 proxy、連被封內部位址。
# 期望：全部 deny + audited；OpenShell adapter 是唯一受管路徑（managed-path-is-only-path）。
```

**Exit condition：** 所有 escape 嘗試被 deny 並各 audited；adapter chokepoint 之外無放行路徑（配 §3.7 bypass 測試）。

### 3.7 Managed-Path-Is-Only-Path / Bypass Regression（架構不變量）

**Goal：** agent 若在 managed entrypoint 之外啟動 runtime，必須被 admission-control 擋下；否則 attest-the-negative
退化為 attest-nothing（見 architecture-approach.md §7 風險）。

```bash
pnpm vitest run conformance/managed-path.conformance.test.ts
# 期望：未經 Governance Plane 鑄造的 sandbox/credential 路徑被拒；唯一建立者/鑄造者是 adapter chokepoint。
```

**Exit condition：** 旁路啟動被 deny + audited。**release-blocking。**

---

## 4. 跨平面契約測試：TS ↔ Go Ingest Completeness（核心）

evidence kernel 的賣點不只「過去紀錄不可變」，而是**ingest 完整性可證**（attest-the-negative 誠實成立）。
依 architecture-approach.md §3/§4：**kernel-enforced monotonic per-source sequence + gap detection +
transactional outbox**。本節把這三者寫成 release-blocking 的跨平面測試。

### 4.1 三條不變量與其判定

| 不變量 | 規格 | 判定指令（exit 0 才過） |
|---|---|---|
| **Monotonic sequence** | 每個 source（per-tenant）的事件序號嚴格遞增、無重號 | `pnpm vitest run integration/ingest-sequence.contract.test.ts` |
| **Gap detection** | verifier 偵測序列缺口（缺號 = tamper/loss）並非零退出 | `go test ./evidence/verifier -run TestGapDetection` |
| **Transactional outbox** | 「先 commit 事件再放行副作用」；崩潰於 outbox 與 deliver 之間不丟事件、不重送 | `pnpm vitest run integration/outbox.contract.test.ts` |

### 4.2 端到端 ingest-completeness harness

```bash
pnpm run test:ingest   # 編排：起 Go kernel(test mode) → TS 送 N 條 hash-chained 事件 →
                       # 注入 (a)亂序 (b)重號 (c)抽掉第 k 條 (d)outbox-mid-crash →
                       # 跑 standalone verifier。
# 期望：
#   - 正常路徑：verifier 退出 0，chain 連續、簽章驗證通過。
#   - 抽掉第 k 條：verifier 偵測 gap，退出非 0（gap detection 成立）。
#   - outbox-mid-crash：恢復後事件數 == N（無丟、無重），verifier 退出 0。
```

### 4.3 平面只透過 typed contract 對話（hard constraint A）

TS 與 Go **只能**透過 proto / 序列化 schema 對話，**不得**互相 import 對方內部。契約漂移由 golden + buf breaking 攔下：

```bash
buf lint && buf breaking --against '.git#branch=main'   # proto 契約不漂移；breaking change 非零退出
pnpm run test:contract                                   # Zod ↔ proto round-trip：序列化後再解析等值
```

> **proto 尚未引入時的明確處置（trigger condition）：** **目前 repo 無 `.proto`、以 Zod 為單一 schema source**
> （見 `docs/research/architecture-approach.md` 與 `docs/design/architecture.md` §5）。因此：
> - `buf lint && buf breaking` 落入 §8 的 **no-op/fail-closed 規則**——`proto/` 目錄不存在時 skip exit 0；
>   一旦 `proto/` 建立卻無 buf 設定即 fail-closed 非零。
> - **引入 `.proto` 的 trigger = 架構 §5 / Slice S3（`proto/Zod single-source + codegen + proto:check`）。**
>   在 S3 之前，§4.3 的契約漂移**僅由 Zod round-trip（`pnpm run test:contract`）單獨守住**，buf 指令屬待生效。
> - 此規則使 buf gate **不會被靜默缺席**：要嘛 proto 不存在（明確 skip），要嘛存在且 buf 已 wired（強制）。

**Exit condition：** sequence 嚴格遞增、gap 被偵測、outbox 不丟不重、proto/Zod 契約無 breaking。全綠才放行。

---

## 5. Independent Verifier Pass — 驗收 gate（Tier 2）

這是 `AGENTS.md` §Looping Engineering 第 7 條與 Definition of Done 的**驗收閘**。任何 task「done」前必跑。

### 5.1 定義

由一位**fresh-context** 的獨立 verifier（人或另一 agent session，**不得**是實作者本人帶著實作上下文）執行：

1. **重跑通用 gate**，逐條列出 failing check（不接受口頭「我這邊是綠的」）：
   ```bash
   pnpm run verify        # typecheck + lint + build + test + secret-scan + §8 boundary check
   pnpm run conformance   # §3 全部 per-pillar release-blocking 套件
   pnpm run test:ingest   # §4 跨平面 ingest 完整性
   ```
2. **對抗式探測安全不變量**：主動嘗試破壞 deny-by-default、fail-closed、audit completeness、
   credential non-leak、tenant isolation、managed-path。任何一條被破 = FAIL。
3. **檢查耦合/內聚**（hard constraint A）：確認無新跨模組/循環依賴、被觸碰模組只經 public surface 觸及
   （§8 指令為證）。
4. **findings → fix → re-verify 迴圈**，cap = 5 次（無界禁止）；連續 3 次同類 failing 改採全局修正策略並寫入
   `docs/guardrails.md`。

### 5.2 PASS 的唯一定義（command-verifiable）

> Independent Verifier Pass = PASS **iff** 下列**全部** exit 0，且 verifier 的對抗式探測未破壞任一不變量：
> ```bash
> pnpm run verify && pnpm run conformance && pnpm run test:ingest
> ```
> 任一非零 → FAIL，task 未完成。**自述不算數，只有上面這串的 exit code 算數。**

> **Bootstrap 規則（消除「指令尚不存在 → 此 gate 既非 fail 也非 vacuous」的縫隙）：** `conformance` /
> `test:ingest` 等 script **目前不在 `package.json`**。在它們存在之前，§5（Independent Verifier Pass）與
> §7（Adversarial Code Review）**尚不可被宣稱為「可強制執行」**。落地規則：
> - 這些 gate script **必須先以 RED-first 建立一個 trivially-green 但真實存在的 stub**（例如 `conformance`
>   先指向一個目前為空、隨對應 phase 逐步加套件的目錄；`test:ingest` 在 kernel 進場前指向 §8 的
>   no-op/fail-closed wrapper），使 `pnpm run conformance` / `pnpm run test:ingest` **能跑出 exit code**
>   （而非 `command not found` 的偽 FAIL），其「skip vs fail-closed」語意由 §8 的偵測契約 + RED 測試守住。
> - **在某 slice 的必跑 gate 指令仍缺席時，禁止依 §5 宣稱該 slice「done」**——缺指令 = 尚未可驗收 = 非 done。
> - 各 gate script 隨其首個對應 slice 一併以 TDD 落地（§10「不得後補」），落地後本 gate 對該範圍即生效。

---

## 6. Per-Slice 驗收：把 Looping Engineering 釘進每個 slice

把上述串成每個 slice 的固定生命週期（slice 定義見 `docs/standards/slice-spec.md`）：

```
RED(§1)  →  GREEN(§1)  →  REFACTOR(§1)  →  pnpm run verify(§0,§8)  →
對應 conformance(§3/§4)  →  Independent Verifier Pass(§5)  →  Adversarial Code Review(§7)  →  MERGE
```

**No slice merges on self-review alone.**（hard constraint B；見 §7。）每個 slice 的 Definition of Done
逐項對齊 `AGENTS.md`：test-first 證據、`pnpm run verify` exit 0、Independent Verifier Pass = PASS、
secret-scan clean、docs 更新、boundary check 綠、Adversarial Code Review = PASS。

---

## 7. Per-Slice Adversarial Code Review（hard constraint B）

**規則：** 每個完成的 slice 在 merge 前**必須**通過一次對抗式 code review——reviewer 帶 **fresh context**、
其職責是**弄壞它**（詳細流程見 `docs/standards/adversarial-code-review.md`）。**禁止僅憑 self-review merge。**

### 7.1 Reviewer 的 blocking 維度（任一不過即 REJECT）

1. **RED 是真的紅**（§1.2 mutation 驗證）；測試斷言真的會因行為錯誤而失敗，非假測試。
2. **Deny-by-default / fail-closed**：能否構造一個 unknown/malformed 輸入逃過 deny？
3. **Credential non-leak**：能否讓 canary 流到 6 sink 任一？
4. **Tenant isolation / managed-path**：能否構造跨租或旁路路徑？
5. **Audit completeness**：敏感動作是否每條都有完整 AuditEvent？
6. **耦合/內聚（hard constraint A，blocking）**：有無新跨模組/循環依賴？是否 deep-import 內部？平面間是否
   只走 typed contract？模組是否單一職責？——以 §8 指令為客觀證據，不接受主觀「看起來還好」。
7. **無弱化**：有無新增 `skip/todo/ignore/nolint/--no-verify` 而未說明（§1.3）。

### 7.2 判定（command-verifiable 證據附在 review）

Review 結論必須附上 reviewer 在 fresh checkout 上實跑的指令輸出：
```bash
pnpm run verify && pnpm run conformance && pnpm run test:ingest && pnpm run boundaries
```
Reviewer 另須附上**至少一個它嘗試過的攻擊輸入**及其被攔下的證據（紅→被 deny / 被 redact / 被 reject）。
**PASS = 上述全綠 + 所有 blocking 維度無 finding（或 finding 已修並 re-verify 綠）。**

---

## 8. 依賴邊界檢查（dependency-boundary check）— 強制低耦合/高內聚

hard constraint A 是**強制、非願景**：illegal 或 cyclic 的跨模組依賴**必須讓 `pnpm run verify` 非零退出**。
各語言指定**具體工具**：

| 平面 / 語言 | 工具 | 規則 | 判定指令 |
|---|---|---|---|
| **TS control plane / SDK / UI** | [`dependency-cruiser`](https://github.com/sverweij/dependency-cruiser)（亦可加 `eslint-plugin-boundaries`） | `no-circular`（severity error）+ forbidden：禁 deep-import 他模組內部（只允 `index.*` / public surface）+ 強制 inward-pointing 層序（domain ← application ← adapters） | `pnpm run deps:check`（= `depcruise --config .dependency-cruiser.cjs src`，違反 exit 1） |
| **Python SDK** | [`import-linter`](https://import-linter.readthedocs.io/) | `layers` contract（SDK shim 不得反向 import Core internals）+ `forbidden`（shim 不得 import 任何 credential-holding 模組——維持 credential-blind）+ `independence` | `lint-imports`（contract broken 時非零退出） |
| **Go evidence kernel** | `depguard`（golangci-lint）+ Go `internal/` 套件 | `internal/` 隔離 kernel 內部；`depguard` 禁 kernel import control-plane / SDK；verifier 不得 import 寫入路徑 | `golangci-lint run ./...`（違反非零退出） |
| **跨平面** | proto golden + `buf breaking` | 平面只經 proto/Zod 對話，不得 import 對方內部（§4.3） | `buf lint && buf breaking --against '.git#branch=main'` |

> **Script 命名（與全 playbook 對齊）：** TS-only 的依賴邊界 script 的 **canonical 名是 `deps:check`**
> （見 `docs/standards/engineering-standards.md` §4.1 與 `SLICE-P0-003`）。本文件的 **`boundaries` 是
> 「跨語言聚合 wrapper」**，它在 TS 腿上呼叫 `deps:check`，再加 Go / Python 子檢查。亦即
> `boundaries = deps:check（TS）+ lint-imports（Py）+ depguard（Go）`。當前 repo 僅 TS 時，
> `boundaries` 等價於 `deps:check`。

```bash
# 單一聚合指令（掛入 pnpm run verify；任一語言違反即非零）：
pnpm run boundaries
# = deps:check（TS，= depcruise） + lint-imports（Py，若該包存在） + golangci-lint depguard（Go，若該模組存在）
```

**強制方式：** `pnpm run boundaries` 必須是 `pnpm run verify` 的一步（加入 `verify` script 的鏈中）。
未通過 → `verify` 非零 → pre-commit guard 擋 commit → CI 紅。耦合/內聚因此**由指令證明**，並同時是 §7 的 blocking 維度。

> **落地註記（YAGNI）＋ no-op/fail-closed 的可驗證偵測契約（非僅文件約定）：** Go kernel / Python SDK
> 尚未進 repo 時，其子檢查採「語言根目錄不存在 → skip exit 0；存在卻缺設定 → fail-closed 非零」。**這個語意
> 必須由 wrapper script 以具體規則實作、並由其自身的 RED 測試證明，而非僅靠散文約定：**
> - **具體偵測規則（範例，wrapper 必須實作）：** `boundaries:go` → 「若 `./kernel/go.mod` **不存在** ⇒ echo
>   skip 並 `exit 0`；若 `./kernel/go.mod` 存在但 `./kernel` 無 depguard/`.golangci.yml`/`internal/` 邊界設定
>   ⇒ `exit 1`」。`boundaries:py` 同理以 `./sdk/python/pyproject.toml` 存在性與 import-linter contract 存在性判定。
> - **RED 測試（隨 wrapper 同 slice 落地）：** 對 wrapper 餵 (a) 無語言根目錄 → 斷言 exit 0；(b) 偽造「根目錄
>   存在但缺設定」→ 斷言 exit≠0。**(b) 這條先紅**（wrapper 尚未實作 fail-closed 分支時），再實作轉綠——使
>   「no-op vs fail-closed」本身由**指令輸出**證明，而非散文。
>
> 當前 repo 僅 TS，先把 `depcruise` 接上 `verify`（`SLICE-P0-003`）；其餘語言 wrapper + 上述 RED 測試**隨各自
> 首個 slice 落地時同步接上（同 slice 內，不得後補）**。

---

## 9. Coverage 期望與跨語言 gate 編排

### 9.1 Coverage 政策（command-verifiable，非「感覺夠了」）

coverage 是**地板**，不是目標；它防回歸，但**不取代** §3/§4 的不變量套件（高 coverage ≠ 安全）。

| 範圍 | 工具 | 地板（line / branch） | 判定指令 |
|---|---|---|---|
| **安全核心**：`src/policy`、`src/audit`、`src/iam`、所有 `conformance/` 對應的 production 模組 | `vitest --coverage`（v8） | **100% / 100%**（deny-by-default、fail-closed、redaction、audit 完整性必須每條分支被測） | `pnpm run coverage:core` |
| **其餘 control plane** | 同上 | **90% / 85%** | `pnpm run coverage` |
| **Go evidence kernel** | `go test -cover` | **90%**；verifier 與 gap-detection 路徑 **100%** | `go test -coverprofile=... ./evidence/...` |
| **Python SDK shim** | `pytest --cov` | **90%**；credential-handling 路徑須有「shim 不持有 secret」測試 | `pytest --cov=agentos_sdk` |

```bash
pnpm run coverage:core   # 安全核心：低於地板即非零退出（release-blocking）
pnpm run coverage        # 全 control plane：低於地板即非零退出
```

**規則：** coverage 地板**只准升、不准降**。降地板需在 PR 說明 + 對抗式評審核可，且記入 `docs/guardrails.md`。
覆蓋率報告**不得**含 secret（canary 機制 §3.2 仍適用於報告檔）。

**100% branch 的唯一逃生口（command-verifiable，防靜默繞過）：** 安全核心的「每條 fail-closed 分支被測」是
硬地板；唯一允許的不可達分支標記 = **`/* c8 ignore next -- AGENT-OS-UNREACHABLE: <理由> */`**（v8/c8 的
ignore 指令），且**必須**帶 inline 理由 token `AGENT-OS-UNREACHABLE: <一句結構性理由>`。規則：
- 每一處 `c8 ignore` **必須**在對抗式評審被逐一檢視（adversarial review 的 blocking 維度），無 token 或理由
  不成立即 REJECT。
- **`c8 ignore` 納入 §9.4 的抑制標記計數 gate**：其總數計入 baseline，超 baseline 即 `guard:suppressions`
  非零退出——使「以 ignore 註解悄悄繞過 100% 地板」會讓 `pnpm run release` 變紅，而非無聲通過。

### 9.2 跨語言 gate 編排（一條指令收斂全部）

root `pnpm run verify` 是單一真相來源；它在現有鏈（`typecheck && lint && build && test && secret-scan`）
**之後**追加 `boundaries`（§8），並讓 `release` gate 進一步聚合 `conformance` + `test:ingest` + `coverage:core`：

```bash
pnpm run verify     # 開發內圈：typecheck + lint + build + test + secret-scan + boundaries（exit 0 才綠）
pnpm run release     # 發布閘：verify + conformance + test:ingest + coverage:core（任一非零即非零）
```

Go / Python 子 gate 由 `verify`/`release` 透過子指令（`go test …` / `pytest …`）呼叫；該語言根目錄不存在時
no-op 通過、存在但缺設定即 fail-closed（同 §8 註記），確保「一條指令 = 全棧全綠」誠實成立。

### 9.3 CI = 重跑同一批指令（不另立真相）

CI **不得**有獨立的、與本地不同的判定路徑。CI 必須**逐字重跑** `pnpm run release`（含跨語言子 gate），
其 exit code 是 PR 可否 merge 的唯一依據。任何「CI 特例放行」皆禁止。

```bash
# CI 的全部判定（與本地一致）：
pnpm run release ; echo "release exit=$?"   # 非 0 → PR 不可 merge
```

### 9.4 抑制標記計數 gate（防靜默弱化）

```bash
pnpm run guard:suppressions
# 統計 it.skip/it.todo/describe.skip/eslint-disable/@ts-ignore/@ts-expect-error/nolint
#   + c8 ignore（coverage 不可達分支標記，§9.1）數量；
# 超過 baseline（記於 repo）即非零退出，迫使對抗式評審逐一說明（§1.3、§7.1、§9.1）。
```

---

## 10. 指令清單（本文件引用的全部判定指令，集中索引）

> 下列為**契約指令**。尚未在 `package.json` 落地的 script，必須隨其首個對應 slice 一併加入（不得後補；
> 加入時連同其 RED 測試）。「只信指令輸出」要求這些指令存在且真實退碼。

```bash
# — 通用 gate（單一真相來源）—
pnpm run verify           # typecheck + lint + build + test + secret-scan + boundaries
pnpm run release          # verify + conformance + test:ingest + coverage:core（發布閘）

# — TDD 三步 —
pnpm vitest run <file>    # RED 須非零 / GREEN 須 0
pnpm test                 # 全 unit，不得回歸

# — per-pillar conformance（§3，release-blocking）—
pnpm run conformance
pnpm vitest run conformance/deny-by-default.conformance.test.ts
pnpm vitest run conformance/credential-non-leak.conformance.test.ts
pnpm run secret-scan
pnpm vitest run conformance/tenant-isolation.conformance.test.ts
pnpm vitest run conformance/audit-completeness.conformance.test.ts
pnpm vitest run conformance/idempotency-resume.conformance.test.ts
pnpm vitest run conformance/sandbox-escape.conformance.test.ts
pnpm vitest run conformance/managed-path.conformance.test.ts

# — 跨平面 ingest 完整性（§4）—
pnpm run test:ingest
pnpm run test:contract
buf lint && buf breaking --against '.git#branch=main'

# — 邊界 / 耦合（§8，hard constraint A）—
pnpm run boundaries

# — coverage（§9）—
pnpm run coverage:core
pnpm run coverage

# — 抑制標記 gate（§9.4）—
pnpm run guard:suppressions
```

---

## 11. 與既有 scaffold 的對齊（不重寫）

本標準直接坐落於現有程式碼，沿用既有慣例（KEEP + EXTEND）：

- `src/policy/evaluate.ts`：已 deny-by-default + fail-closed + 拒純萬用字元 → §3.1 直接以它為被測對象。
- `src/audit/event.ts`：`createAuditEvent` 缺欄位即 throw、11 必填欄位 → §3.4 的形狀來源。
- `src/audit/redact.ts` / `serialize.ts`：**現況只 by-key redaction**（value-scanning **尚未實作**，檔內自註）+
  「永遠經 `serializeAuditEvent`」是 §3.2 的序列化出口。**§3.2 的 6-sink 斷言（canary 流經 free-form 欄位仍被
  scrub）尚未由現有 redactor 滿足**——它由 RED-first slice `SLICE-P0-004`（value-scanning）落地後才綠，本文件
  把它升為 release-blocking。**不得**把現有 by-key redactor 讀成已滿足 6-sink。
- `src/iam/ids.ts`：branded `TenantId/…` → §3.3 tenant isolation 的型別基礎（A 的 id 不可當 B 用）。
- `scripts/scan_secrets.sh`：只印 `file:line`、不印值 → §3.2 第 6 sink，且 gate 自身不成為 leak source。
- `package.json` 的 `verify` 鏈、`.githooks/pre-commit` → §0/§8/§9 的編排基底（在其後追加 `boundaries`，
  並新增 `conformance` / `test:ingest` / `coverage:*` / `boundaries` / `guard:suppressions` scripts）。

新增 scripts 與其判定測試**必須以 TDD 落地**（先 RED），且每個落地 slice 都過一次 Independent Verifier Pass
與對抗式 code review，方可 merge。

---

*本文件不含任何 secret-like 值。所有驗收準則皆以可執行指令的 exit code 為唯一真相；自述不被接受。
凡與 `AGENTS.md` 衝突，以 `AGENTS.md` 為準。*
