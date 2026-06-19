# 決策紀錄：Agent OS 與 OpenShell 的整合策略

- **狀態**：已採用（Accepted）
- **日期**：2026-06-19
- **決定**：**策略 B —— Agent OS 作為 OpenShell 之上的獨立層（不 fork OpenShell）**
- **相關研究**：[openshell.md](./openshell.md)、[loops.md](./loops.md)、[README.md](./README.md)

---

## 背景（Context）

我們要在 NVIDIA OpenShell 之上開發 Agent OS（Personal Agent Workstation + Enterprise Agent Runtime Platform）。研究（基於對 `/tmp/openshell`、`/tmp/nemoclaw` 的真實原始碼勘查 + 對抗式驗證）確認：OpenShell 的 sandbox 隔離 / policy / credential / inference / audit 成熟可直接 reuse，但它**沒有** Task / Tenant / AgentSession / ToolManifest 等領域物件，且**不是多租戶平台**。

核心問題：**OpenShell 沒有的物件，要長在它的 object store 裡（A），還是長在我們自己的 store 裡（B）？**

## 選項

### A — Fork / Extend（修改 OpenShell 的 Rust 原始碼）
在 `crates/`、`proto/`、`migrations/` 內直接加新概念與新 RPC（`#[rpc_authz]/#[rpc_auth]` proc-macro），新物件存進 OpenShell 的 `objects` table（須遵守其編譯期 CAS 契約）。

### B — Layer above（不改 OpenShell，從外部驅動）✅ 採用
OpenShell 當成現成 binary/容器跑起來；Agent OS 是獨立進程，透過 gRPC（`proto/openshell.proto`，~50 RPC）/ Python SDK / CLI subprocess 驅動它。新領域物件活在 Agent OS 自己的 store。NemoClaw 已證明此模式可行（`build-context.ts:88` 以子進程呼叫 `openshell` CLI）。

```
┌─────────────────────────────────────────────┐
│  Agent OS（獨立進程）                          │
│  Task/AgentSession/Artifact orchestration      │
│  ToolManifest/ToolInvocation registry          │
│  Approval inbox · 自有 store（含 tenant_id）    │
└───────────────┬─────────────────────────────┘
                │ gRPC / Python SDK / CLI subprocess
                ▼
┌─────────────────────────────────────────────┐
│  OpenShell（原封不動）                          │
│  Gateway · Supervisor · Policy proxy · Router  │
│  → sandbox 隔離、deny-by-default、cred 注入     │
└─────────────────────────────────────────────┘
```

## 決策理由（Rationale）

1. **90% 的 Agent OS 工作天生在 OpenShell「之上」**（orchestration、tool registry、approval inbox、task timeline、tenant routing），B 做最快、最小侵入。
2. **多租戶最強隔離 = gateway-per-tenant（B）**，靠進程/容器邊界，而非在共用 gateway 內把 `tenant_id` 硬塞進 global RBAC 與無 tenant column 的 `objects` table（A 侵入性大、漏一個 handler 即破功；驗證已 refuted 現狀不成立）。**B 同時適用 Personal 與 Enterprise。**
3. **升級無痛**：OpenShell 仍 alpha（連 NemoClaw 都把它 pin 在 min==max==0.0.44 + image digest）。A 在 alpha 上維護 fork = 長期付 rebase 稅；B 只需在介面穩定區間 pin 版本。
4. **語言自由**：B 可用 TypeScript/Python（NemoClaw 即是），不被 OpenShell 的 Rust（edition 2024）綁住。

## 後果（Consequences）

### 正面
- 程式碼落點清晰、可獨立演進與測試；升級 OpenShell 風險低。
- 多租戶以進程邊界天然隔離，cross-tenant「不可能 by construction」較易成立。

### 負面 / 限制
- **有一小撮工作逃不掉 A/upstream**：活在 OpenShell 強制路徑「內部」的安全強化，B 從外面碰不到，必須改 Rust——**且應以 upstream PR 形式，而非長期 fork**：
  1. 強制 Landlock `hard_requirement` 預設（修正 best_effort fail-open）。
  2. per-request inference route policy gate（`inference.local` 刻意繞過 OPA）。
  3. runtime credential-redaction filter（包住 `OcsfJsonlLayer`）。
  4. OCSF audit event 填 `tenant_uid`/`task_id`/`request_id`/`actor_id`（從 supervisor 內部 emit）。
- 必須確保「受管路徑唯一」：在 OpenShell managed entrypoint 之外啟動的 runtime 會喪失 policy/credential 注入，Agent OS 須讓受管路徑成為唯一路徑。

## 邊界（採用 B 的明確規則）
- **預設不改 OpenShell 原始碼。** 需要的能力先問：能否用現有 gRPC/SDK/CLI + 自建 sidecar 達成？
- 確認屬「強制路徑內部」才考慮改 Rust，且**優先 upstream PR**；撐不住才開短期、有明確收斂計畫的 fork。
- 多租戶採 **gateway-per-tenant / namespace-per-tenant**，不做共用 gateway + tenant_id 過濾。

## 第一步的影響
B 的第一步前置：repo 目前是空骨架，需先初始化最小專案骨架（語言/測試框架），再實作最小安全任務（候選：`loops.md §8` 的 #3 Credential Non-Leak gate，或 `openshell.md §9` 的 AuditEvent context 等價物落在自有 audit 層）。實作方案由 Codex brainstorm 探索後另行記錄。
