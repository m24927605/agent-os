# Agent OS Roadmap — Phase 0–5

> 本文件是 Agent OS build playbook 的**路線圖**。它把 6 個 phase（P0–P5）對映到
> **8 個 killer app（c1/c6/c4/c20/c10/c12/c3/c2）**、**7 大 pillar**、與 **4 項 cross-app P0 feature**，
> 並把每個交付物寫成 **指令可驗證（command-verifiable）的 checkbox**。
>
> 權威契約：[`AGENTS.md`](../AGENTS.md)。架構決策：[`docs/research/architecture-approach.md`](./research/architecture-approach.md)。
> 機會與 app/pillar 對照：[`docs/research/opportunities.md`](./research/opportunities.md)。開發流程：[`docs/dev-loops.md`](./dev-loops.md)。
> 保留英文技術術語與程式識別符號。日期：2026-06-19。狀態：**Active**。
>
> **這份 roadmap 本身受 Looping Engineering 與兩條 hard constraint 約束**（見下方「治理本路線圖的規則」）。
> Phase 0 已拆成 checklist-style slice list（指向 [`docs/slices/phase-0/`](./slices/phase-0/)）；
> Phase 1–5 僅給 outline，**slice 級拆解 just-in-time**（進入該 phase 前才寫，避免過早承諾錯誤細節）。

---

## 定位與願景（2026-06-20，founder 決定）

> **Agent OS ＝ agent 時代的作業系統**（Windows 之於 PC 時代的格局）。如同真正的 OS 是「**一個 kernel +
> 多個 edition**」，Agent OS 是「**一個治理核心 + 三個 surface**」，三者**全做**、共用同一核心：
>
> - **共用核心（＝目前在建、三 surface 共用的「NT kernel」）**：evidence kernel（WORM hash-chain +
>   standalone verifier + per-source sequence/gap + outbox + commit-before-effect + append-only ingest）
>   + governance plane（deny-by-default policy、credential-blind redaction、AgentContext、tenant isolation）
>   + `ExecutionSubstrate` 抽象（OpenShell ＝ substrate #1，非產品本體）+ SDK。
> - **三個 co-equal 主力產品（founder 2026-06-20：三個都是 primary monetized product，非一主二漏斗）**——
>   禁的是**定價軸**不是變現：**任一 surface 都不得以 價格/算力/便利 為軸，每面都以 信任/治理/問責 為價值、
>   把同一個護城河賣給不同的「需向第三方舉證」買家**：① **Personal — Fiduciary-Grade Personal Agent**（買家＝
>   受託專業人士 律師/CPA/RIA/醫師，第三方 relying party 由法律強制；定價軸＝adversarial admissibility / per-matter
>   Evidence Pack；誠實落 Tier-Brokered）② **Enterprise — Agent Governance Plane**（ACV 旗艦；買家＝CLO/CRO/CCO +
>   CISO/TPRM；定價軸＝per-governed-third-party-agent / admissibility tier / per-evidence-pack；beachhead c3→c6）
>   ③ **Developer — Governance-native runtime**（買家＝被安全審查擋住的 platform-eng/app-sec；定價軸＝per-attested-action
>   / governance seat，compute 成本價直通、**絕非 $/vCPU-hr**）。
>
> **護城河＝信任/治理核心，不是 runtime。** 別人抄不走的是「**attester ≠ attested actor**」——簽章、可獨立驗證、
> agent 與 operator 都偽造不了的 WORM system-of-record。**跨面鐵律（release-blocking invariant，與 deny-by-default 同級）**：
> standalone verifier 必須**離線、不連後端、不信 operator** 完成驗章+驗鏈+gap；任何把 attester 綁回 operator 的設計
> ＝禁 ship、禁計價。**建構順序：治理 kernel 已完成（P1 DONE）→ 變現先壓 Enterprise c3（第三方由法規強制、why-now 真實）
> → Personal/Developer 同時上架但晚於 c3 規模化。**
>
> **Guarantee Ladder（誠實 scope，弱 surface 不得暗示強 surface 的保證）**：Tier-Hosted（受管 substrate，
> by construction 全套含 attest-the-negative）/ Tier-Brokered（creds+maker-checker+commit-before-effect 成立）
> / Tier-SDK（外部 runtime 自報，僅證明「被回報了什麼」、上游可偽造）。
>
> **商業 gate（非工程、不擋 build）**：**SF3**（binary go/no-go，非 advisory）——規模化證據級 GTM 前，design-partner 的
> 外部律師/稽核師/E&O 承保人**書面確認**簽章 WORM bundle「偏好且可採納」（資產而非可被 discovery 的負債）。
> **SF6**——收 per-attested-action / admissibility 溢價前，先**外部化簽章 root**（客戶 KMS/HSM 或外部 transparency
> log / eIDAS QTSP）；未外部化前對外措辭與定價封頂在「tamper-evident(post-hoc)、separate-process 非 separate-org」。
> beachhead motion：c3 Tenant-Sealed Fleet → c6 Agent Escrow。權威定位見 [`AGENTS.md`](../AGENTS.md) north star。
>
> **三 surface 完整產品的端到端架構 / 作法 / 分階段規劃 / 下一步 slice（P2 c24 為 NEXT）見**
> [`docs/design/three-surface-architecture.md`](./design/three-surface-architecture.md)（2026-06-20，Staff+ 團隊讀真實 repo 產出）。
>
> **誠實殘餘風險（founder 親自承擔）**：Microsoft 開源 Agent Governance Toolkit（2026-04，含 Merkle audit + 合規
> mapping）已把「治理證據即 artifact」做成免費勾選項——唯一倖存差異是「外部化簽章 root + operator-independent
> 離線 verifier」，時間差約 6–18 個月（非結構性永久護城河）。**SF6（root 外部化）是存活前提**：Tier-Hosted 下若簽章
> key 仍由我方持有，我方即另一個 operator，per-attested-action 溢價在誠實上站不住。Personal 在保險/bar 把
> 「不可偽造性」寫進強制力前，是**獲客楔子**多於毛利核心。

---

## 0. 治理本路線圖的規則（NON-NEGOTIABLE — 每個 phase / slice 都適用）

> 這些規則不是背景說明，而是**每個 checkbox 的隱含驗收條件**。任何 phase 的任何 slice，
> 在勾選「done」之前，下列每一條都必須為真，且**由指令輸出證明，而非自述**。

### 0.1 Looping Engineering（強制）

- [ ] **單一真相閘**：`pnpm run verify`（= `typecheck && lint && build && test && secret-scan`）exit 0。
      Go kernel / Python SDK 進場後，`verify` 必須**級聯**呼叫各語言 gate（見 §1 P0-S2），仍是單一入口。
- [ ] **只信指令輸出**：任何「done」必須附 `pnpm run verify` 的 exit code（或等價真實指令）。**禁止自述完成。**
- [ ] **Test-first（TDD）**：每個 slice 先有一個 **RED**（失敗）測試，再寫 implementation 轉 **GREEN**，再 refactor。
      實作不得早於其失敗測試存在。
- [ ] **Capped loops（具名數值 cap，非口號）**：每個收斂/排程 loop 必須宣告 iteration cap，**無 unbounded /
      background loop**。binding 數值（沿用 `docs/dev-loops.md` 與 `docs/standards/test-and-acceptance.md` §5）：
      **Tier-1 修綠 loop cap ≈ 6；Independent Verifier findings→fix→re-verify cap = 5；同一 slice 的 adversarial
      re-review cap = 3**（連 3 次同類失敗 → 停下、寫 `docs/guardrails.md`、退一步重評 slice/架構）。各 phase 的
      收斂/conformance loop（如 P1 tamper 測試、P3 跨租 conformance）**繼承並沿用上述 cap**。
- [ ] **Deny-by-default + fail-closed everywhere**：malformed / missing context / internal error ⇒ `deny`，永不 `allow`。
- [ ] **Credentials 絕不**落到 workspace / logs / artifacts / snapshots / traces / fixtures；raw secret 不入 persistence 或 audit payload。
- [ ] **Pre-Commit Guard**（`.githooks/pre-commit`）跑 `pnpm run verify` 並 block 失敗 commit；**禁止 `--no-verify`**、禁止削弱測試/安全檢查。

### 0.2 Hard Constraint A — Low Coupling / High Cohesion（指令強制，非口號）

- [ ] **一模組一責任（high cohesion）**；無關 concern 不得混入。
- [ ] **只經 public surface 消費（low coupling）**：禁止 deep import 進別模組內部（`src/<mod>/index.ts` 之外的路徑）。
- [ ] **依賴 acyclic 且 inward-pointing**：`domain ← application ← adapters`；**零 dependency cycle**。
- [ ] **跨平面只走 typed contract**：TS control plane / Go evidence kernel / Python SDK / UI 之間僅以 **proto / Zod** 通訊，**絕不**碰彼此 internals。
- [ ] **11 層 concern 不外洩**（CLI/UI · orchestration · approval · tool registry · policy · credential · sandbox adapter · inference · audit · persistence · tenant/IAM）。
- [ ] **指令強制（這是 P0-S1 的交付物，之後每個 slice 繼承）**：
  - TS：**`dependency-cruiser`**（canonical script **`deps:check`** = `depcruise --config .dependency-cruiser.cjs src`，見 `SLICE-P0-003`）—— `forbidden` 規則 severity = `error`，違規 ⇒ 非零 exit；規則涵蓋「no-deep-import」「no-cycle」「no-cross-layer」「no-cross-plane-internal」。
    （備選 `eslint-plugin-boundaries`；本 repo 採 dependency-cruiser，因其同時驗 cycle + 邊界且原生輸出非零 exit。）
  - Python SDK：**`import-linter`**（`lint-imports`）—— `layers` + `forbidden` contract；違規 ⇒ 非零 exit。
  - Go evidence kernel：**`depguard`**（golangci-lint）+ **`internal/` package** 結構——非法 import ⇒ 非零 exit。
  - 上述每一個都**接進 `pnpm run verify`**（級聯）；邊界違規 = `verify` 紅 = 不可 commit。
  - **跨平面強制是「四工具聯集」，非單一工具：** dependency-cruiser 只看 TS import graph，**看不到** Go/Python/UI。
    因此跨 PLANE（TS↔Go↔Python↔UI）邊界 = `(TS depcruise no-cross-plane-internal)` ∪ `(Go depguard + internal/)`
    ∪ `(Python import-linter)` ∪ `(proto-only 契約 + buf breaking)` 的聯集；`pnpm run verify` 的級聯把這四者
    收斂為單一 exit code。`no-cross-plane-internal` 規則攔的是「TS 端 import 了另一平面的內部路徑」，另一側由各
    語言自己的工具與「只走 proto/Zod」結構保證。

### 0.3 Hard Constraint B — Per-Slice Adversarial Code Review（強制，merge 前）

- [ ] 實作以**小而可獨立驗證的 slice** 推進（見 [`docs/slices/`](./slices/) 規格）。
- [ ] **每個完成的 slice 必須通過對抗式 code review** —— reviewer 帶 **fresh context**，任務是**弄壞它**
      （試 break deny-by-default / fail-closed / audit completeness / credential non-leak / coupling boundary）。
- [ ] **不得僅憑 self-review 合併**；review findings 必須驅動 fix → re-verify → 再 review，直到 clean。
- [ ] **Coupling/Cohesion 是 review 的明確 blocking 維度**（不是只看正確性）。
- [ ] review 結論記錄於該 slice 檔案的 `## Adversarial Review` 區段（PASS/FAIL + findings + 解法）。

> **Definition of Done（每個 slice 套用，逐字對齊 AGENTS.md §Definition of Done）：**
> failing test 先存在 → `pnpm run verify` exit 0（附證據）→ Independent Verifier Pass = PASS →
> secret-scan clean → docs 更新 → dependency-boundary check 綠（無新 cross-module/cyclic dep）→
> **Adversarial code review = PASS** → 適用的 stage review gate 已跑。**沒有指令證明就不算 done。**

---

## 1. 全域對照表（一眼看懂 phase × app × pillar × P0 feature）

### 1.1 8 個 killer app → 由哪個 phase 交付

| App | 名稱 | 主交付 phase | 依賴的 P0 feature | 依賴的 pillar |
|---|---|---|---|---|
| **c24** | Local-First Per-Client Workstation（Personal beachhead / 載具） | **P2** | F1 audit sink · F3 redaction · F4 inference gate | 1,2,3,4,5,6,7 |
| **c6** | Agent Escrow / BYO-Agent-on-My-Data | **P3** | F1 · F2 AgentContext · F3 redaction | 2,5,7 |
| **c3** | Tenant-Sealed Agent Fleet | **P3** | F1 · F2 AgentContext | Enterprise tenant/IAM + 2,7 |
| **c1** | Oversight-of-Record（admissible WORM ledger） | **P4** | F1 · F2 · F3 · F4（全部） | 7（+3,4 餵料） |
| **c4** | Maker-Checker Runtime（by-construction SoD） | **P4** | F1 · F2 | 3,4,5,7 |
| **c20** | Sub-Delegation Firewall | **P5** | F1 · F2 · F4 | 3,5,2,7 |
| **c10** | Blast-Radius-Budgeted Change | **P5** | F1 · F2 | 3,4,5,6,7 |
| **c12** | Agent Chinese-Wall Runtime | **P5** | F1 · F4（per-side inference keying） | 2,3,5,7 |
| **c2** | Insurable Autonomy（旁生於 c1/c3 的唯讀投影） | **P4→持續** | F1 · F2 | 7（read-only projection） |

### 1.2 7 大 pillar → reuse / build / extend × 主要落地 phase

| Pillar | reuse/build/extend | 主要 phase | 元件 |
|---|---|---|---|
| 1. Agent hosting & task orchestration | **BUILD** | P2 | TS Governance Plane（XState Task/AgentSession/Artifact + resume ledger）；Python shim host 第三方 agent |
| 2. Secure sandbox & isolation | **REUSE**(+1 upstream) | P0/P2 | OpenShell adapter（TS drive）；Landlock `hard_requirement`（upstream Rust PR） |
| 3. Deny-by-default policy | **REUSE + BUILD** | P0→P5 | OpenShell OPA/Z3（PEP）+ TS PDP layer（tool/budget/SoD/delegation/inference-route） |
| 4. Human-in-the-loop approval | **EXTEND + BUILD** | P4 | 泛化 ApprovalRequest 引擎；maker≠checker by capability |
| 5. Credential & inference governance | **REUSE + BUILD**(+2 upstream) | P0/P3 | SecretResolver(reuse)+ lease lifecycle + redaction filter + per-route inference gate |
| 6. Tool registry & governed invocation | **BUILD** | P2 | Zod-typed ToolManifest/ToolInvocation registry |
| 7. Tamper-evident audit + Enterprise tenant/IAM | **REUSE + BUILD**(+1 upstream) | P1/P3 | OCSF(reuse) + Go evidence kernel(Tessera WORM + verifier)+ gateway-per-tenant + 跨租 conformance |

### 1.3 4 項 cross-app P0 feature（多旗艦共同硬依賴）→ 哪個 phase 起步、哪個 phase 完整

| 代號 | P0 feature | 起步 phase | 完整 phase | pillar | 服務 app |
|---|---|---|---|---|---|
| **F1** | Durable / append-only / hash-chained / signed WORM audit sink（+ standalone verifier + monotonic sequence + gap detection + transactional outbox） | **P1**（簡單簽章 log） | **P4**（Tessera + RFC-3161 錨定） | 7 | c1,c2,c3,c4,c6,c10,c11,c20,c24 |
| **F2a**（TS 側）| TS Governance Plane 的 **AgentContext mapping/projection**（actor/tenant/project/task/sandbox/request id + result，由 branded ids 投影） | **P0** | **P0**（`SLICE-P0-001` 完成且 enforced） | 7 | 全部 |
| **F2b**（OpenShell 側）| **OCSF schema 的 `tenant_uid`/AgentContext 欄位硬化**（Rust struct 實填，upstream PR） | **P0**（PR 啟動） | **P3**（upstream PR merge） | 7 | 全部 |
| **F3** | Enforced runtime credential / PII **redaction filter** | **P0**（TS 邊界）| **P3**（upstream Rust PR） | 5,7 | c1,c6,c11,c24 |
| **F4** | Per-route / per-model **inference policy gate**（deny-by-default，關 `inference.local` 繞過） | **P0**（Core-side interim + upstream PR 啟動） | **P3**（upstream merge） | inference | c11,c17,c18,c21,c24,c12 |

> **Swing-factor 提醒**（§4 詳述）：F3/F4 的「完整」依賴 **upstream Rust PR 真正 merge**（NVIDIA review queue，我方無 merge 權）。
> 因此 P0 立刻啟動 inference-gate + Landlock PR（lead time 最長），並以 **Core-side egress allowlist** 作 interim 緩解，
> 把 c6/c3/c12 的 isolation attestation **SKU gate 在實際 merge（不是 PR 提交）**。

---

## 2. Phase 0 — 延續 scaffold + 開 upstream PR + 把 hard constraint 接進 verify

> **目標**：在**不重寫** ~500 行 TS scaffold 的前提下，把後續所有 phase 的「邊界強制」與「F2 AgentContext / F3 redaction」基礎件做出來，
> 並啟動 lead-time 最長的 upstream Rust PR。**這是讓兩條 hard constraint「指令可驗證」的 phase——之後每個 slice 都繼承它。**
> **完整 slice 規格在 [`docs/slices/phase-0/`](./slices/phase-0/)（每個 slice 一檔，含 RED 測試、驗收指令、Adversarial Review 區段）。**

### Phase 0 退出條件（exit criteria — 全綠才進 P1）

- [ ] `pnpm run verify` exit 0，且 **verify 已級聯** dependency-boundary check（TS）+（若已建）Python/Go gate。
- [ ] 任一刻意製造的 cross-layer / deep-import / cyclic dependency **會讓 `pnpm run verify` 變紅**（有 RED 測試證明閘有效）。
- [ ] 每個 AuditEvent 帶完整 OCSF **AgentContext**（F2），缺欄位 fail-closed（已由 scaffold `createAuditEvent` 保證，補 mapping + 測試）。
- [ ] TS 邊界 **redaction filter**（F3）對已知 secret-shape 必 scrub；redaction 測試 + secret-scan 雙綠。
- [ ] 4 項 upstream Rust PR **已開啟並有追蹤檔**；inference-gate + Landlock 兩件**狀態 = in-review**；Core-side egress allowlist interim 已落地且有測試。
- [ ] 每個 Phase 0 slice 皆通過 **Adversarial Code Review = PASS**（記於各 slice 檔）。

### Phase 0 slice list（checklist；權威清單在 `docs/slices/phase-0/INDEX.md`）

> **權威來源：** Phase 0 的**可實作 slice 清單與每份 slice-doc 是 `docs/slices/phase-0/`（S0.1–S0.6），以
> 其 `INDEX.md` 的 DAG 為準**。本表是 roadmap 對那批 slice 的「feature 對照視圖」，**不另立第二套編號**：
> 下方每個 feature 都對映到一個既有 slice 檔，沒有對映到既有檔的 feature（verify polyglot 級聯、egress
> allowlist interim、upstream PR 追蹤）**標為「待新增 slice」**，須先依 `slice-spec.md` 範本補寫進
> `docs/slices/phase-0/` 後才可實作。
>
> **PREREQUISITE（block）：** `docs/slices/phase-0/` 的 slice-doc 是 Phase 0 實作的前置；**在對應 slice-doc
> 存在之前，不得開始該項 P0 coding**（這些 slice-doc 由 playbook 的 slice-authoring 步驟產出）。
>
> **規模紀律：** 每個 slice 都是「一個 RED → GREEN → adversarial review → merge」的最小單位；
> `SLICE-P0-003`（deps gate）依 `slice-spec.md` §9 是**硬性最先 merge** 的 blocking 前置。

| Feature（roadmap 視角）| 對映 slice 檔 | RED-first | 驗收指令 |
|---|---|---|---|
| **依賴邊界 gate（HARD A 指令化）** | [`S0.3`](./slices/phase-0/S0.3-deps-boundary-gate.md) | 刻意違規 fixture 使 `pnpm run deps:check` exit≠0；移除後 exit 0 | `pnpm run deps:check`；`pnpm run verify` exit 0 |
| **F2a：OCSF AgentContext mapping** | [`S0.1`](./slices/phase-0/S0.1-ocsf-agentcontext.md) | 缺任一 id → `parseAgentContext` / `createAuditEvent` throw | `pnpm test src/iam src/audit` |
| **canonical serialize + content-address（F1 前置）** | [`S0.2`](./slices/phase-0/S0.2-canonical-serialize-hash.md) | `canonical.ts` 不存在使 import 失敗（RED） | `pnpm test src/audit/canonical.test.ts` |
| **OpenShell adapter interface + fail-closed null adapter** | [`S0.4`](./slices/phase-0/S0.4-openshell-adapter-null.md) | module 不存在（RED）；null adapter deny-by-default | `pnpm test src/runtime/openshell` |
| **evidence-kernel v0 契約 + verifier skeleton（F1 起步）** | [`S0.5`](./slices/phase-0/S0.5-evidence-kernel-v0-contract.md) | tamper/reorder/gap/bad-sig → verifier broken | `pnpm test src/audit/kernel` |
| **PDP seed：deny-precedence** | [`S0.6`](./slices/phase-0/S0.6-pdp-layer-seed.md) | deny+allow 同 match → 期望 deny（先紅） | `pnpm test src/policy` |

**待新增 slice（feature 尚無對映檔，須先補 slice-doc 再實作）：**

- [ ] **F3：TS 邊界 credential/PII redaction filter（enforced，value-scanning）** → 須新增 `docs/slices/phase-0/S0.7-redaction-filter.md`（並更新 `INDEX.md` DAG）
  - **現況依據**：`src/audit/redact.ts` 目前**只 by-key redact**，value-scanning **尚未實作**（檔內自註）。
  - **RED-first**：把 canary 放進**非 secret-key 的 free-form 欄位**（`action`/`message`/`resource`）→ 期望輸出
    已 scrub（**先紅**，證明目前是 convention 非 enforced）→ 實作 value-scanning redactor 包住 serialize 出口 → 綠。
  - 驗收：`pnpm test`（redaction 測試綠）+ `pnpm run secret-scan` clean；canary 以 **runtime 組裝**避免被
    secret-scan 誤報（見 `docs/standards/test-and-acceptance.md` §3.2）。
  - **安全要點**：測試**不得**寫入真 secret，且 canary 完整 pattern 在靜止原始碼中不成形。
  - 對應 `docs/standards/engineering-standards.md` §7.3（已把 value-scanning 綁定為 RED-first slice，非開放 TODO）。
- [ ] **verify 成為 polyglot 級聯入口** → 須新增 `docs/slices/phase-0/S0.x-verify-cascade.md`
  - 內容：定義 `verify` 在 Go kernel（P1）/ Python SDK（P3）進場時如何級聯（`verify:go` / `verify:py`）。
  - **RED-first（此為 infra/governance slice，其 RED = 失敗的 contract 斷言）：** 先寫一條 contract 測試，
    斷言「`verify` script 串接了 `verify:go` / `verify:py`」——在 cascade 尚未串接時此測試**失敗（RED）**。
  - **佔位 script 必須 fail-closed，不得偽綠：** `verify:go` / `verify:py` 佔位**不得 no-op 退 0**（no-op 綠與
    真 gate 綠無法區分，會遮蔽缺口）。規則（對齊 `test-and-acceptance.md` §8/§9.2）：**該語言根目錄不存在 →
    skip exit 0；存在但缺設定檔 → fail-closed exit≠0**；且 P0-cascade 的 contract 測試須**同時**斷言
    「當語言 toolchain 存在卻缺 gate 設定時 cascade 會 fail」。
  - 驗收：`pnpm run verify` exit 0；contract 測試證明 cascade 已串接且對「存在卻缺設定」會 fail。
- [ ] **F4 interim：Core-side egress allowlist（deny-by-default）** → 須新增 `docs/slices/phase-0/S0.x-egress-allowlist-interim.md`
  - RED：未在 allowlist 的 egress 目標 → `evaluatePolicy` deny + auditRequired（沿用既有 deny-by-default 引擎）。
  - GREEN：以**現有** `src/policy/evaluate.ts` 模式新增 egress 規則型別（不另發明引擎，DRY；可建在 `S0.6` 之上）。
  - 驗收：`pnpm test src/policy`；deny-by-default 測試綠。
- [ ] **F2b + 其餘 upstream Rust PR 啟動 + 追蹤** → 須新增 `docs/slices/phase-0/S0.x-upstream-prs.md`
  - 內容：開 4 個 PR（inference-route gate、Landlock `hard_requirement`、OCSF tenant fields、redaction filter）；
    建 `docs/upstream/` 追蹤表（PR URL、狀態、interim 緩解、SKU-gate 依賴）。**inference-gate + Landlock 立刻送出**。
  - **RED-first（governance slice，其 RED = 失敗的 contract/存在性斷言）：** 先寫一條測試斷言
    「(a) `docs/upstream/` 追蹤檔存在且列出 4 PR，且 (b) adapter 對**未硬化** OpenShell 仍 fail-closed」——
    在追蹤檔與 fail-closed 測試尚未建立時**失敗（RED）**，再補齊轉綠。
  - 驗收：追蹤檔存在且列出 4 PR；CI 不依賴未 merge 的 upstream（contract 測試確認 adapter 對未硬化 OpenShell 仍 fail-closed）。
  - **非工程依賴**：merge 時程不可控 → 由 §4 swing-factor（SF5）管理。

> **RED-first 普適規則的兩個非程式 slice 例外說明（消除「universal RED-first 有兩個沉默違反者」的張力）：**
> 上述「verify 級聯」與「upstream PR 追蹤」是 **infra/governance slice**，沒有傳統的單元行為可測。它們**仍滿足
> test-first**：其「RED」是一條**失敗的 contract/存在性斷言**（cascade 未串接 → 測試紅；追蹤檔/ fail-closed
> 測試未建 → 測試紅），實作補齊後轉綠。§0.1 的「每個 slice 先有一個 RED」對它們**照常成立**，不是例外、不是豁免。

---

## 3. Phase 1–5 — Outline（slice 級 just-in-time，進入 phase 前才拆）

> 規則：每個 phase 開工前，先把該 phase 拆成 `docs/slices/phase-N/`（沿用 Phase 0 的 RED→GREEN→review checklist 格式），
> 再開始實作。**下方僅給 outline + 退出條件 + 對應 app/pillar/P0 feature**，避免過早把細節寫死。

### 3.1 Phase 1 — Go Evidence Kernel（F1 起步：最重 lift，gating c1/c2/c3/c4）

- **交付**：獨立進程 / 身分 / 語言的 **Go evidence kernel** —— **先簡後繁**：append-only hash-chain + Ed25519 簽章 + **standalone verifier** 先行；
  Governance Plane 與 OpenShell supervisor **只能 append**。加 **kernel-enforced monotonic per-source sequence + gap detection + transactional outbox**（ingest 完整性，使 attest-the-negative 誠實）。
- **app/pillar/feature**：F1（起步）；pillar 7；gating c1/c2/c3/c4。
- **hard constraint 落地**：Go 端 **depguard + `internal/` package** boundary 接進 `pnpm run verify:go`（由 P0-S2 契約承接）；
  kernel 與 control plane **僅以 gRPC ingest proto 通訊**（typed contract，零 internals 共享）。
- **退出條件（command-verifiable）**：
  - [ ] `pnpm run verify`（含級聯 `verify:go`）exit 0。
  - [ ] standalone verifier 對「被竄改的鏈」回非零 exit、對「完好鏈」回 0（黃金測試）。
  - [ ] 對抗式測試：control plane **無法**改寫已 append 的紀錄（嘗試即失敗 + 被 audit）。
  - [ ] sequence-gap 注入測試：丟一筆中間紀錄 → gap detection 報錯。
  - [ ] synchronous-commit-before-effect：先 commit 證據再放行副作用（有時序測試）。
  - [ ] 每個 slice Adversarial Review = PASS。

### 3.2 Phase 2 — Personal Beachhead c24（閉環、可 demo、無多租戶風險）

- **交付**：TS Governance Plane 串 **Approval Inbox + Task Timeline + Artifact + ToolManifest registry + credential lease lifecycle**，
  於單一本機 OpenShell + SQLite，host 一個**真實第三方 agent（Claude Code）**，事件落入 P1 evidence kernel。
- **app/pillar/feature**：**c24**；pillar 1,2,3,4,5,6,7；用 F1+F3+F4。
- **hard constraint 落地**：orchestration / approval / tool registry / credential 各為**獨立 cohesive 模組**，僅經 public surface 互通；
  Python shim 進場 → `import-linter` 接進 `verify:py`（P0-S2 契約承接），shim **marshaling-only / credential-blind**（測試斷言 shim 從不持有 secret）。
- **退出條件**：
  - [ ] `pnpm run verify`（含 `verify:py`）exit 0。
  - [ ] 端到端 demo 測試：起 task → 觸發 privileged action → 進 Approval Inbox → 批准 → lease 注入 → 事件入 kernel → timeline 可重建（一條 integration test，非自述）。
  - [ ] **Credential Non-Leak**：掃 workspace/logs/artifacts/timeline/SQLite，無 secret-shape（自動化測試）。
  - [ ] **Task Resume Idempotency**：中斷再 resume，外部副作用不重複、audit 不遺失。
  - [ ] **Tool Registry Contract**：每個註冊 tool 有 name/version/in·out schema/required perms/side-effect class/timeout/audit behavior/docs（schema 驗證測試）。

### 3.3 Phase 3 — Enterprise Lighthouse：c6 Agent Escrow + c3 Tenant-Sealed Fleet（平行 design partner）

- **交付**：
  - **c6 Escrow**：reuse OpenShell no-leak + deny-egress；Python shim host vendor untrusted agent（credential-blind）；
    客戶擁有 **kernel 簽發的 signed execution receipt** + **declared-vs-actually-used scope diff**。
  - **c3 Fleet**：**gateway-per-tenant**（進程/namespace 邊界，**非 `tenant_id` row filter**）+ per-tenant Postgres + per-tenant-keyed kernel partition；
    **release-blocking 跨租 conformance suite** 產品化為 **per-customer signed isolation attestation**。
  - F3/F4 upstream PR 在此 phase **目標 merge**；未 merge 前 isolation attestation SKU **gate 在 merge**。
- **app/pillar/feature**：**c6 + c3**；Enterprise tenant/IAM + pillar 2,5,7；用 F1+F2+F3。
- **hard constraint 落地**：per-tenant 是**進程/namespace 邊界**（結構性低耦合）；evidence kernel **per-tenant 獨立 Merkle tree + 獨立簽章 key**。
- **退出條件**：
  - [ ] `pnpm run verify` exit 0。
  - [ ] **Tenant Isolation conformance suite = release-blocking**：tenant A 嘗試讀/寫 tenant B 的 task/credential/log/sandbox/policy/artifact **全部 denied + audited**（指令回非零代表 release 被擋）。
  - [ ] c6：execution receipt 可由 standalone verifier 驗章；scope-diff 測試（declared ⊇ used）。
  - [ ] c6：vendor agent egress deny-by-default，phone-home 被擋（對抗式測試）。
  - [ ] **「受管路徑唯一」** admission/sealed-launch gate：在 managed entrypoint 之外啟動 runtime 被堵（bypass 對抗式測試 = release gate）。
  - [ ] attestation 措辭綁定 **enforcement-tier-in-force**（container vs libkrun microVM；非-Landlock kernel fail-open 須標明）。

### 3.4 Phase 4 — 最高 ACV 旗艦：c1 Oversight-of-Record + c4 Maker-Checker（建在成熟 spine 上）

- **交付**：
  - **F1 升級為完整 Tessera tile log + RFC-3161 / transparency-log 外部錨定 + WASM verifier**（at this point F1「完整」）。
  - **c1**：Decision Record 物件 + deterministic **decision-path replay**（重放決策路徑、非重抽模型）+ EU AI Act / SR-11-7 / SEC 17a-4 evidence export + **attest-the-negative**。
  - **c4**：**capability-possession SoD**（proposer 結構上拿不到 approve）+ dual-control（maker≠checker）+ amount/beneficiary-bound L7 body-match + SOX/PCAOB non-repudiable approval receipt。
  - **c2**（旁生）：evidence kernel 的 deployer-independent signed telemetry **唯讀投影** + WASM verifier 讓 insurer 自瀏覽器 re-verify。
- **app/pillar/feature**：**c1 + c4（+ c2 投影）**；pillar 3,4,5,7；用 F1+F2+F3+F4（全部）。
- **退出條件**：
  - [ ] `pnpm run verify` exit 0。
  - [ ] WASM verifier 在「不信任平台」前提下 re-verify 鏈+簽章+外部錨點（黃金測試 + 竄改回非零）。
  - [ ] decision-path replay **deterministic**：同輸入同決策路徑（重放測試）。
  - [ ] **c4 by-construction**：同一 AgentSession/credential 若 PROPOSE 則**無法取得** APPROVE capability（不是 if-check；property-based + 對抗式測試證明無繞過）。
  - [ ] **Approval UX consistency**：每個 privileged action → human-readable ApprovalRequest（actor/task/resource/action/risk/policy reason/expiration/scope 齊全）。
  - [ ] **Audit Completeness**：sensitive event 帶齊 OCSF AgentContext + result（schema 測試）。

### 3.5 Phase 5 — 最大 net-new scope（最後）：c20 + c10 + c12

- **交付**：
  - **c20 Sub-Delegation Firewall**：attenuation-only **capability algebra（child ⊆ parent）** + per-hop scoped lease + sandbox-per-sub-agent + per-hop 事件入 kernel；
    **property-based + 對抗式測試**證明無升權 / 無竊取 sibling secret（考慮把 lattice kernel 形式化）。
  - **c10 Blast-Radius-Budgeted Change**：stateful **consumable blast-radius budget** + ToolManifest estimator + pre-execution effect estimator（查 live infra，**不確定即保守 fail-closed**）+ idempotent resume ledger；over-budget **by construction DENY**。
  - **c12 Agent Chinese-Wall**：**Side/Wall 一級隔離域（高於 tenant）** + **per-side 分區 governed memory/vector store（最大 net-new 子系統）** + per-side inference keying（依賴 F4）+ hash-chained per-session access log 上的 signed **non-contamination** 報告。
- **app/pillar/feature**：**c20 + c10 + c12**；pillar 2,3,4,5,6,7；用 F1+F2+F4。
- **退出條件**：
  - [ ] `pnpm run verify` exit 0。
  - [ ] **c20**：對抗式測試證明 child capability **永遠 ⊆ parent**，且 sub-agent **無路徑**碰 sibling/parent credential（嘗試即 deny + audit）。
  - [ ] **c10**：over-budget 動作 **by construction 不可能**（property-based 測試）；estimator 不確定 ⇒ fail-closed（只降自主性、不降安全）；resume 不 double-apply。
  - [ ] **c12**：跨 side 存取 by construction deny + 升為 wall-crossing 合規事件；non-contamination 報告**僅在 OS-enforced channel 成立**（措辭限定 + tier-bound）。
  - [ ] 三個子系統各為**獨立 cohesive 模組**；governed memory store 經 public surface 消費（boundary check 綠）。

---

## 4. Swing Factors（需使用者 / design-partner 拍板；每個答案把 roadmap 推向哪個方向）

> 這些是**工程無法解決**的不確定性。它們決定 phase 排序、SKU gate、甚至 moat 是否成立。**在擴大投入前必須拍板。**

- [ ] **SF1 — 團隊母語 / 招募池（最大 swing，影響全 phase 語言投入）**
  - TS-heavy 小團隊求最快 time-to-first-app ⇒ **強化現推薦**（TS 核心 + Go kernel 一個專責 hire）。
  - Rust-heavy 且能吃 velocity 前置稅 ⇒ 推向 Rust spine，但 **audit kernel 仍留 Go**（生態系事實不變）。
  - Python/ML-heavy ⇒ 推向 Python 核心，代價是 typed-invariant 與 per-tenant 隔離須額外硬化。
  - **影響**：決定 P1（Go kernel hire 時程）與 P2/P3 SDK 主從。
- [ ] **SF2 — 誰是整合者 / 買方（影響 SDK 主從，P2/P3）**
  - 主要買方在 Python（data/ML、c6 vendor）⇒ 維持 **Python primary SDK**（現預設）。
  - 主要買方在 TS/platform（c10 SRE、c3 MSP）⇒ 把 **TS SDK 升 primary**。兩者皆生成；預設 Python primary 因 agent 生態系在 Python。
- [ ] **SF3 — attestation 可採信度（非工程，最大不確定性；押 c1/c2/c3/c4 全部價值）**
  - signed claim 必須是「資產而非負債」。**必須**在擴大投入前找 design-partner 的 outside counsel / auditor / E&O insurer 審視 attestation 措辭與 evidence bundle。
  - **答案為「不可採信」⇒ 推翻整個 moat 論述、迫使重估產品定位**——任何架構都無法靠工程解決。**這是 P3/P4 開工前的硬 gate。**
- [ ] **SF4 — 首個 Enterprise lighthouse 二選一（c6 vs c3，影響 P3 順序）**
  - 簽到願把 image 送進客戶 perimeter 的 vendor ⇒ 先 **c6**（最高 conviction）。
  - 先有 MSP/SaaS BYO-agent 買方 ⇒ 先 **c3**（最可行、最 on-thesis）。兩者共用 P0/P1 基底，順序由 design-partner 可得性決定。
- [ ] **SF5 — upstream Rust PR merge 時程（不可控，影響 F3/F4「完整」與 c6/c3/c12 SKU）**
  - PR 在 NVIDIA review queue、我方無 merge 權 ⇒ **P0 立刻送 inference-gate + Landlock**；以 Core-side egress allowlist interim 緩解；
    **isolation attestation SKU gate 在實際 merge（不是 PR 提交）**，且 attestation 措辭綁 enforcement-tier-in-force。

---

## 5. 進度索引（live status — 只反映指令證明過的事實）

> 規則：此表只在對應 `pnpm run verify`（或該 phase 退出條件指令）**綠燈**後才打勾。**禁止樂觀打勾。**

| Phase | 範圍 | 狀態 | 證明指令 |
|---|---|---|---|
| **P0** | scaffold 延續 + boundary gate + F2/F3 + upstream PR 啟動 | ☐ 進行中 | `pnpm run verify` exit 0 + boundary RED fixture 證閘有效 |
| **P1** | Go evidence kernel（F1 起步 + verifier + 完整性） | ☑ **DONE** — S1–S7 + S6a merged；六條退出條件 `pnpm run verify:p1-exit` 綠 | `pnpm run verify`（含 `verify:go`）+ `pnpm run verify:p1-exit`（6/6） |
| **P2** | Personal beachhead c24 | ☐ 未開始 | 端到端 demo test + non-leak 掃描 + resume idempotency |
| **P3** | c6 Escrow + c3 Fleet（Enterprise lighthouse） | ☐ 未開始 | release-blocking 跨租 conformance + 受管路徑唯一 bypass 測試 |
| **P4** | c1 Oversight + c4 Maker-Checker（+ F1 完整 + c2 投影） | ☐ 未開始 | WASM verifier 竄改測試 + c4 by-construction property test |
| **P5** | c20 + c10 + c12 | ☐ 未開始 | capability-algebra 對抗式測試 + over-budget by-construction DENY |

---

*本路線圖為 evidence-based 規劃。每個交付物皆 command-verifiable；兩條 hard constraint（low-coupling/high-cohesion 經 dependency-cruiser/import-linter/depguard 強制；per-slice adversarial review 為 merge 前 gate）與 Looping Engineering（`pnpm run verify` 單一真相、TDD、capped loops、deny-by-default、credential non-leak）為每個 phase/slice 的隱含驗收條件。Phase 0 已拆 slice（`docs/slices/phase-0/`）；Phase 1–5 slice 級拆解 just-in-time。不含任何 secret-like 值。*
