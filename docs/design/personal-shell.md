# Design — R7 Personal 零技能殼（Personal zero-skill shell）

> 2026-06-21。本文件是 ITEM **R7（Personal 零技能殼）** 的**設計文件**（doc-first，無 doc 不開工），
> 對映 [`docs/slices/phase-2-remaining/INDEX.md`](../slices/phase-2-remaining/INDEX.md) R7 列、
> [`docs/design/three-surface-architecture.md`](./three-surface-architecture.md) 的 **Personal surface**、
> 與 [`docs/design/five-piece-integration.md`](./five-piece-integration.md) 的 governed pipeline。
> 方法論見 [`looping-engineering.md`](../standards/looping-engineering.md)：doc-first、小 slice、RED 先行、
> Independent Verifier Pass、5 回合→Staff+ 升級、writer↔reviewer 模型獨立。
> **AGENTS.md 在任何衝突上勝出。only command output is truth。**

---

## 1. 要解什麼（what）／為什麼（why）

**問題**：Personal surface 的目標使用者是**零技能（zero-skill）**的個人——不會寫 YAML、不懂 policy
DSL、不會讀 JSON receipt、不知道什麼是 sandbox。他們只想用**白話文字**說「幫我把這個資料夾備份到隨身碟」，
然後看到一個**看得懂的計畫**、按一個「同意」、事後能用人話**追溯到底發生了什麼**。

但底層（R1~R6 + P2-I governed pipeline）全是 ToolCall / PDP decision / CostGate reservation / WORM
AuditEvent——對零技能使用者**完全不可讀**。R7 的職責就是這一層**翻譯與守門殼**：把模糊的自然語言收斂成
一個**結構化、deny-by-default、可審**的請求，再把底層的治理結果翻回白話。

**為什麼是殼、不是新引擎**：治理權威（PDP 唯一 deny、commit-before-effect、WORM 證據根）已經在
`src/{policy,commitgate,audit,orchestration}` 建好且 `pnpm run verify` 可驗。R7 **不重造**任何一個——
它是一層**presentation + intent-shaping**，把既有 governed pipeline 包成一個人類可用的封閉迴圈。
這呼應全域 CLAUDE.md 的 YAGNI/DRY：能重用就不新造。

**核心不變量（必須由指令證明，非口號）**：
1. **clarify-or-fail-closed**：意圖不明確時**最多問 3 個澄清問題**；3 問後仍無法收斂成一個結構化計畫 →
   **拒絕（deny）**，絕不「猜一個」去執行。模糊 ⇒ deny。
2. **plan-preview-before-effect**：任何 effect 之前，使用者必須先看到**白話計畫預覽**並**顯式核准**；
   未核准 ⇒ 不進 governed pipeline。
3. **TaskTimeline 從 WORM 重建**：時間軸**唯一**來源是 audit kernel 的 append-only chain，
   絕不另開一個可被改寫的 side store；timeline 是 WORM 的**唯讀投影（read-only projection）**。
4. **credential 絕不落地**：launcher 的 secret 以**掛載/環境注入**進容器，**絕不**寫進 compose 檔、
   image、log、或任何 fixture（測試 canary 為 runtime 組裝）。

---

## 2. 架構（architecture）

### 2.1 元件與資料流（封閉迴圈）

```
  零技能使用者（純文字）
        │  自然語言
        ▼
  ┌─────────────────┐   不明確（≤3 問）   ┌──────────────┐
  │  IntentGateway  │ ─────────────────▶ │ ClarifyLoop  │
  │ (text-first)    │ ◀───────────────── │ (Q&A, capped)│
  └────────┬────────┘   收斂的 answers    └──────┬───────┘
           │ 結構化 StructuredIntent             │ 3 問後仍模糊
           │                                     ▼
           │                              fail-closed: deny
           ▼
  ┌─────────────────┐
  │  PlanPreview    │  把 StructuredIntent → 白話步驟清單（plain plan）
  │ (plain-language)│  + 風險/成本/受影響資源摘要（人話）
  └────────┬────────┘
           │ 使用者顯式核准 / 拒絕
           ▼
  ┌─────────────────┐  approve  ┌──────────────────────────────┐
  │  ApprovalInbox  │ ────────▶ │  runGovernedToolCall (P2-I)   │
  │ (pending/decide)│  reject   │  screen→PDP→cost→commit→effect │
  └────────┬────────┘  →deny    └───────────────┬───────────────┘
           │ 無核准 ⇒ 不執行                      │ 每步 append AuditEvent → WORM
           ▼                                      ▼
  ┌─────────────────┐  read-only projection  ┌──────────────┐
  │  TaskTimeline   │ ◀───────────────────── │ WORM kernel  │
  │ (plain replay)  │  fold(entries)→白話事件 │ (append-only)│
  └─────────────────┘                        └──────────────┘

  docker-compose Launcher：把上面整個 Personal surface（+ 既有 substrate/kernel）
  以 localhost-only、secrets-as-mount、deny-by-default 的方式一鍵起停。

  Voice（後）：在 IntentGateway 前掛一層 speech→text adapter，
  其餘管線完全不變（text-first 是 contract，voice 只是 IntentGateway 的另一個 input adapter）。
```

### 2.2 模組落點（低耦合，只經 barrel）

| 元件 | 落點（新模組） | 重用既有（只經 public surface） |
|---|---|---|
| IntentGateway（text）| `src/personal/intent` | — |
| ClarifyLoop | `src/personal/intent`（同模組，狀態機）| — |
| PlanPreview | `src/personal/plan` | `StructuredIntent`（from `personal/intent`）|
| ApprovalInbox | `src/personal/approval` | `runGovernedToolCall`（from `orchestration` barrel）|
| TaskTimeline | `src/personal/timeline` | audit `LogEntry`/`AuditEvent`/redaction 型別（見下方 barrel 缺口註記）|
| Launcher | `deploy/personal/`（compose + docs，非 src code）| — |
| Voice（後）| `src/personal/voice`（後續，inactive gate）| `IntentGateway`（from `personal/intent`）|

> **barrel 缺口（command-verifiable，必讀）**：`.dependency-cruiser.cjs` 的 `not-to-internal` 規則
> **只接受**「經目標模組的 `^src/<module>/index.ts` barrel 消費」或對 `src/iam/ids.ts` 的 interim 例外
> （見該 config 的 allowlist）。經查證：`src/orchestration`、`src/commitgate`、`src/cost`、`src/hosting`、
> `src/runtime/{brain,substrate}` **有** `index.ts` barrel；但 **`src/audit` 與 `src/iam` 目前皆無** `index.ts`
> barrel（`src/iam/ids.ts` 靠 config 具名 interim 例外通行，`src/audit/*` **無任何**被規則接受的 public 入口）。
> **頂層 `src/index.ts` 是 repo 對外公共 barrel，並非 `not-to-internal` 接受的 intra-`src` 消費路徑**
> （拿它當 import 來源會被規則視為 deep-import / 並把整個 surface 拉進來）。
> **結論（對 R7 slice 的硬約束）**：任何 R7 模組（尤以 S1/S3/S5）要 `import` `audit`/`iam` 而仍讓
> `pnpm run deps:check` exit 0，**必須**先有一個「為 `src/audit` 新增 `index.ts` barrel（並把 `iam` 從
> `ids.ts` 例外升成 `iam/index.ts` barrel）」的**前置 barrel-migration slice**（對映 dependency-cruiser
> 註解所述的「barrel-migration slice」）。R7 各 slice 已把此前置列入 Depends-on（見 §6 與各 slice §8）。

> **依賴方向**：`personal/*` → `{orchestration, audit, iam}`（皆 inward，向 domain/application 指）；
> `orchestration`/`audit`/`iam` **不**反向 import `personal/*`（無 cycle）。`personal/*` core **不含 vendor 名**
> （voice 的 STT vendor 走 adapter，落 `runtime/<vendor>` 或注入，core 只見 port）。

### 2.3 與既有 P2 piece 的接縫

- **IntentGateway → PlanPreview → ApprovalInbox → P2-I**：ApprovalInbox 的 `approve` 是
  `runGovernedToolCall(deps, toolCall)` 的**唯一**呼叫點；StructuredIntent 在這裡被 lower 成一個 `GovernedCall`
  形狀（`{ tool, context }`，見 `src/orchestration/pipeline.ts:24`）。R7 **不繞過** governed pipeline。
- **TaskTimeline ← WORM**：timeline 讀 `LogEntry[]`（`src/audit/kernel/log.ts:30`）並 fold 成白話事件；
  AuditEvent 形狀見 `src/audit/event.ts:32`。timeline **不寫**任何東西，純投影。
- **commit-before-effect**：effect 只在 WORM receipt 之後發生，由 P2-I 內的 `commitBeforeEffect`
  （`src/commitgate/guard.ts:57`）保證——R7 不重複實作此時序，只消費其結果。

---

## 3. Grounding（真實 clone，verified-from-code vs inferred）

R7 的設計大量參考 **Hermes**（`/tmp/hermes-agent-probe`）——它是一個成熟的「個人 / 文字優先 agent gateway +
docker-compose launcher + 待批准配對 + 語音延後」的真實系統，正是 Personal surface 的形態鄰居。
以下逐條標 **[verified-from-code]**（讀過該檔該行）或 **[inferred]**（由程式碼合理推論）。

### 3.1 docker-compose launcher（→ Slice S6）
- **localhost-only 預設綁定**：dashboard 預設綁 `127.0.0.1`，並明確警告「不要 `--host 0.0.0.0`」。
  `/tmp/hermes-agent-probe/docker-compose.yml:14`、`:17`、`:76`。**[verified-from-code]**
- **secrets-as-mount / env，不 bake 進 image**：API server key 預設關閉、要開需顯式 uncomment
  `API_SERVER_KEY`（mandatory for auth），且 service-account JSON 走 volume 掛載而非寫入 compose。
  `:25`、`:42-44`。**[verified-from-code]** → R7 launcher 沿用：secret 一律 env/mount，compose 檔零明文。
- **supervision /init 先行**：`/init`（s6-overlay PID 1）跑 cont-init.d（chown/profile/toggle）後才起
  service；`command: ["gateway","run"]`。`:61`。**[verified-from-code]** → R7 launcher 的啟動順序
  保證「kernel/substrate ready 才接 intent」是 **[inferred]** 的對映（R7 用自己的 healthcheck，不照搬 s6）。

### 3.2 待批准 / deny-by-default（→ Slice S4 ApprovalInbox）
- **owner 顯式核准的 pairing 模型**：pairing code 由 bot owner 經 CLI 核准；**未核准者預設不可互動**
  （deny-by-default）；**每平台最多 3 個 pending**（capped）。`/tmp/hermes-agent-probe/gateway/pairing.py:6`、
  `:12`、`:49`、`:81`。**[verified-from-code]** → R7 ApprovalInbox 直接對映：pending 計畫須 owner approve 才執行、
  上限封頂、未決 ⇒ 不執行。
- **第二軸 allowlist gating（deny-by-default）**：`SlashAccessPolicy` 在既有 allowlist 之上加「誰能觸發哪些
  指令」；未設定 admin ⇒ gating 視情況、預設 floor 最小集。`gateway/slash_access.py:3`、`:10`、`:57`。
  **[verified-from-code]** → R7 的「approve 只授權**這一個**計畫、非長期權限」設計借鏡此最小授權面。

### 3.3 文字優先 + 出口 redaction（→ Slice S1 IntentGateway / S5 Timeline）
- **gateway 在文字離開前做 secret redaction**：`_redact_gateway_user_facing_secrets` —「Best-effort secret
  redaction before text can leave the gateway」。`/tmp/hermes-agent-probe/gateway/run.py:290`。
  **[verified-from-code]** → R7 IntentGateway 的入口 screen 與 TaskTimeline 的出口投影都**必須**先過
  既有 `src/audit/redact.ts` redaction（不重造 Hermes 的 best-effort regex；用本 repo 既有 redact）。
- **文字優先、語音為後續 input adapter**：Hermes 的 gateway 以文字 platform 為核心（`gateway/platforms`、
  `gateway/run.py`），語音/額外通道是周邊。**[inferred]**（由 gateway 架構推論）→ R7 把 voice 設為
  IntentGateway 前的 input adapter（S7，inactive capability gate）。

### 3.4 其他 clone（R7 非主要 grounding，但已查證鄰接）
- **NemoClaw**（`/tmp/nemoclaw`）：是 hosting/agent 平台（`src/`、`schemas/`、`Dockerfile`），與 R7 的接縫
  在 R11 vendor adapter，而非 R7 殼層；R7 不直接依賴。**[inferred]**
- **OpenShell / SpendGuard / AGT**：分別是 substrate / cost / policy 的 vendor，R7 只透過 P2-I 的
  vendor-neutral port 間接觸及，**不**在 R7 core 出現其名。**[verified-from-code]**（見 R7 INDEX 列 R1/R6/R11
  才是這些 vendor 的歸屬）。

> **誠實揭露**：Hermes 是 Python；R7 落在本 repo 的 TS 控制平面。借鏡的是**設計模式**（localhost-only、
> secrets-as-mount、owner-approve-pending、出口 redaction、text-first-voice-later），**不是**程式碼移植。
> 任何「照搬實作」的宣稱都不成立——R7 重用的是**本 repo 既有的** TS 模組（§4），Hermes 只提供形態驗證。

---

## 4. 重用 vs 新建（reused vs new）

### 4.1 重用（既有 port/fake/kernel，只經 public surface）
- `runGovernedToolCall` / `GovernedCall` / `GovernedOutcome` — `src/orchestration/index.ts`
  （`pipeline.ts:24,53`）。ApprovalInbox approve 的唯一執行路徑。
- `AuditEvent` / `LogEntry` / `AppendReceipt` — `src/audit/event.ts:32`、`src/audit/kernel/log.ts:30,23`
  （經 `src/index.ts` barrel）。TaskTimeline 投影來源。
- `redactSecrets`（`src/audit/redact.ts:26`，連同常數 `REDACTED`＝`"[REDACTED]"` `:12`）— IntentGateway
  入口 / TaskTimeline 出口的 redaction。**[verified-from-code]**（注意：repo **無** `redactAuditEvent` 這個
  export；R7 用既有的 `redactSecrets`，不自造新 redactor）。
- `commitBeforeEffect` / `CommitAppender` — `src/commitgate/guard.ts:57,21`（經 P2-I 間接使用；R7 不直接呼叫）。
- `parseAgentContext` / branded ids — `src/iam/ids.ts`（StructuredIntent → GovernedCall.context 的身份欄）。

### 4.2 新建（R7 自己的小模組）
- `src/personal/intent`：`StructuredIntent` Zod schema + `IntentGateway`（text→intent）+ `ClarifyLoop`（≤3 問 FSM）。
- `src/personal/plan`：`renderPlanPreview(intent)`→白話步驟 + 摘要。
- `src/personal/approval`：`ApprovalInbox`（pending/approve/reject，capped）+ approve→`runGovernedToolCall`。
- `src/personal/timeline`：`buildTaskTimeline(entries)`→白話事件投影（read-only）。
- `deploy/personal/`：docker-compose + launcher 文件（非 src code；localhost-only、secrets-as-mount）。
- `src/personal/voice`（後）：STT input adapter port（inactive capability gate，見 §5）。

---

## 5. 取捨（trade-offs）與誠實能力閘（honest capability gates）

| 取捨 | 決定 | 理由 |
|---|---|---|
| clarify 用 LLM vs 規則 | **slice 範圍內用規則/schema 驅動的 deterministic clarify**（缺哪個 required 欄就問哪個）| RED 測試要可重現、deny-by-default 要 deterministic；LLM 改寫留作後續、不進 R7 核心不變量。**[capability gate]** LLM 輔助澄清是 inactive，直到有可驗的 prompt-eval gate。 |
| plan preview 文案 | **模板化白話**（從 StructuredIntent 結構生成），非 LLM 自由生成 | 可驗、無幻覺、無 secret 外洩風險。LLM 潤飾留後續。 |
| ApprovalInbox 授權粒度 | **approve 只授權「這一個計畫」一次性執行**，非長期權限 | 最小授權面（借鏡 Hermes slash_access floor）；長期權限/角色屬 Enterprise（R8），不在 Personal。 |
| TaskTimeline 來源 | **唯讀投影 WORM**，不另開 side store | 不變量 3；任何可改寫的 timeline 會破壞「證據根唯一」。 |
| Launcher 範圍 | **單機 localhost-only**；不含 LAN/反向代理/TLS termination | Personal beachhead 是單機（INDEX「串本機單一 OpenShell + SQLite」）；多租/網路暴露屬 R8。 |
| Voice | **延後（S7 為 inactive capability gate 規格）** | text-first 是 contract；voice 是 input adapter，不改管線；先把 text 路徑全綠再說。**[capability gate]** |

**能力閘（capability gates，誠實標註，不偽裝成已具備）**：
- **G1 — LLM 澄清/潤飾**：inactive。啟用條件 = 有可指令驗的 prompt-eval + redaction gate（後續 phase）。
- **G2 — Voice 輸入**：inactive。S7 只交付 port + inactive 規格；啟用條件 = STT vendor adapter 過 contract test
  且 IntentGateway text 路徑全綠。
- **G3 — 真實 WORM 外部錨定**：R7 timeline 投影 P1 in-memory kernel；外部錨定（RFC-3161/Tessera）是 P1 範圍，
  R7 不假設其已具備（投影邏輯對 in-memory 與 anchored chain 形狀相容即可）。**[inferred 相容性]**

---

## 6. Slice 分解（小 slice，acyclic，每個 ≤ size budget）

> **前置 barrel-migration（B0，非 R7 內部 slice，但為 R7 的硬前置）**：在 R7 任一 import `audit`/`iam` 的
> slice（S1/S3/S5）開工前，必須先 merge 一個「`src/audit/index.ts` barrel ＋ `src/iam/index.ts` barrel
> （移除 `.dependency-cruiser.cjs` 對 `src/iam/ids.ts` 的 interim 例外）」的 slice（對映該 config 註解所述
> 「barrel-migration slice」）。此前置不屬 R7 範圍（它服務全 repo），但 R7 把它列為 Depends-on 以保證
> `pnpm run deps:check` 在 S1/S3/S5 仍 exit 0。下表以 **B0** 代稱此前置。

| Slice | Title | 模組 | Net LOC（估）| Depends-on |
|---|---|---|---|---|
| **P2R-R7-S1** | IntentGateway（text）+ StructuredIntent schema | `personal/intent` | ~140 | P2-I（已 merge）, B0（audit/iam barrel）|
| **P2R-R7-S2** | ClarifyLoop ≤3 問 + fail-closed | `personal/intent` | ~150 | S1 |
| **P2R-R7-S3** | PlanPreview（白話投影）| `personal/plan` | ~120 | S1 |
| **P2R-R7-S4** | ApprovalInbox（pending/approve→P2-I/reject，capped）| `personal/approval` | ~180 | S3, P2-I |
| **P2R-R7-S5** | TaskTimeline（WORM 唯讀投影）| `personal/timeline` | ~150 | B0（audit barrel）；audit kernel（已 merge）|
| **P2R-R7-S6** | docker-compose launcher（localhost-only、secrets-as-mount）| `deploy/personal` | ~120 | S4, S5 |
| **P2R-R7-S7** | Voice input adapter port（inactive capability gate 規格）| `personal/voice` | ~90 | S2 |

> **與 INDEX `R7 -> { P2-I, R2 }` 的對賬**：INDEX 列 R7 依賴 **R2（真實 TS→Go ingest client）**。R7 的 WORM
> 投影（S5）消費的是 `LogEntry[]` **型別形狀**，此形狀對「P1 in-memory kernel」與「R2 接上後的 sync-commit
> 鏈」**相同**（見 §5 能力閘 G3）。因此 **R2 並非 R7 的 build-time 硬前置**——R7 在 P1 kernel 上即可端到端
> verify；R2 只影響 timeline 背後資料是否已外部錨定，不影響投影邏輯或其 DoD。故本設計**刻意不**把 R2 列入
> S5 的 build 依賴，並在此明載此偏離 INDEX 的理由（避免 silent divergence）。INDEX 的 R2 邊宜解讀為
> 「上線同一 surface 的建議先後」而非 R7 編譯前置。

### Slice DAG（鄰接表，無 cycle）
```
S1 -> { P2-I, B0 }
S2 -> { S1 }
S3 -> { S1 }
S4 -> { S3, P2-I }
S5 -> { B0 }       # 另依賴已 merge 的 audit kernel；B0 提供被 deps:check 接受的 audit barrel
S6 -> { S4, S5 }
S7 -> { S2 }
```
> 無 cycle 證明（B0、P2-I 皆為已/先 merge 的前置，rank 視為 -1）：rank = 0（S5 在 B0 上）/ 1（S1）/
> 2（S2,S3）/ 3（S4,S7）/ 4（S6）；每條 R7 內部邊嚴格遞減、且無 R7 slice 反向依賴 B0/P2-I ⇒ DAG。
> 排序紀律：先 **S1** 立 text intent contract（下游全依賴它的 schema），**S2/S3** 分別補澄清與預覽（互相獨立），
> **S4** 接 governed pipeline（唯一 effect 入口），**S5** 獨立做 WORM 投影（零 src 耦合、可極早做），
> **S6** 把全部一鍵起停，**S7** voice 為 inactive gate 收尾。

---

## 7. 安全與驗收摘要（每 slice 細則見其 slice-doc §5/§6）
- **deny-by-default / fail-closed**：clarify 3 問未收斂→deny；未核准→不執行；未知/malformed intent→deny。
- **credential non-leak**：launcher compose 零明文 secret；測試 canary runtime 組裝；secret-scan 須 clean。
- **audit 完整性**：effect 只經 P2-I 的 commit-before-effect；timeline 唯讀投影 WORM、不改寫歷史。
- **low coupling**：`personal/*` 只經 barrel 消費 `orchestration`/`audit`/`iam`；core 無 vendor 名；inward + acyclic。
- 每個 slice：RED 先行（親眼見紅 exit≠0）→ `pnpm run verify` exit 0 → fresh-context Independent Verifier PASS → `--no-ff` merge。
