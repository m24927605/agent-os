# Design — ToolManifest registry + PDP `tool:invoke`（R3）

> 2026-06-21。本文件是 **ITEM R3**（見 [`docs/slices/phase-2-remaining/INDEX.md`](../slices/phase-2-remaining/INDEX.md) 第 R3 列）的權威設計，
> doc-first：本設計 + 其下三個小 slice spec 齊備並通過一次文件對抗式 review 後才開工。
> 方法論見 [`docs/standards/looping-engineering.md`](../standards/looping-engineering.md)、slice 紀律見
> [`docs/standards/slice-spec.md`](../standards/slice-spec.md)。**AGENTS.md 在任何衝突上勝出。only command output is truth。**

---

## 1. What / Why（要做什麼、為什麼）

### 1.1 問題
目前的治理管線（[`src/orchestration/pipeline.ts`](../../src/orchestration/pipeline.ts) `runGovernedToolCall`）對「brain 提出的 tool call」只知道
一個結構欄位 `tool: string`（見 `GovernedCall`，pipeline.ts:24-27）；PDP（[`src/policy/evaluate.ts`](../../src/policy/evaluate.ts)）對 `action`/`resource`
做 deny-by-default 比對，但**任何字串都可以被當成 tool 名稱送進來**——系統沒有「這個 tool 是否存在、它的副作用語意是什麼」的權威來源。
這違反 deny-by-default 的精神：**一個未註冊（unknown）的 tool 應該結構性地被拒絕**，而不是落到「沒有 allow rule → deny」這條
泛用兜底（那條對也能用，但無法承載 per-tool 的副作用/冪等語意，也無法讓 audit reason 指出「unregistered tool」）。

### 1.2 目標
建立一個 **agent-agnostic（與任何具體 agent / brain / vendor 無關）的 ToolManifest registry**，並讓 PDP 多一條
`action = "tool:invoke"` 的判定：**tool 未註冊 → deny（deny-by-default、fail-closed）**。ToolManifest 是
**Zod `.strict()`** 的 9 欄宣告式 schema，把每個工具的副作用語意（`sideEffect`）與冪等性（`idempotent`）變成
**結構化、可被 policy / commit-gate / 審批 inbox 消費的契約**，而不是散落在各 vendor heuristic 裡的字串比對。

### 1.3 為什麼是 9 欄、為什麼要 sideEffect + idempotent（grounded）
真實 vendor 棧已經各自用**非結構化**方式表達「這個動作有沒有副作用、危不危險」：
- **Hermes** 用 47+ 條 regex pattern（`DANGEROUS_PATTERNS`）在執行邊界偵測破壞性命令——`rm -rf`、`SQL DROP`、
  `DELETE FROM ... 無 WHERE`、`TRUNCATE`、`mkfs`、寫 block device 等（[`/tmp/hermes-agent-probe/tools/approval.py:379-394`](file:///tmp/hermes-agent-probe/tools/approval.py)，
  `detect_dangerous_command` 簽章在 approval.py:656）。這是「side-effecting / destructive」的事實證據，但它是 command 字串的
  事後 heuristic，**不是工具的宣告式屬性**。
- **AGT**（agent-governance-toolkit）的 wire-protocol facets 把 SQL/K8s 動作分類成 **read-only vs mutating**：
  `SELECT` / `GET,list,watch` → allow（read-only），`DROP,TRUNCATE,DELETE` / `deletecollection` → deny（destructive）
  （[`/tmp/agent-governance-toolkit/docs/WIRE-PROTOCOL-FACETS.md:38-51,95-108`](file:///tmp/agent-governance-toolkit/docs/WIRE-PROTOCOL-FACETS.md)）。
  且其 MCP proxy 從 **tool call arguments** 萃取 policy context（WIRE-PROTOCOL-FACETS.md:127-135）——這正是「PDP 在 tool:invoke
  邊界做決策」的對應證據。
- **Hermes** 的 tool 定義本身用 OpenAI 風格 `function`（`name` / `description` / `input_schema`）（[`/tmp/hermes-agent-probe/model_tools.py:325,420,486`](file:///tmp/hermes-agent-probe/model_tools.py)
  以 `t["function"]["name"]` 索引），**沒有** sideEffect/idempotent 這類治理欄位——這正是 Agent OS 要補上的治理深度。

結論（verified-from-code）：副作用與冪等性在真實棧中是用**散落的 heuristic** 表達的；R3 的價值是把它收斂成**一個宣告式、
vendor-neutral、Zod-strict 的契約欄位**，讓 PDP / commitgate / 審批層共享同一個事實來源。`sideEffect` 對映
AGT 的 read-only↔mutating + Hermes 的 destructive 軸；`idempotent` 支撐 R5 crash-after-effect 的 content-hash dedup
重放安全（見 INDEX.md R5：「crash 後 resume 無重複 effect」）。

---

## 2. Architecture（架構）

### 2.1 ToolManifest 的 9 欄（Zod `.strict()`）
`.strict()` 是硬要求：**未知欄位 → parse 失敗 → fail-closed**（不得靜默吞掉攻擊者夾帶的額外欄位）。

| # | 欄位 | 型別 | 語意 | grounding / 理由 |
|---|---|---|---|---|
| 1 | `name` | non-empty string | 工具唯一識別名（registry key） | Hermes `function.name`（model_tools.py:325） |
| 2 | `version` | non-empty string（semver-shaped） | manifest 版本，供後向相容/演進 | slice-spec §「backwards compatibility」、R9 ToolManifest authoring |
| 3 | `description` | non-empty string | 人讀說明（審批 inbox 顯示用） | Hermes `function.description`（model_tools.py:473） |
| 4 | `action` | non-empty string | 對映 PDP 的 `action`（例：`tool:invoke`） | PDP `PolicyRequest.action`（[`src/policy/types.ts:16`](../../src/policy/types.ts)） |
| 5 | `resourcePattern` | non-empty string | 此工具觸及的 resource glob（**宣告用**；R3 僅儲存，尚未接進 PDP `matchResource`——見下方註） | PDP `resource` + `matchResource`（evaluate.ts:67） |
| 6 | `sideEffect` | enum `none\|read\|write\|destructive` | 副作用等級（治理核心軸） | AGT read-only↔mutating↔destructive（WIRE-PROTOCOL-FACETS.md:38-51）；Hermes DANGEROUS_PATTERNS（approval.py:379） |
| 7 | `idempotent` | boolean | 同一輸入重放是否安全（無重複 effect） | R5 content-hash dedup 重放安全（INDEX.md R5） |
| 8 | `requiresApproval` | boolean | 是否強制走人工審批（Personal ApprovalInbox） | Hermes 審批系統（approval.py:1-8） |
| 9 | `bundleRefOnly` | boolean | 憑證只能以 bundleRef 參照、禁 literal secret | credential-blind（P2-D `screenBrainEvent`、dedup.ts 註解的 credential 不外洩律） |

> **欄位消費範圍（誠實標注，避免 over-claim）：** R3 三刀**只**消費 `name`（registry key / lookup）與 `action`
> （= `"tool:invoke"` 判定）。`resourcePattern`(5)/`sideEffect`(6)/`idempotent`(7)/`requiresApproval`(8)/`bundleRefOnly`(9)
> 在 R3 **僅被 schema 驗證與儲存**，其接入點留給後續 ITEM（resourcePattern→PDP `matchResource`、sideEffect/idempotent→R5
> dedup、requiresApproval→R7 approval、bundleRefOnly→credential 前置）。R3 不宣稱對這些欄位做行為性消費。
>
> **一致性護欄（內建於 schema 的 `.refine` 或 registry 驗證，slice 內決定放哪）：** `sideEffect: "none"` 蘊含
> `idempotent: true`（無副作用必然可安全重放）；`sideEffect: "destructive"` 蘊含 `requiresApproval: true`
> （破壞性動作必須過審批）。違反者 parse/register 失敗（fail-closed）。此護欄把 §1.3 的 grounding 變成不變量。

### 2.2 三個元件與資料流
```
              register(manifest)                    authorizeToolInvoke(req)
ToolManifest ───────────────────▶ ToolRegistry ◀──────────────────── PDP tool:invoke 規則
 (S1: Zod-strict)   parse+strict      (S2)        lookup(name)         (S3: 未註冊→deny)
                    dup-id→deny     in-memory Map                       │
                                                                        ▼
                                              combineDecisions / runGovernedToolCall
                                              （既有 dedup.ts / pipeline.ts，PDP 唯一 deny 權威）
```
- **S1（domain type）**：`ToolManifest` Zod schema + `parseToolManifest(input): ToolManifest`（fail-closed）。純型別、零副作用、不 import 其他 module（只 zod）。
- **S2（registry）**：`ToolRegistry`——`register`（重複 name → deny/throw，fail-closed）、`lookup(name): ToolManifest | undefined`、`has(name): boolean`、`list()`。in-memory `Map`，建構時可選擇性 seed（每筆走 S1 parse）。只 import S1。
- **S3（PDP 規則）**：一個 **registry-backed 的 authorize predicate**，把「`action === "tool:invoke"` 且 tool 未註冊 → deny」做成 PDP 評估前的**結構性前置**，再交給既有 `evaluatePolicy` / `combineDecisions`。它依賴 S2 + 既有 policy types，**不改** `evaluate.ts` 的核心（PDP 仍是唯一 deny 權威；新規則只會「deny 更多」，不會 grant）。

### 2.3 與既有 PDP 的關係（不破壞 dedup #1）
[`src/policy/dedup.ts`](../../src/policy/dedup.ts) 已鎖死「PDP 是唯一 deny 權威、any-deny-wins、secondary-allow 不能翻 PDP-deny」。
R3 的 `tool:invoke` 規則**遵守同一律**：它是 deny-only 的前置篩（unregistered → deny），**永遠只能 deny 更多**，
不能把任何東西變 allow（registered 的 tool 仍要過 `evaluatePolicy` 的 allow rule + 既有 deny precedence + tenant scope）。
這保證 R3 不會成為「第二個能 grant 的權威」，與 dedup.ts 的設計不矛盾。

---

## 3. Reuse vs New（重用既有 vs 新建）

### 3.1 重用（已建、已 merge 的 P2 ports/fakes/kernel）
- **PDP 核心**：`evaluatePolicy` / `matchResource` / deny-precedence / tenant-scope（evaluate.ts，**不改**）。
- **dedup 合併律**：`combineDecisions` / any-deny-wins（dedup.ts，**不改**；R3 規則作為一個 deny-only 前置與之相容）。
- **PolicyDecision / PolicyRequest 型別**：types.ts（重用，R3 規則回傳同一個 `PolicyDecision` 形狀，`auditRequired: true`）。
- **iam ids**：若 manifest/registry 需要 tenant scope，重用 `TenantId`（ids.ts），不自造。
- **barrel pattern**：透過 `src/index.ts` 既有 barrel export（index.ts:10-12 已 export policy 三檔），R3 新檔比照只經 barrel 對外。
- **secret canary runtime 組裝**：比照 P2-D（brain slice）測試 secret 為 runtime 組裝、不入 fixture（避免 secret-scan 誤報）。

### 3.2 新建
- `ToolManifest` Zod-strict schema + `parseToolManifest`（S1）。
- `ToolRegistry`（S2）。
- `authorizeToolInvoke` registry-backed predicate + 一個 fake/2nd-impl registry 供 contract（S3）。

### 3.3 不做（明確 out-of-scope，留給後續 ITEM）
- 真實 vendor adapter（從 Hermes/OpenShell MCP 抓 tool 清單自動 populate manifest）→ 留給 **R11 vendor-adapters**。
- ToolManifest authoring CLI / SDK → 留給 **R9 developer-sdk**（INDEX.md R9 已列「ToolManifest authoring」）。
- 把 `idempotent` 接進 crash-after-resume 的 content-hash dedup → 留給 **R5**。
- 把 `requiresApproval` 接進 Personal ApprovalInbox UI → 留給 **R7**。
- 持久化 registry（DB-backed）→ 後續；本 ITEM 只 in-memory（Personal 單機 beachhead 足夠）。

---

## 4. Trade-offs（取捨）

| 決策 | 取捨 | 理由 |
|---|---|---|
| `tool:invoke` 規則做成 **deny-only 前置**，不改 `evaluate.ts` | 多一層而非改核心 | 保護 dedup #1「PDP 唯一 deny 權威」不被稀釋；R3 只能 deny 更多（fail-safe）；evaluate.ts 仍可被 P2-E/F 的測試獨立守住 |
| registry **in-memory** | 重啟即失憶、無跨進程共享 | YAGNI：Personal 單機 beachhead（INDEX.md P2）夠用；持久化是 R8/後續的事，現在做是過度設計 |
| `.strict()` 而非 `.passthrough()` | 對「多送欄位」更嚴格、後向相容靠 `version` 欄顯式管理 | deny-by-default/fail-closed：未知欄位是攻擊面，必須拒絕；演進走 version 而非寬鬆 schema |
| 9 欄一次定義 | 比「先 3 欄」前期成本高 | 9 欄是 prompt 與 grounding（§1.3）共同要求的最小治理集合；`sideEffect`+`idempotent` 是 R5/commitgate 的硬前置，缺了後續會回頭改 schema（更貴） |
| 一致性護欄（none⇒idempotent、destructive⇒requiresApproval）放 schema/registry | 增加一點 schema 複雜度 | 把 grounding 的語意變成**機器可驗不變量**，否則 manifest 可被填成自相矛盾（destructive 但免審批）——那是治理漏洞 |

---

## 5. Honest capability gates（誠實的能力閘門）

- **verified-from-code**：side-effect/destructive 的真實表達（Hermes `DANGEROUS_PATTERNS` approval.py:379-394、`detect_dangerous_command` approval.py:656）；read-only↔mutating 分類（AGT WIRE-PROTOCOL-FACETS.md:38-51,95-108）；tool 定義用 `function.name/description`（Hermes model_tools.py:325,473）；PDP 既有 deny-by-default/tenant/dedup（evaluate.ts、dedup.ts、types.ts，本文件已逐處 cite 行號）。
- **inferred（設計推斷，非 vendor 既有）**：把 sideEffect/idempotent/requiresApproval/bundleRefOnly 收斂成**單一宣告式 Zod-strict manifest** 是 Agent OS 的設計，**並非** 任何 vendor 既有結構（Hermes 的 `function` 沒有這些治理欄位——這是缺口，不是抄襲）。9 欄的具體命名/enum 值是設計選擇。
- **尚未做（gate）**：自動從 vendor MCP server 探索 tool 清單（R11）；registry 持久化與多租分割（R8）；把 manifest 餵進真實 commit-gate 的副作用前置條件（後續）。本 ITEM 只交付「結構性拒絕 unknown tool + 宣告式副作用契約」，不宣稱端到端 vendor 整合。
- **only command output is truth**：本文件所有「綠/通過」宣稱在 slice 實作前皆為 placeholder；唯有各 slice DoD 的 `pnpm run verify` exit 0 + fresh-context IV PASS 才算數。

---

## 6. Slice 分解與 DAG（無 cycle）
| Slice | 檔案 | Title | Depends-on |
|---|---|---|---|
| **P2R-R3-S1** | [P2R-R3-S1-toolmanifest-zod-strict-schema.md](../slices/phase-2-remaining/P2R-R3-S1-toolmanifest-zod-strict-schema.md) | Zod-strict ToolManifest（9 欄含 sideEffect/idempotent）+ parse + 一致性護欄 | P2-E（既有 policy types） |
| **P2R-R3-S2** | [P2R-R3-S2-toolmanifest-registry.md](../slices/phase-2-remaining/P2R-R3-S2-toolmanifest-registry.md) | ToolRegistry（register dup-id→deny、lookup、fail-closed） | P2R-R3-S1 |
| **P2R-R3-S3** | [P2R-R3-S3-pdp-tool-invoke-unregistered-deny.md](../slices/phase-2-remaining/P2R-R3-S3-pdp-tool-invoke-unregistered-deny.md) | PDP `tool:invoke` 規則：未註冊→deny（deny-only 前置，相容 dedup #1） | P2R-R3-S2、P2-E |

```
P2R-R3-S1 -> { P2-E }
P2R-R3-S2 -> { P2R-R3-S1 }
P2R-R3-S3 -> { P2R-R3-S2, P2-E }
```
> 無 cycle 證明：rank S1=1、S2=2、S3=3（每條邊嚴格遞減）⇒ DAG。契約先於消費者：schema(S1) → registry(S2) → PDP 規則(S3)。

---

## 7. Grounded citations（real file:line）
- `/tmp/hermes-agent-probe/tools/approval.py:1-8`（dangerous command 系統的 single source of truth）
- `/tmp/hermes-agent-probe/tools/approval.py:379-394`（`DANGEROUS_PATTERNS`：rm -rf / SQL DROP / DELETE 無 WHERE / TRUNCATE / mkfs / write block device）
- `/tmp/hermes-agent-probe/tools/approval.py:656`（`detect_dangerous_command` 簽章）
- `/tmp/hermes-agent-probe/model_tools.py:325,473`（OpenAI 風格 `function.name` / `function.description` tool 定義，無治理欄位）
- `/tmp/agent-governance-toolkit/docs/WIRE-PROTOCOL-FACETS.md:38-51`（SQL：DROP/TRUNCATE/DELETE→deny、SELECT→allow）
- `/tmp/agent-governance-toolkit/docs/WIRE-PROTOCOL-FACETS.md:95-108`（K8s：deletecollection/exec→deny、get/list/watch→allow）
- `/tmp/agent-governance-toolkit/docs/WIRE-PROTOCOL-FACETS.md:127-135`（MCP proxy 從 tool call arguments 萃取 policy context）
- `src/policy/types.ts:16`（`PolicyRequest.action`）、`src/policy/types.ts:24-30`（`PolicyDecision`）
- `src/policy/evaluate.ts:67`（`matchResource`）、`src/policy/evaluate.ts:173`（deny-by-default 兜底）
- `src/policy/dedup.ts:43-82`（`combineDecisions` any-deny-wins、PDP 唯一 deny 權威）
- `src/orchestration/pipeline.ts:24-27`（`GovernedCall { tool, context }`）、pipeline.ts:64-66（policy gate）
- `src/index.ts:10-12`（policy barrel export pattern）
