# Agent OS — Build Playbook 索引（docs/）

> 本檔是 Agent OS build playbook 的**總目錄**，把「**標準（standards）／設計（design）／路線圖（roadmap）／
> slices**」四個分冊串成一條可執行的路徑，並連結每一份文件。
> **權威契約：[`../AGENTS.md`](../AGENTS.md)。任何衝突，`AGENTS.md` 勝出。** 語言：繁體中文，保留英文技術術語。
> 日期：2026-06-19。

---

## 0. 三條貫穿全 playbook 的不可協商規則（每份文件都在強制）

1. **只信指令輸出（only command output is truth）。** 沒有綠燈指令的 exit code，就**不存在** done/works/secure；
   self-reported 一律不採信。唯一真相來源是 **`pnpm run verify`**（現況 = `typecheck && lint && build && test
   && secret-scan`；`SLICE-P0-003` 後加入 `deps:check`）。
2. **HARD CONSTRAINT A — Low coupling / high cohesion。** 一模組一責任、只經 public surface 消費、acyclic
   inward 依賴、平面間只走 typed contract；**由 dependency-boundary check（TS `deps:check` = dependency-cruiser、
   Python import-linter、Go depguard+`internal/`）wired 進 verify 強制**，違規 → verify 非零，**且**是 adversarial
   review 的阻斷維度。
3. **HARD CONSTRAINT B — Per-slice adversarial code review。** 每個 slice merge 前必過一位 fresh-context、
   refute-by-default、職責是「弄壞它」的 reviewer = PASS；**No slice merges on self-review alone。**

> **TARGET vs CURRENT（全 playbook 統一語意，杜絕把「將會綠」讀成「現在綠」）：** **CURRENT** = 今天即可跑
> （已用 2026-06-19 `package.json` / `scripts/` 核實）；**TARGET / PENDING-SCAFFOLD** = 指令或檔案（`deps:check`、
> `.dependency-cruiser.cjs`、`proto/`、`kernel/`、`sdk/python/`、`conformance`、`test:ingest` …）**尚未存在**，
> 隨指定 slice 以 TDD 落地，**落地前不可當已綠**。

### Canonical 名詞與 script（避免跨文件歧義）

| 概念 | Canonical 名 | 別名（以 canonical 為準） |
|---|---|---|
| TS 依賴邊界 script | **`deps:check`**（= `depcruise --config .dependency-cruiser.cjs src`） | `deps`、`boundaries`（TS 腿） |
| 跨語言依賴邊界聚合 | **`boundaries`**（= `deps:check`＋Py import-linter＋Go depguard） | — |
| deps gate 落地 slice | **`SLICE-P0-003`** | roadmap 舊稱 P0-S1 |
| F2（OCSF AgentContext）| **F2a**（TS 投影，P0 完成）＋ **F2b**（OpenShell OCSF 欄位硬化，P3 upstream merge） | — |

---

## 1. 標準（`standards/`）— 規則與驗收的權威細則

| 文件 | 作用 | 強制了什麼 |
|---|---|---|
| [`standards/engineering-standards.md`](./standards/engineering-standards.md) | **Polyglot 工程標準**：六條技術線、per-language verify gate、11 層 + inward 方向、typed-schema（Zod/proto）規則、安全不變量 → build rules、依賴政策、§10 Acceptance 矩陣（每格標 LIVE / PENDING-SCAFFOLD） | HARD A 的 per-language 具體工具與 config（含 barrel-migration 的 binding ordering）；安全不變量的可驗收化 |
| [`standards/slice-spec.md`](./standards/slice-spec.md) | **SLICE 規範**：SLICE 定義、尺寸硬上限、生命週期（DRAFT→RED→GREEN→VERIFY→ADVERSARIAL REVIEW→MERGE）、可複製 slice-doc 範本、slice DAG/phase 排序 | 「一個 slice 長什麼樣」；deps gate 為 DAG 硬性前置 + manual-proof interim 的 auto-void/封頂 |
| [`standards/adversarial-code-review.md`](./standards/adversarial-code-review.md) | **對抗式 code review 標準（HARD B）**：fresh-context 硬定義、八個攻擊面、結構化 verdict 模板、MERGE GATE、與 Independent Verifier / Codex gate 的分層 | 「一個 slice 如何被 BREAK 過才准 merge」；工具缺席 = MAJOR-with-tracking（非死鎖）、跑不出指令 = BLOCKED、核心安全四面 N/A 反濫用 |
| [`standards/test-and-acceptance.md`](./standards/test-and-acceptance.md) | **測試策略與驗收標準**：TDD 可稽核三步、測試分類學、per-pillar release-blocking conformance（含 6-sink credential non-leak）、TS↔Go ingest 完整性、Independent Verifier Pass、coverage 地板、跨語言 gate 編排 | 每條驗收 → 可執行指令；canary runtime-組裝；no-op/fail-closed 偵測契約；conformance/test:ingest 的 bootstrap RED-first stub 規則 |

> 四份標準互引一致：slice-spec ↔ adversarial-code-review（slice 定義 ↔ break 流程）；engineering-standards §9 /
> test-and-acceptance §6–§7 ↔ adversarial-code-review（per-slice merge gate）；三者共用同一組 cap（Tier-1 修綠 ≈6、
> Independent Verifier =5、adversarial re-review =3）。

---

## 2. 設計（`design/`）— 可建構的架構

| 文件 | 作用 |
|---|---|
| [`design/architecture.md`](./design/architecture.md) | **Two-Plane Polyglot 可建構設計**：TS Governance Plane（PDP）驅動原封不動 OpenShell（PEP）+ 獨立進程/身分的 Go Evidence Kernel（WORM）；11-layer map + inward 依賴 + **acyclic 證明（ports∈domain 為 load-bearing 前提）**；agent-agnostic Zod domain model；TS↔Go append-only ingest 契約；OpenShell adapter chokepoint；enforcement-tier-in-force attestation binding；proto/Zod single-source；deployment topology；§0 Acceptance 表標 CURRENT/TARGET；§11 slice 順序總覽（S4/S5 須拆，展開為 `design/slices/` 的 slice-doc）+ HARD B merge-gate 機制 |

---

## 3. 路線圖（`roadmap.md`）— Phase 0–5

| 文件 | 作用 |
|---|---|
| [`roadmap.md`](./roadmap.md) | **Phase 0–5**：8 killer app × 7 pillar × 4 cross-app P0 feature（F1 WORM sink / F2a+F2b AgentContext / F3 redaction / F4 inference gate）對照表；§0 把 Looping Engineering + 兩條 hard constraint 設為每個 checkbox 的隱含驗收條件（含具名 cap 數值）；Phase 0 拆成指向 `slices/phase-0/` 的 feature 對照視圖（不另立第二套編號）+「待新增 slice」清單；Phase 1–5 outline（slice 級 just-in-time）；§4 swing factors；§5 live status（禁樂觀打勾） |

---

## 4. Slices（`slices/`）— 可實作的最小單位

| 文件 | 作用 |
|---|---|
| [`slices/phase-0/INDEX.md`](./slices/phase-0/INDEX.md) | **Phase 0 slice 權威清單 + DAG（鄰接表，無 cycle）+ 共同 DoD + §2.1 共同規則**（EXECUTION-TIME EVIDENCE 標記、first-RED 真實捕獲、per-slice loop cap、canary sentinel）；列出尚待補的 S0.7（F3 redaction）等 |
| [`slices/phase-0/S0.1-ocsf-agentcontext.md`](./slices/phase-0/S0.1-ocsf-agentcontext.md) | OCSF AgentContext 完成於 ids + AuditEvent（DAG 起點；**不** block S0.6） |
| [`slices/phase-0/S0.2-canonical-serialize-hash.md`](./slices/phase-0/S0.2-canonical-serialize-hash.md) | AuditEvent canonical serialization + content-addressed hashing（F1 前置） |
| [`slices/phase-0/S0.3-deps-boundary-gate.md`](./slices/phase-0/S0.3-deps-boundary-gate.md) | **把 `deps:check` 接進 `pnpm run verify`（HARD A 指令化；Phase 0 最先 merge 的硬性前置）** |
| [`slices/phase-0/S0.4-openshell-adapter-null.md`](./slices/phase-0/S0.4-openshell-adapter-null.md) | OpenShell adapter interface + fail-closed null adapter（結構性無 egress）+ mock contract tests |
| [`slices/phase-0/S0.5-evidence-kernel-v0-contract.md`](./slices/phase-0/S0.5-evidence-kernel-v0-contract.md) | evidence-kernel v0 TS 契約 + standalone verifier skeleton（釘 genesis prevHash / entryHash / checkpoint 簽章範圍，供 P1 Go conformance） |
| [`slices/phase-0/S0.6-pdp-layer-seed.md`](./slices/phase-0/S0.6-pdp-layer-seed.md) | PDP seed：`evaluatePolicy` 多 rule 來源 + deny-precedence（wildcard-only deny 語義已在 §3 拍板，fail-safe） |

> **待補（依 slice-spec 範本補寫進本目錄並更新 INDEX DAG）：** `S0.7-redaction-filter.md`（F3 value-scanning，
> RED-first）、verify polyglot 級聯入口、upstream Rust PR 啟動/追蹤（後兩者為 infra/governance slice，
> 其 RED = 失敗的 contract/存在性斷言）。

---

## 5. 上游脈絡（`research/`，事實依據）

playbook 的事實前提與決策理由見研究索引 [`research/README.md`](./research/README.md)：
[`architecture-approach.md`](./research/architecture-approach.md)（Two-Plane Polyglot、phase sequencing）、
[`opportunities.md`](./research/opportunities.md)（8 killer app）、[`openshell.md`](./research/openshell.md)（adapter
chokepoint、OCSF 缺口、enforcement tier）、[`loops.md`](./research/loops.md)、
[`decision-integration-strategy.md`](./research/decision-integration-strategy.md)。
開發 loop 體系見 [`dev-loops.md`](./dev-loops.md)；重複失敗的護欄記錄見 [`guardrails.md`](./guardrails.md)。

---

## 6. 建議閱讀順序

1. **新貢獻者**：本檔 §0 → `standards/slice-spec.md` → `standards/adversarial-code-review.md` →
   `standards/engineering-standards.md` → `standards/test-and-acceptance.md`。
2. **要動手實作**：`roadmap.md`（定位 phase）→ `slices/phase-0/INDEX.md` → 對應 `S0.x` slice-doc →
   依其 §5 RED-first、§6 DoD、§7 lifecycle 執行。
3. **要理解架構**：`research/architecture-approach.md` → `design/architecture.md`。

> **每份文件皆不含任何 secret-like 值。每條驗收準則皆以可執行指令的 exit code 為唯一真相；自述不被接受。**
