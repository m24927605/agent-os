# Agent OS 研究索引

> 本目錄收錄「基於 NVIDIA OpenShell 開發 Agent OS」的前期研究。所有結論以**實際原始碼勘查**為依據（OpenShell clone 於 `/tmp/openshell`、NemoClaw 於 `/tmp/nemoclaw`），並經**對抗式驗證**，凡 refuted / uncertain 之處皆明示。研究由多位 Staff+ agent 並行產出。

## 文件

| 文件 | 主題 | 一句話結論 |
|---|---|---|
| [openshell.md](./openshell.md) | NVIDIA OpenShell 作為 Agent OS 基礎的研究與採用評估 | OpenShell 是成熟、deny-by-default、single-trust-domain 的 sandbox runtime + control plane：**sandbox / policy / credential / inference / audit 可直接 reuse**；**multi-tenant、Task/Tenant/AgentSession/ToolManifest、durable tamper-evident audit 必須自建**。 |
| [loops.md](./loops.md) | loops.elorm.xyz loop 範本庫對 Agent OS 的對應與採用 | 該站 40 個 loop 全是通用工程用途、**無任何安全 loop**；對我們有價值的是其 `trigger→feedback gate→exit→iteration cap` 的**機制**，可把我們 8 個 security custom loop 落地成有界、deny-by-default、idempotent 的「hook 防止 + /loop/cron 驗證」組合。 |

## 對抗式驗證的關鍵發現（誠實標註）

| 宣稱 | 結果 | 重點 |
|---|---|---|
| 網路 egress deny-by-default | ✅ **confirmed** | netns+veth 強制走 proxy、nftables LOG+REJECT、Rego `default network_action="deny"`，跨多層驗證。 |
| 檔案存取 deny-by-default（建立時鎖定） | ✅ **confirmed**（有 caveat） | policy 層為 allowlist；但 Landlock 預設 `best_effort`，在無 Landlock kernel（pre-5.13、gVisor、macOS Docker Desktop）會 **fail-open**，須 `hard_requirement` 才硬性保證。 |
| Credentials 絕不落地 sandbox FS | ✅ **confirmed** | gateway 儲存、child 只看到 placeholder、egress proxy 才注入真值、fail-closed、config loader 拒絕 SecretInFile。 |
| Agent 無法讀 host 檔 / 逃逸隔離 | ❌ **refuted（作為絕對保證）** | container 層刻意弱（root + 寬 caps + apparmor=unconfined）；Landlock best_effort fail-open。是分層緩解，非「by construction 不可能」。 |
| 跨租戶存取 by construction 不可能 | ❌ **refuted（作為多租戶保證）** | 僅因「只有一個 tenant」。無 Tenant 物件、global RBAC、`objects` table 無 tenant column、`ListSandboxes` 無 caller filter。 |
| Policy 決策 / lifecycle 以 OCSF 記錄 | ✅ **confirmed**（有 caveat） | OCSF v1.7.0 已實作；但 audit-of-record **不 durable**（JSONL 預設 OFF、gateway buffer in-memory、無 signing/hash-chain）。 |

## 整合策略決策：策略 B（已採用，2026-06-19）

**決定：採用策略 B —— Agent OS 作為 OpenShell 之上的獨立層（不 fork OpenShell）。** 完整 A/B 對照與後果見 [decision-integration-strategy.md](./decision-integration-strategy.md)。多租戶採 gateway-per-tenant；僅「強制路徑內部」的少數安全強化以 upstream PR 形式回饋 OpenShell。

第一步前置：**這個 repo 目前是空骨架**（僅 `docs/research/`，無原始碼/package manifest/測試框架），需先初始化最小專案骨架（語言/測試框架）。下方保留當初的 A/B 對照供參：

- **策略 A — Fork / extend OpenShell（在其 Rust workspace 內）**：第一步 = `openshell.md §9` 的 *OCSF `AgentContext` 擴充 PoC*（把 tenant_id/project_id/task_id/request_id/actor_id 注入每個 audit event；schema 已定義 `tenant_uid` 僅需填值）。驗證：`cargo test/clippy/build -p openshell-ocsf`。
- **策略 B — 在 OpenShell 之上建一層（透過 gRPC `proto/openshell.proto` / Python SDK，NemoClaw 模式）**：第一步 = `loops.md §8` 的 *#3 Credential Non-Leak pre-commit hook*（canary scanner 只回位置不回值 + capped `/loop`）。前置 = 先初始化最小專案骨架。

> 建議：**Personal Agent Workstation 走策略 B（最快、最小侵入）**；**Enterprise 的 multi-tenancy 不要硬塞進單一 gateway**，傾向 gateway-per-tenant / namespace-per-tenant（見 `openshell.md §7`）。

## 來源與方法

- Ground truth：`/tmp/openshell`（OpenShell，Rust，~19 crates）、`/tmp/nemoclaw`（NemoClaw 參考棧，TypeScript/Python）。
- 補充：官方文件 `docs.nvidia.com/openshell`。
- 方法：8 維度並行深讀 + 6 個安全不變量 + 低信心宣稱的對抗式驗證 + 綜整。loops.elorm.xyz 窮舉 40 loop、抽樣驗證 5 個。
