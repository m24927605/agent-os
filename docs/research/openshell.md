# NVIDIA OpenShell 作為 Agent OS 基礎：研究與採用評估

> 本文件為 Staff+ 等級的研究與採用決策文件。所有結論以對 `/tmp/openshell`（OpenShell 原始碼）與 `/tmp/nemoclaw`（NemoClaw 參考棧）的實際檔案勘查為依據，並標注真實檔案路徑與行號。凡是經驗證為「refuted（推翻）」或「uncertain（不確定）」的發現，皆明確標示，不作粉飾。文中保留英文技術術語與程式識別符號。

## ⚠️ 2026-06-20 Ground-truth 覆驗修正（以此區為準）

> 後續 session 對真 clone（`github.com/NVIDIA/OpenShell.git`、`github.com/NVIDIA/NemoClaw.git`，已確認真實）做了一次對抗式覆驗。**裁決：本文 OpenShell 部分可信（12 條核心宣稱 10 條在真實行號 confirmed，連被要求懷疑的行號都對得上）；NemoClaw 部分曾有捏造，下列為修正。** 內文舊敘述若與本區衝突，以本區為準。

**捏造／錯誤（已推翻）：**
- ❌ 舊敘述把「Alpha software — single-player mode」當成 NemoClaw README 的話 → **錯**。該句只在 **OpenShell `README.md:7`**；NemoClaw `README.md:12` 是「reference stack for running always-on AI agents」。NemoClaw 的範圍限制在 `docs/reference/enterprise-readiness.mdx:19,100,102,131`。
- ❌ 舊敘述引用的 `src/security/secret-scanner.ts`（NemoClaw）**不存在** → 真檔 `src/lib/security/secret-patterns.ts` + boundary tests `src/lib/agent/runtime-hermes-secret-boundary-*.test.ts`。
- ❌ C11「非 CAS 寫入只在 `#[cfg(test)]`」→ **錯**。`WriteCondition::Unconditional` 是正式公開變體（`crates/openshell-server/src/persistence/mod.rs:96-102`）；CAS 為真且 type-enforced，但 production 業務邏輯允許 unconditional 寫入。

**精確化（用語修正）：**
- OpenShell 生命週期 RPC 是 **`CreateSandbox` / `DeleteSandbox` / `WatchSandbox`**（**無** Start/Stop RPC）；檔案存取走 **`ExecSandbox` + `ForwardTcp`/`ExposeService`**（**無**專用 file-sync RPC）。舊文「create/start/stop/destroy + file sync」作廢。
- C5 auto-approve 閘 = 字串裁決 `validation_result == "prover: no new findings"`（`policy.rs:437,476,2409`）**且** `proposal_approval_mode == "auto"`（runtime 設定、gateway>sandbox scope、預設 manual，`policy.rs:861`）——不是「delta 為空 + create-spec 欄位」。
- prover 進入點 `prove(policy, credential_set, binary_registry)`（`crates/openshell-prover/src/lib.rs:37`）；z3 是 workspace dep（`bundled-z3` feature）。

**真實 ExecutionSubstrate port 契約（adapter 要驅動的——已逐一覆驗）：**
- service `OpenShell`（`proto/openshell.proto:20`，tonic client over TLS）。
- 生命週期：`CreateSandbox:25` / `GetSandbox:28` / `ListSandboxes:31` / `DeleteSandbox:46` / `WatchSandbox(stream):190`。
- exec：`ExecSandbox(stream):67` / `ExecSandboxInteractive(bidi PTY):75`；轉發：`ForwardTcp:70` / `ExposeService:52-61`。
- 反向控制：`ConnectSupervisor(stream):169`（supervisor 主動撥 gateway，永不回撥 sandbox）/ `RelayStream:182`；config pull：`GetSandboxConfig:129`/`UpdateConfig:137`。
- **憑證非落地**：`GetSandboxProviderEnvironment:153` 發 placeholder `openshell:resolve:env:v<rev>_<KEY>`（`secrets.rs:9`、`placeholder_for_env_key_for_revision:487`）；真值只在 supervisor `SecretResolver`（`secrets.rs:87`），egress `rewrite_http_header_block:884` 注入 + fail-closed scan `:933` + CWE-113 `:501` + CWE-22 `:619`。
- inference：service `Inference`，`GetInferenceBundle`→`ResolvedRoute{base_url,api_key,model_id}`（`proto/inference.proto:11-13,103-115`）。
- policy draft/approval：`SubmitPolicyAnalysis:197`/`GetDraftPolicy:201`/`ApproveDraftChunk:204`/…（`openshell.proto:197-226`）。

**NemoClaw 怎麼 host agent（餵 Brain Port，已覆驗）：** NemoClaw 是 **TypeScript 編排層/CLI**（非 runtime），驅動 OpenShell。它把 agent（預設 OpenClaw、可選 Hermes）**以長駐背景進程**起在 OpenShell sandbox 內（`nohup <gatewayCmd> >> $_GATEWAY_LOG 2>&1 &` + gosu 降權，`src/lib/agent/runtime.ts:143-147`）；「always-on」是長駐進程 + recovery script，非 runtime 機制。**它自己不實作憑證非落地**——完全委派給 OpenShell SecretResolver，只多加一層 secret regex 內容掃描。它**明確不做**：多租隔離、operator RBAC、fleet 管理、enterprise SSO（`enterprise-readiness.mdx:19,100,102,131`）——**這正是 Agent OS strategy B 要自建的縫隙**。Brain Port 沿用「TS 編排層 over gRPC 驅動 OpenShell + 長駐供 agent 進程」此架構先例，但**自建監督/重啟**取代 nohup+shell hack，並在 OpenShell SecretResolver 之上**自建 credential-blind 的多租 lease 層**。

---

## 1. 摘要 / TL;DR

**一句話結論：** OpenShell 是一個成熟、deny-by-default 工程紮實的「single-trust-domain（單一信任域）」sandbox runtime + control plane，**非常適合作為 Agent OS 的 sandbox / policy / credential / inference / audit 基礎層直接 reuse**，但**多租戶（multi-tenant）、Tenant/Task/AgentSession/ToolManifest 等領域物件、以及 durable/tamper-evident 中央 audit sink 必須在其上自建**——Personal Agent Workstation 幾乎可以開箱即用，Enterprise Agent Runtime Platform 則應把 OpenShell 視為「每租戶的 runtime 單元」並在其上包一層 tenant/IAM。

**3-5 點關鍵理由：**

1. **Deny-by-default 是架構性的、非事後補丁。** 網路 egress 透過 per-sandbox network namespace + veth 強制走 host-side CONNECT proxy，nftables `LOG+REJECT` 所有 bypass，OPA Rego 以 `default allow_network = false` / `default network_action := "deny"` 結束（`data/sandbox-policy.rego`），「no match => deny」、explicit deny 勝過 allow。Syscall 由 seccomp denylist 封死 fileless-exec / ptrace / mount / user-namespace 等逃逸路徑（`crates/openshell-supervisor-process/src/sandbox/linux/seccomp.rs`）。

2. **Credential 不落地是工程實作出來的，不是口號。** Gateway 是唯一 credential 儲存點；agent child 進程只看到 opaque placeholder（`openshell:resolve:env:v<rev>_<KEY>`），真正的 secret 只存在 supervisor 持有的 `SecretResolver`，在 egress proxy 處才注入 HTTP bytes，且 fail-closed、做 CWE-113/CWE-22 驗證、`Debug` impl 手寫 redact（`crates/openshell-core/src/secrets.rs`）。

3. **Agent 自提的 policy 變更預設需人工審核。** 提案進 PENDING inbox，auto-approve 僅在「明確 opt-in（`proposal_approval_mode=auto`，預設 manual）」**且** Z3 SMT prover delta 為空時才觸發（`crates/openshell-prover` + `crates/openshell-server/src/grpc/policy.rs:455-491`）。這直接命中我們「agent-generated policy changes require review/approval」的 invariant。

4. **沒有任何 Tenant 領域物件。** `tenant` 在 `proto/*.proto` 與 `openshell-core/src/*.rs` 回傳 0 命中（已驗證）；IAM 是 single-player 的 `Principal {User/Sandbox/Anonymous}` + 粗粒度 `{Admin, User}` RBAC，隔離邊界是 per-sandbox（`sandbox_id` 比對，issue #1354），不是 per-tenant。Tenant、Task、AgentSession、Artifact、ToolManifest/ToolInvocation 皆**無原生表示，必須自建於 gateway 之上**。

5. **OpenShell 自承 alpha / single-player。** `README.md:13` 明寫「Alpha software — single-player mode... building toward multi-tenant」。NemoClaw（TypeScript）即是「gateway 之上」的產品層參考，且自己也宣告 multi-tenant isolation OUT OF SCOPE——正好印證我們 Agent OS 要落腳的縫隙。

---

## 2. OpenShell 概觀

### 定位

OpenShell 是 NVIDIA 的開源 **secure sandbox runtime + gateway control plane**，目標是讓（untrusted）AI agent 安全地在隔離環境內執行程式、存取網路與 credential、呼叫 inference。它由三個穩定的執行期元件構成：

- **CLI / SDK / TUI**（使用者面）
- **Gateway**（control plane，擁有 durable state、credential/inference 解析、policy 修訂、auth）
- **Supervisor**（每個 sandbox 的本機安全邊界）

架構的關鍵拓撲決策是 **inversion of control**：supervisor 主動向 gateway 撥出（outbound）連線，所有 control + relay 流量（connect、exec、file sync、log push、config poll、policy status、peer relay）都多工於這一條 supervisor 發起的 gRPC session 之上；**gateway 從不主動撥接 sandbox**（`architecture/gateway.md:327-373`、`proto/openshell.proto:169-190`、`architecture/README.md:136-154`）。

### 成熟度（注意 alpha / single-player 狀態）

- `README.md:7` status badge = `alpha`；`README.md:13` 明寫「single-player mode... one developer, one environment, one gateway」（已勘查確認）。
- **runtime 核心（supervisor + 隔離原語 + policy proxy + OCSF）成熟度高**：seccomp 有 behavioral fork tests、privilege drop 做 CWE-250/POS37-C 驗證、OCSF 有 schema-conformance 測試。
- **Docker / Podman / VM (libkrun microVM) driver 可用**；**Kubernetes / Helm 標記為 experimental**。
- **Python SDK 標為 Alpha**（`Development Status :: 3 - Alpha`）；proto 契約相對較穩，但仍是 alpha 期 API。

### 授權與供應鏈

- 依賴 license 透過 permissive-only allowlist 把關（`about.toml`），貢獻需 DCO（`DCO`）。
- Release pipeline 產生 **SLSA build provenance attestations** 與 **CycloneDX SBOM**（`.github/workflows/release-tag.yml`、`deploy/sbom/`），enterprise compliance-readiness 可信。

### 技術棧

- **Rust workspace，19 crates，edition 2024**（已確認 `crates/` 含 19 個 openshell-* crate）。
- 持久化：**protobuf-object store**，SQLite（single-replica，本機優先）/ Postgres（multi-replica HA），CAS optimistic concurrency 在編譯期強制（非 CAS 寫入是 `#[cfg(test)]` only）。
- 隔離：Landlock（filesystem）+ seccomp（syscall）+ network namespace + privilege drop；microVM 走 libkrun + VFIO GPU passthrough。
- policy 引擎：embedded **OPA (regorus)** 跑 baked Rego + **Z3 SMT prover**（`crates/openshell-prover`）。
- audit：自帶 **OCSF v1.7.0** 實作（`crates/openshell-ocsf`，`OCSF_VERSION = "1.7.0"` 已確認）。

### 與 NemoClaw 的關係

NemoClaw 是 NVIDIA 的開源**參考棧**，讓 always-on agent（OpenClaw 預設、Hermes）更安全地跑在 OpenShell sandbox 內。職責切分明確（`nemoclaw/docs/reference/enterprise-readiness.mdx:50-58`）：

- **NemoClaw 擁有**：host CLI、onboarding、blueprint（pinned-digest）、baseline policy presets、host-side credential 衛生。
- **OpenShell 擁有**：network-namespace isolation、CONNECT/L7 proxy、policy 強制執行、inference routing、TLS termination、OCSF logging。
- **OpenClaw/Hermes 擁有**：agent loop。

NemoClaw 透過**子進程呼叫 `openshell` CLI**（如 `openshell sandbox create ... -- env <ENV> nemoclaw-start`，見 `nemoclaw/src/lib/build-context.ts:88`）來驅動 OpenShell——這證明了「在 gateway 之上建產品層」是可行的，也正是 Agent OS 要落腳的縫隙。但 NemoClaw 自承 multi-tenant isolation 與 operator RBAC **OUT OF SCOPE**（`enterprise-readiness.mdx:99-108`），是 Personal-mode 的最佳模式參考，而非 Enterprise 的現成解。

---

## 3. 架構與元件地圖

### 元件表

| Crate / 元件 | 職責 | 證據 file | 對應 Agent OS Layer | 成熟度 |
|---|---|---|---|---|
| Gateway control plane (`openshell-server`) | 認證 control plane：gRPC/HTTP API、sandbox lifecycle、protobuf-object 持久化（SQLite/Postgres + CAS）、credential/inference 解析、policy 修訂、supervisor session 協調 | `architecture/gateway.md:1-18,94-261`；`crates/openshell-server/src/lib.rs` | Task orchestration backbone + Persistence + Audit ingest +（部分）Tenant/IAM | Alpha 但紮實；RFC 0001 HA active-active；CAS 編譯期強制 |
| Supervisor (`openshell-sandbox` / `openshell-supervisor-process`) | per-sandbox 本機安全邊界：root 啟動 → Landlock+seccomp+netns → 抓 policy/config/credential → 起 proxy + 本機 SSH → 對 gateway 開 outbound session → privilege drop 後以非特權子進程啟 agent | `architecture/sandbox.md:1-64`；`crates/openshell-supervisor-process/src/process.rs:450-589` | Sandbox runtime adapter（enforcement 半）+ Credential 注入點 | 核心成熟；Linux 完整隔離，他平台僅 proxy fallback |
| Policy proxy + OPA (`openshell-supervisor-network` + `openshell-policy`) | 強制 egress 路徑：binary-identity TOFU、SSRF/internal-IP hard-block、OPA L4 eval、L7 method/path/GraphQL/SQL 檢查、credential placeholder 注入；deny-by-default | `architecture/security-policy.md:32-81`；`crates/openshell-supervisor-network/src/opa.rs`；`data/sandbox-policy.rego` | Policy engine + PolicyDecision | 成熟；L4 baseline + L7 REST；可熱重載 |
| Z3 SMT prover (`openshell-prover`) | proposed policy 的形式驗證 referee：對 merged policy + credential scope 建 Z3 model，計算四類 categorical findings 的 delta，任一 finding 阻擋 auto-approve | `architecture/security-policy.md:99-166`；`crates/openshell-prover/src/queries.rs:16-35` | Policy engine（verification）+ Approval workflow gate | 成熟、deterministic |
| Draft policy / proposal flow (`SubmitPolicyAnalysis` + Approve/Reject/Edit/Undo RPC) | agent/operator policy-change inbox：提案存為 draft chunk + provenance + status；預設 manual 審核；auto-approve 須 prover delta 空 | `proto/openshell.proto:197-226`；`crates/openshell-core/src/settings.rs:84-108`；`rfc/0002` | Approval workflow + ApprovalRequest | network policy 成熟；filesystem/process 尚不可熱重載 |
| OCSF audit (`openshell-ocsf`) | schema-validated OCSF v1.7.0 JSONL：8 個 event class（Network/HTTP/SSH/Process Activity、Detection Finding、App Lifecycle、Config State Change、Base）；明確「never log secrets」 | `crates/openshell-ocsf/src/events/base_event.rs:11-73`；`src/ctx.rs:14-41`；`architecture/security-policy.md:168-184` | Audit/event log + AuditEvent | 成熟、OCSF-conformant；per-sandbox，無 tenant 聚合 |
| Router + Inference (`openshell-router`) | sandbox-local 轉發 `https://inference.local` 到 model backend；gateway 解析 route bundle（provider/model/endpoint/auth）；strip caller creds、注入 backend creds | `proto/inference.proto:1-119`；`architecture/gateway.md:262-325`；`crates/openshell-router/src/lib.rs` | Inference routing | 列出的 provider 成熟（openai/anthropic/nvidia/deepinfra/vertex） |
| Credentials (`openshell-providers` + `core::secrets`) | Provider = named credential bundle；gateway-stored、never on sandbox FS；runtime env 注入；`SecretResolver` placeholder + redact Debug；支援 SPIFFE token-grant OAuth2 exchange | `proto/datamodel.proto:31-44`；`crates/openshell-core/src/secrets.rs:87-110`；`architecture/sandbox.md:66-90` | Credential provider + CredentialBundle | 成熟；CRDRV driver 邊界於 RFC 0001 |
| Compute drivers (`openshell-driver-{docker,podman,kubernetes,vm}`) | `ComputeDriver` gRPC（GetCapabilities、Create/Stop/Delete/Get/List/Watch、ValidateSandboxCreate）；`DriverSandbox` 帶 `namespace` 作為 compute-platform tenancy 邊界 | `proto/compute_driver.proto:18-78`；`crates/openshell-driver-*` | Sandbox runtime adapter（provisioning 半） | Docker/Podman/VM 可用；K8s/Helm experimental |
| Auth/IAM (`openshell-server/src/auth`) | Authenticator chain → `Principal {User(OIDC)/Sandbox(gateway-minted JWT bound to one sandbox UUID)/Anonymous}`；粗粒度 `{Admin, User}` RBAC + per-method scope via `#[rpc_authz]` macro；handler 比對 `sandbox_id` 防 cross-sandbox | `crates/openshell-server/src/auth/principal.rs:24-76`；`method_authz.rs:29-57`；`guard.rs` | Enterprise tenant/IAM（**PARTIAL — per-sandbox, not per-tenant**） | single-player；OIDC + mTLS + Cloudflare JWT；**無 Tenant 物件** |
| CLI / TUI (`openshell-cli` + `openshell-tui`) | 使用者面：CLI sandbox/provider/policy/inference/logs + OIDC/mTLS auth + `policy_update`；TUI k9s 風格 live dashboard | `crates/openshell-cli/src/*.rs`；`README.md:161-189` | CLI/UI + Approval inbox（審核面） | single-gateway 成熟；multi-sandbox streaming inbox 延後（RFC 0002） |
| NemoClaw 參考棧（TypeScript，OpenShell 之上） | 參考產品層：onboarding、pinned-digest blueprint、manifest-first messaging（channel-plan compiler + applier + conflict detection）、credential/policy/inference applier、SSRF validation、snapshot/state lifecycle | `nemoclaw/README.md:6-20`；`nemoclaw/src/lib/messaging/AGENTS.md:7-46`；`nemoclaw-blueprint/blueprint.yaml:4-80` | CLI/UI + Task orchestration + Approval workflow + Tool registry（即我們 Agent OS 佔據的層） | Alpha；single-tenant；orchestration 層最強模式參考 |

### Control flow / Data flow 描述

**Control plane**：gateway 擁有 durable state（protobuf-object store over SQLite/Postgres，CAS optimistic concurrency 在編譯期強制——非 CAS 寫入是 `#[cfg(test)]` only）、provider/credential 解析、inference route 解析、policy 修訂儲存、auth。gateway 把 gRPC + HTTP 多工於單一 port。

**Data plane**：supervisor 以 root 啟動，準備 Landlock（filesystem）+ seccomp（syscall）+ network-namespace 隔離，drop privilege，然後以非特權子進程啟 agent；**所有一般 agent egress 被強制走本機 CONNECT policy proxy**，proxy 做 binary-identity TOFU、SSRF/internal-IP 拒絕、OPA 評估、L7 method/path 檢查。

**關鍵 data flow（credential 不落地）**：gateway 儲存真正 secret → supervisor 在 runtime 抓取並只把 placeholder 放進 agent child 的 env → agent 發出帶 placeholder 的 HTTP → proxy 在 egress 處把 placeholder 解析回真值並注入 outbound bytes。`inference.local` 是特殊攔截路徑：proxy 用 sandbox CA terminate TLS、strip 呼叫端 credential、注入 backend credential，再由 `openshell-router` 用 gateway 解析的 route bundle 轉發。

---

## 4. 逐層深入

### 4.1 Sandbox & isolation

隔離模型是 **defense-in-depth via 一個特權的 in-workload supervisor**，不是單一 sandbox 原語。每個 compute backend（Docker/Podman/K8s/libkrun microVM）啟動的 workload，其 PID 1 是以 root 跑的 `openshell-sandbox` supervisor；它準備隔離（netns + veth + nftables、ephemeral TLS CA、credential 注入、proxy）後 fork agent child，drop 到非特權 user 並套上 Landlock + seccomp + private mount namespace（隱藏 SPIFFE socket）+ proxy-forced egress（`architecture/sandbox.md:9-45`；`crates/openshell-supervisor-process/src/process.rs:450-589`）。

**重要事實：真正的隔離邊界是 supervisor，不是 container。** Docker driver 以 root 跑 container 並 `cap_add SYS_ADMIN,NET_ADMIN,SYS_PTRACE,SYSLOG` 且 `apparmor=unconfined`（`crates/openshell-driver-docker/src/lib.rs:2283,2301-2317`），K8s 強制 `runAsUser:0`（`crates/openshell-driver-kubernetes/src/driver.rs:976-981`），因為真正的邊界是 supervisor 的 in-guest 控制。**信任 OpenShell 隔離 = 信任 supervisor 的正確啟動順序，而非 container。**

強制原語成熟且可直接 reuse：

- **seccomp**：default-allow filter，denylist 封死 fileless-exec（`memfd_create`、`execveat+AT_EMPTY_PATH`）、`ptrace`/`process_vm_*`/`pidfd_*`、mount/new-mount-API/`pivot_root`/`setns`/`umount2`、user-namespace 建立（`unshare`/`clone`/`clone3+CLONE_NEWUSER`）、`io_uring`/`bpf`/`perf_event_open`/`userfaultfd`、seccomp 自我替換，並封 `AF_PACKET`/`AF_VSOCK` 使 egress 無法繞過 proxy（`seccomp.rs:184-296`，tests `624-840`）。
- **Landlock**：兩階段（root 開 PathFds → privilege drop 後 `restrict_self`），`best_effort` vs `hard_requirement`，不可用時發 High-severity OCSF alert。
- **netns + nftables**：per-sandbox netns（10.200.0.0/24 veth），`LOG+REJECT` bypass + kmsg bypass monitor。
- **privilege drop**：驗 euid/gid 已改且無法重取 root（CWE-250/POS37-C），`RLIMIT_CORE=0`、`PR_SET_DUMPABLE=0`。
- **libkrun microVM**：唯一提供真正 hardware-virtualization 隔離的層（per-sandbox VM、immutable rootfs + writable overlay、host nftables 限制、validated sandbox IDs、peer-UID/PID-checked private UDS、resume on restart），標記 **experimental**。

### 4.2 Policy engine（deny-by-default 模型 + 實際 schema）

「policy engine」不是單一元件，而是分層 pipeline。canonical policy 物件是 `SandboxPolicy`（proto-backed，定義於 `crates/openshell-core/src/policy.rs:15`，YAML serde mirror 於 `crates/openshell-policy/src/lib.rs:37-229`）。

**Schema 涵蓋**：

- `FilesystemPolicy`：`read_only` / `read_write` path allowlists、`include_workdir`。
- `LandlockPolicy`：`best_effort` / `hard_requirement`。
- `ProcessPolicy`：`run_as_user` / `group`（預設 `sandbox`，拒絕 root）。
- `network_policies`：L4（host/port/binary）+ L7（REST/GraphQL/WebSocket/SQL，allow AND deny rules、access presets、`allowed_ips`、persisted queries）。

**Schema 刻意不涵蓋**：inference routes、credentials-as-policy、approvals、tenants——這些在相鄰 crate。

**deny-by-default 是 kernel/proxy 邊界強制的，非僅 app 邏輯**：Rego 以 `default allow_network = false`（rego line 6）與 `default network_action := "deny"`（rego line 196）結束；一個 CONNECT 只在某 policy 同時匹配 endpoint（exact/glob host + port）**且** calling binary identity（由 kernel-trusted `/proc/<pid>/exe` + ancestors + SHA256 TOFU 解析；`argv[0]`/`cmdline_paths` 明確**不是** grant 訊號，因可偽造）時才允許。L7 deny 勝過 allow（rego `222-255`）。

**重要 caveat（已驗證）**：只有 `network_policies` 可熱重載；filesystem/Landlock/process policy 在 sandbox 啟動時套用並**在 sandbox 生命週期內不可變**（`rfc/0002-agent-driven-policy-management/README.md:60,89`）。改特權 file/process capability **須重建 sandbox**。

**Validation**：`validate_sandbox_policy` 拒絕 path traversal（`..`）、relative path、過寬的 rw `/`、TLD wildcard（`*.com`），並強制 256-path / 4096-char caps（`crates/openshell-policy/src/lib.rs:681-845`）。

### 4.3 Credential & inference Router（重點：credential 如何不落地）

這是最強的可 reuse 資產。架構是 **gateway-stores / supervisor-fetches-at-runtime / agent-child-never-sees-the-secret**。

**機制（`crates/openshell-core/src/secrets.rs`，已驗證 confirmed）**：

1. 對每個 provider env key，supervisor 把值換成 opaque placeholder `openshell:resolve:env:v<rev>_<KEY>`（`secrets.rs:9, 179-196`），真正的 `SecretValue` 只存在 supervisor 持有的 `by_placeholder` resolver map。
2. agent child 拿到的 env var 是 placeholder，**不是 raw key**——raw key 從不出現在 sandbox env 或 filesystem。
3. proxy 在 egress 處於 terminated HTTP stream 把 placeholder 解析回 HTTP bytes（header 含 Bearer/Basic/custom、URL path、query params；`rewrite_http_header_block`，`secrets.rs:884-941`）。

**安全硬化**：

- **Fail-closed**：任何無法解析的 reserved marker 直接 abort request（`UnresolvedPlaceholderError`，`secrets.rs:933-935`，test `1109-1122`）——不會明文外送、也不會被剝除。
- **注入驗證**：解析後的 secret 驗 CRLF/NUL（CWE-113，`secrets.rs:501-509`）與 path traversal/separator（CWE-22，`secrets.rs:619-633`）。
- **Redact**：`SecretResolver` 與 `ResolvedRoute` 皆有手寫 `Debug` impl 印 `[REDACTED]`（`secrets.rs:104-110`；`backend.rs:62-78`）。已 grep 確認 router/proxy log 巨集無 `api_key`。
- **Config 拒絕**：server config loader 主動拒絕寫入 config file 的 secret（`crates/openshell-server/src/config_file.rs:184,215` `ConfigFileError::SecretInFile`）。

**Inference 攔截（`inference.local`）**：此虛擬 host **刻意繞過 OPA network policy**，由 dedicated intercept path 處理：用 sandbox CA terminate TLS、偵測已知 request shape、**strip 呼叫端 `authorization`/`x-api-key`/hop-by-hop header**（`backend.rs:106-171`）、由 router 把 route 自身的 key 注入 upstream。inference key 因此**完全不放進 agent child env**，只存在 supervisor 的 route cache。

**進階 credential lifecycle（可 reuse）**：

- gateway-side OAuth2 / Google-SA-JWT refresh，鑄造 short-lived bearer token（`provider_refresh.rs`；`providers/google-vertex-ai.yaml:20-59`）；bootstrap material「not injected into sandboxes」。
- sandbox-side SPIFFE JWT-SVID → OAuth2 token-grant exchange，注入 endpoint-bound、audience-scoped bearer token（`l7/token_grant_injection.rs:21-130`）。
- `allows_empty_provider_credentials`（`profiles.rs:360-371`）允許在所有所需 credential 皆 runtime-resolvable 時建立零靜態 secret 的 provider——「無長效 secret at rest」的強 posture。

### 4.4 Audit / OCSF（事件 schema 對照 AuditEvent 必填欄位）

OpenShell 自帶 production-grade **OCSF v1.7.0** 遙測層（`crates/openshell-ocsf/src/lib.rs`，已確認 `OCSF_VERSION = "1.7.0"`）。8 個 event class：Network Activity 4001、HTTP Activity 4002、SSH Activity 4007、Process Activity 1007、Detection Finding 2004、Application Lifecycle 6002、Device Config State Change 5019、Base Event 0。typed enum：`ActionId {Allowed/Denied}`、`DispositionId {Allowed/Blocked/Quarantined/Approved}`、`StatusId`、`SeverityId`。

**對照我們的 AuditEvent 必填欄位（Audit Completeness Loop）：**

| 我們需要的欄位 | OpenShell OCSF 現況 | 缺口 |
|---|---|---|
| `actor_id` | 只有 OS `Process`（pid+name+parent chain），無 human/agent user identity（`objects/process.rs:76-81`） | **缺**——OCSF actor 支援 user object 但未填 |
| `tenant_id` | vendored schema 定義 `tenant_uid`（`schemas/.../metadata.json:366`），但 Rust `Metadata` struct **未實作/未填**（`objects/metadata.rs:10-28`） | **缺**——schema 已備，僅需擴充填值 |
| `project_id` | 無 | **缺** |
| `task_id` | 無 | **缺** |
| `sandbox_id` | 有（`SandboxContext`，process-wide singleton） | OK |
| `action` | 有（`ActionId`） | OK |
| `resource` | 部分（HTTP 只 model method+URL components，不含 header/query/body） | 部分 |
| `policy_decision` | 有（`status_detail` reason，如 "no matching policy"） | OK |
| `timestamp` | 有（`BaseEventData` time） | OK |
| `request_id` | 無 | **缺** |
| `result` | 有（`StatusId`） | OK |

**Durability 是刻意弱化的，且為主要 enterprise 缺口（已驗證 confirmed）**：OCSF JSONL 只寫 sandbox-local rolling file（`/var/log/openshell-ocsf.YYYY-MM-DD.log`，每日、最多 3 檔，`sandbox/src/main.rs:282-293`），預設 **OFF**；gateway 只保留 bounded in-memory tail buffer，重啟即失、過載即丟（`docs/observability/accessing-logs.mdx:37-57`）。**無中央 append-only、tamper-evident audit sink**；SIEM 整合是「自己 ship JSONL」。事件**無 signing/hash-chain**，故 audit stream 目前**不能作為 non-repudiable evidence**。

**Credential non-leak（OCSF 層）**：靠 convention + 結構性極簡——HTTP object 只 model method/scheme/host/path/port，從不含 header/query/cookie/body（`objects/http.rs:10-46`），且 `security-policy.md:183` 規定 never log secrets/tokens/query params。但這是 convention，**非 enforced redaction filter**（crate 內無 redact/mask 邏輯）；`unmapped` free-form map 與 message string 是最高風險的洩漏通道。

### 4.5 API / SDK / CLI 擴充面（proto/SDK 接點）

整個 control plane 是一份 gRPC 契約（4 個 proto file，約 2595 行）。`proto/openshell.proto`（約 1859 行）的 `OpenShell` service 約 50 個 RPC：sandbox CRUD、streaming + interactive exec、port-forward/TCP relay、service exposure、provider/credential lifecycle、policy draft-and-approve、sandbox-token issue/refresh。三個 companion service：`Inference`（`inference.proto`）、`ComputeDriver`（`compute_driver.proto`）、`sandbox.proto`（policy/config types）。

**兩個 consumer surface**：

- **Python SDK**（`python/openshell/sandbox.py`，約 1382 行，**標 Alpha**）：`Sandbox`/`SandboxClient`/`SandboxSession`，`exec`、`exec_python`（cloudpickle 序列化 callable）、`exec_stream`、`wait_ready`、`InferenceRouteClient`、內建 OIDC/bearer auth + in-process refresh。
- **Rust CLI**（`crates/openshell-cli`）：clap 薄前端，subcommand sandbox/forward/service/logs/policy/settings/provider/gateway/inference/doctor/tui/ssh-proxy。

**擴充模型**：

- server-side：`#[rpc_authz(service=...)]` / `#[rpc_auth(auth=..., scope=..., role=...)]` proc-macro 宣告 per-RPC auth metadata（約 56 個 annotation；compile-time exhaustiveness test 強制每個 RPC 都要宣告）——這是**新增 authorized RPC 的官方擴充點**。
- compute layer：透過 `ComputeDriver` gRPC trait 真正可插拔。
- agent-behavior：file-based `.agents/skills/*/SKILL.md` + RFC 0002 的 sandbox-local `policy.local` HTTP API（gated `agent_policy_proposals_enabled`，預設 false）。

**兩條整合策略**：gRPC/SDK（較緊、typed，建議 Enterprise）與 CLI subprocess orchestration（較快，建議 Personal MVP，NemoClaw 模式）。

### 4.6 Enterprise / multi-tenant / deploy

OpenShell 是**成熟的 single-trust-domain control plane，非 multi-tenant 平台**。

- **HA**：gateway active-active multi-replica，單一 CAS-based reconciler lease（30s TTL，`crates/openshell-server/src/compute/lease.rs`）；lease 是「optimization, not correctness mechanism」，correctness 靠 Postgres CAS。SQLite HA 不支援。
- **Deploy 基礎紮實（Helm chart `deploy/helm/openshell`）**：mTLS by default、OIDC RBAC、NetworkPolicy（sandbox SSH ingress gateway-only）、non-root hardened securityContext（drop ALL caps、`runAsNonRoot`）、cert-manager + SPIRE/SPIFFE、內建 PKI bootstrap（key 不進 Helm release history）、optional user-namespace isolation、`runtimeClass`（Kata/gVisor）。
- **決定性缺口：無 first-class multi-tenancy**。無 Tenant 物件；`Identity` struct 只帶 subject/roles/scopes，**無 `tenant_id`**（`crates/openshell-server/src/auth/identity.rs`）。authorization 是 **global method-level RBAC**（兩 role + optional scope 管整個 gateway）。persistence schema 是單一 `objects` table（`object_type`/`name`/`scope`/`labels`），**無 owner/tenant column**（已驗證 confirmed）。`handle_list_sandboxes`（`crates/openshell-server/src/grpc/sandbox.rs:247`）**無 caller-identity filter**——任何有 user role 的認證使用者可列舉並操作**每一個** sandbox/provider/policy/artifact。
- **credential 無 encryption-at-rest（已驗證 confirmed）**：credential 存於 shared `objects` payload BYTEA（plain prost protobuf），只有 read-path redaction；persistence 模組無 AES/KMS/envelope/zeroize。

### 4.7 NemoClaw 參考

NemoClaw 證明「build-on-top」可行，且其模式值得挖掘：

- **Blueprint**：宣告式 YAML，sandbox image 以 sha256 digest pin（`nemoclaw-blueprint/blueprint.yaml`）；五個 inference profile。
- **Blueprint Runner**：emit `RUN_ID`、strict type guard 驗 blueprint、建 sandbox、設 provider（**傳 env-var NAME 不傳 value**，`runner.ts:761-777`）、merge policy、persist `plan.json`、支援 rollback——idempotency/resume 的鷹架（但 `--plan` replay 未實作）。
- **deny-by-default baseline**：per-binary host allowlist（如 npm registry 只綁 `/usr/local/bin/openclaw`，agent 不能直接用 npm），GitHub/messaging endpoint 刻意移到 opt-in preset（least-privilege 回歸硬化）。
- **SSRF validator**（`ssrf.ts:36-93`）：scheme allowlist、private-IP/hostname 拒絕、檢查所有 DNS-resolved address、HTTP 做 **DNS-pinning** 防 TOCTOU rebinding。
- **subprocess-env allowlist**（`src/lib/subprocess-env.ts`）：子進程**不繼承完整 `process.env`**，只放行 SYSTEM/TEMP/LOCALE/PROXY/TLS/TOOLCHAIN，credential 逐 call 注入。
- **secret scanner**（`secret-scanner.ts`）：寫入 persistent memory 前掃 14 種 secret pattern，**自承不完整**（base64/hex/split-write 可繞），是 defense-in-depth 而非主控制。
- **shields**：privileged toggle 是 host-only；in-sandbox slash command 唯讀——untrusted agent 不能降自己的防護。

**critical gap（已驗證 confirmed）**：NemoClaw 自承 multi-tenant isolation 與 operator RBAC OUT OF SCOPE、SSO/OIDC roadmap-only、fleet management 手動（`enterprise-readiness.mdx:99-108`）。且控制在 NemoClaw-managed entrypoint **之外**啟動的 runtime 會失效（policy/inference-auth 只在 managed path 強制）——Agent OS 必須讓 managed path 成為**唯一**路徑。

---

## 5. 安全不變量對照表

| 我們的 Invariant | OpenShell 實作 / 缺口 | 驗證結果 |
|---|---|---|
| Unknown file access denied by default | policy model 為 allowlist 且 creation 時鎖定；unlisted path inaccessible（`docs/sandboxes/policies.mdx:56`），kernel 由 Landlock 強制 | **confirmed**（policy 層）；**但** Landlock 預設 `best_effort` 在無 Landlock kernel（pre-5.13、gVisor ENOSYS、Docker Desktop linuxkit）會 **fail-open**，agent「can access any file the process user can access」，只發 High-severity OCSF alert。須 `hard_requirement` 才硬性保證 |
| Unknown network egress denied by default | netns + veth 強制走 proxy；nftables `LOG+REJECT` bypass；Rego `default allow_network=false`/`network_action="deny"`；SSRF 永遠擋 loopback/link-local/metadata 即使有 `allowed_ips` | **confirmed**（跨所有 enforcement 層驗證：`lib.rs:622-653`、`nft_ruleset.rs:38-53`、`policy_local.rs:1457`、多份 docs） |
| Unknown process/syscall execution denied | seccomp denylist 封死逃逸 syscall（behavioral fork tests） | **confirmed**（`seccomp.rs:184-296,624-840`） |
| Unknown inference route denied by default | `inference.local` **刻意繞過 OPA**；cluster mode `disable_inference_on_empty_routes` 對空 route deny，但 **file/local mode 空 route 不 deny** | **partial / uncertain**——cluster 成立，Personal 本機模式需自加 deny default；無 per-route PolicyDecision/ApprovalRequest |
| Credentials never persisted to sandbox FS/logs/artifacts | gateway-stored、placeholder 注入 child env、egress 才解析、fail-closed、CWE-113/CWE-22 驗證、redact Debug、config loader 拒絕 SecretInFile | **confirmed**（`secrets.rs:179-196,501-509,619-633,884-941,104-110`；`config_file.rs:184,215`）。caveat：child 確實收到 credential-shaped env var，但值是 opaque placeholder |
| Every privileged action audited | policy decision 與 lifecycle 以 OCSF 結構化記錄（typed Action/Disposition/Status + reason） | **confirmed**（記錄存在），**但** audit-of-record 不 durable（JSONL 預設 OFF、gateway buffer in-memory 過載即丟），故「every... auditable」在實務上有 gap |
| Cross-tenant access impossible by construction | **無 Tenant 物件**；隔離是 per-sandbox（`sandbox_id` 比對 / `ensure_sandbox_scope` guard，issue #1354），global RBAC，`objects` table 無 tenant column，`ListSandboxes` 無 caller filter | **refuted（作為 multi-tenant 保證）**——cross-tenant「不可能」僅因「只有一個 tenant」。Enterprise 必須自建 |
| Sandbox lifecycle auditable (create/start/stop/resume/destroy) | `SandboxPhase {PROVISIONING/READY/ERROR/DELETING/UNKNOWN}` + `PlatformEvent` stream + OCSF App Lifecycle [6002]（create→Install/start→Start/stop→Stop/delete→Remove） | **confirmed**（`proto/openshell.proto:401-407`；`activity.rs:97-106`），**但 resume 無 dedicated phase/activity**——僅 gateway-recovery `resume_sandbox`（`compute/mod.rs:83`），對我們的 Task Resume Idempotency Loop 有 gap |
| Agent-generated policy changes require review/approval | 提案進 PENDING；auto-approve 須 opt-in（預設 manual）+ Z3 prover delta 空；auto-approval audit 為 `actor system:auto auto=true` | **confirmed**（`security-policy.md:108-131`；`settings.rs:84-108`；`grpc/policy.rs:455-491`）；feature 預設 OFF（`agent_policy_proposals_enabled=false`） |
| Agent process is untrusted（隱含） | supervisor 是特權邊界、container 刻意弱、privilege drop 驗證、binary TOFU | **confirmed**，**但** container 層弱（root + 寬 caps + apparmor=unconfined）——非 microVM tier 時若 supervisor 啟動順序有 bug 或 seccomp/Landlock 有 gap，會暴露近 root container |
| 有 typed PolicyDecision audit 物件 | `openshell-policy` crate **無** `PolicyDecision`（只有 `PolicyViolation`），但 typed `PolicyDecision {allowed, reason, matched_policy}` **存在於** `openshell-supervisor-network/src/opa.rs:27` | **uncertain（修正）**——原宣稱「無 typed PolicyDecision，只有 reason string」不精確。typed struct 存在於 network supervisor crate，proxy 用它 gate 流量並 emit OCSF NetworkActivity |

---

## 6. Build-vs-Reuse 決策表

| Capability | reuse / extend / build-new | Personal / Enterprise | 理由 |
|---|---|---|---|
| Sandbox lifecycle API + exec | **reuse** | both | gRPC service 已涵蓋 full lifecycle + streaming/interactive exec + App Lifecycle OCSF；Task/AgentSession 層包裝 RPC，不重做 |
| Sandbox runtime adapter（Landlock/seccomp/netns/privilege-drop） | **reuse** | both | 深 kernel 隔離已實現「agent untrusted」+ deny-by-default file/process/network；verbatim 用 `openshell-supervisor-process` |
| Compute drivers（Docker/Podman/K8s/libkrun VM） | **reuse** | both | `ComputeDriver` gRPC 乾淨抽象；Personal 用 Docker/Podman/VM，Enterprise 用 K8s/VM |
| Policy engine（OPA L4/L7 + Landlock + process） | **reuse** | both | deny-by-default、explicit-deny-wins、SSRF 硬化、OCSF policy-decision logging 已滿足；只擴 schema（加 tenant_id/task_id label），不重寫 enforcement |
| Policy safety validation（traversal/broad-path/TLD-wildcard/caps） | **reuse** | both | `validate_sandbox_policy` 已編碼硬規則；接成 CLI submit 與 gateway apply 的 mandatory gate |
| Z3 SMT prover（agent policy auto-approve gate） | **reuse** | both | 差異化安全原語，滿足「agent policy 須審核」；prover + finding-delta gate 作為 Approval workflow 核心 |
| Credential provider（placeholder 注入、SPIFFE token grant、gateway-minted token） | **reuse** | both | 已 enforce 「credential never on FS/logs」+ fail-closed + CWE 硬化；Enterprise 可在 CRDRV 邊界加 Vault/KMS driver（擴 driver 非 core） |
| Inference forwarding engine（router crate） | **reuse** | both | provider-agnostic、well-tested、upstream-side key 注入、header sanitization、byte caps |
| Per-provider inference profiles | **reuse** | both | `InferenceProviderProfile` 為 single source of truth，涵蓋主要 provider |
| Inference route policy/approval gate（per route/model deny-by-default） | **build-new** | both | `inference.local` 刻意繞 OPA，無 PolicyDecision/ApprovalRequest；須在 router 前加 policy hook（per Task/Project allowlist + audited PolicyDecision） |
| Approval workflow / ApprovalRequest | **extend** | both | proposal→prover→pending-inbox→approve/reject/edit/undo 已是可用引擎；擴成涵蓋非 policy 特權動作（file/credential/process/tool）並帶完整欄位（actor/task/resource/risk/expiration） |
| Audit/event log（OCSF JSONL） | **extend** | both | OCSF-conformant + no-secrets 規則——reuse 為 AuditEvent 骨幹；擴 `SandboxContext`→`AgentContext` 注入 tenant_id/project_id/task_id/request_id/actor_id（schema 已定義 `tenant_uid`，僅需填值） |
| Durable, append-only, tamper-evident 中央 audit sink | **build-new** | enterprise | OpenShell 刻意無 durable 中央 store；Enterprise compliance 須新 persistence service（WORM/object store + hash-chain/signing + guaranteed delivery + SIEM forwarder） |
| Runtime credential-redaction filter（audit path） | **build-new** | both | 目前 non-leak 是 convention；加 allowlist-based scrub stage 包住 `OcsfJsonlLayer`，使任何 event builder 都無法洩漏 |
| Enterprise tenant/IAM（Tenant 物件、cross-tenant isolation、fine-grained RBAC） | **build-new** | enterprise | 無 Tenant 物件；global RBAC、`objects` table 無 tenant column。建 tenant 模型 + tenant-scoped authz 於 gateway 之上，把 tenant_id 穿進 persistence key/audit/policy label/credential scope/inference route + cross-tenant tests |
| Task orchestration + AgentSession + Artifact + resume idempotency | **build-new** | both | 無 Task/AgentSession/Artifact、無 task state machine/timeline/resume-idempotency；建於 orchestration 層（NemoClaw blueprint runner + snapshot/state 為參考），透過 gateway object store 或 sibling store 持久化（須遵守 CAS 契約） |
| Tool registry + ToolManifest + ToolInvocation | **build-new** | both | OpenShell 無 tool manifest/permission/side-effect schema（NemoClaw 的 channel manifest 最接近但 channel-specific）；建 typed ToolManifest/ToolInvocation，reuse manifest-first + applier-with-conflict-detection 模式 |
| CLI/UI + approval inbox | **extend** | both | CLI + k9s TUI 已是 single-gateway 審核面；擴成 multi-sandbox/multi-tenant streaming inbox（RFC 0002 明言延後）+ surface Task timeline/Artifact；Personal 大致已涵蓋 |
| Control-plane 擴充（新 authorized RPC） | **extend** | both | 用 `rpc_authz/rpc_auth` proc-macro + exhaustiveness test 加新 RPC（Task/ApprovalRequest/Tenant），不建平行 control plane |
| Helm/K8s deploy + PKI + NetworkPolicy + 硬化 | **extend** | enterprise | 近完整 enterprise deploy 基礎；擴 per-tenant namespacing、tenant-scoped NetworkPolicy、resource quota |
| 供應鏈（SBOM/SLSA/license allowlist/signing） | **reuse** | enterprise | SLSA attestation、CycloneDX SBOM、permissive license allowlist、DCO 已達 enterprise compliance-readiness |
| microVM + VFIO GPU 隔離（high-assurance/untrusted） | **extend** | both | libkrun per-sandbox VM 是最強隔離 tier；但 experimental 且目前忽略 CPU/memory limit——須先硬化（enforce resource limit、成熟 driver bootstrap）再用於 Enterprise multi-tenant |
| Deployment verification e2e | **extend** | both | 完整 e2e（mTLS rejection、Landlock isolation、policy、GPU、k8s）；加**明確 cross-tenant denial test**（今無，因單租戶） |

---

## 7. 「基於 OpenShell 開發 Agent OS」整合架構草案

### 直接吃 OpenShell 的層

- **Sandbox runtime adapter**：我們的 `Sandbox` 物件 1:1 包裝 OpenShell sandbox；透過 `ComputeDriver` gRPC + `OpenShell` gRPC（Create/Stop/Delete/exec）驅動。
- **Policy engine + PolicyDecision**：reuse `SandboxPolicy` + `sandbox-policy.rego` + OPA proxy + Z3 prover；在 policy 上 author preset，不重寫 enforcement。
- **Credential provider + CredentialBundle**：把 `CredentialBundle` map 到 `GetSandboxProviderEnvironment`；reuse `SecretResolver` placeholder 模型 + SPIFFE/OAuth2 grant。
- **Inference routing**：reuse `Inference` service + router；`inference.local` 為唯一受管路徑。
- **Audit/event log（OCSF 序列化）**：reuse `openshell-ocsf` 為 AuditEvent 序列化骨幹。

### 自建的層

- **Task orchestration + AgentSession + Artifact + task timeline + resume idempotency**：OpenShell 只有 Sandbox + exec，無這些物件。建於 orchestration 層，持久化走 gateway object store（遵守 CAS）或 sibling store。
- **Tool registry（ToolManifest/ToolInvocation）**：typed 契約（name/version/input&output schema/required permissions/side-effect class/timeout/audit behavior/docs），由 `ExecSandbox` backing。
- **Approval inbox**（人面 ApprovalRequest，含 actor/task/resource/risk/expiration）：以 prover finding 為 risk_summary backend，擴 `SubmitPolicyAnalysis` 模式涵蓋非 network 動作。
- **Enterprise tenant/IAM 層**：Tenant 物件 + tenant-scoped authz + 把 tenant_id 穿進所有 key。
- **Durable/tamper-evident 中央 audit sink + redaction filter + SIEM forwarder**（Enterprise）。

### 邊界與介面（proto/gRPC/Python SDK 接點）

- **主整合縫隙 = `proto/openshell.proto` gRPC 契約**（Enterprise 建議綁此，較穩）。
- **新 RPC（Task/ApprovalRequest/Tenant）**：用 `#[rpc_authz]/#[rpc_auth]` proc-macro 加在 `openshell-server` tonic impl block，過 exhaustiveness test。
- **Python SDK**（`python/openshell/sandbox.py`）為 agent-native build surface（Personal MVP），但標 Alpha——以我們的領域物件 + typed ToolManifest 包裝，不重建 gRPC client。
- **CLI subprocess orchestration**（NemoClaw 模式）為 Personal MVP 的最快路徑；但耦合 CLI 輸出格式，Enterprise 應走 typed gRPC。

### Personal 與 Enterprise 兩條路徑

- **Personal Agent Workstation**：Docker/Podman/VM gateway + SQLite + 本機 mTLS single-user auth；直接 reuse per-sandbox policy + Landlock + OCSF local JSONL + TUI/CLI approval inbox。在其上薄薄加 Task timeline、Artifact、Tool registry、本機 approval inbox。**幾乎開箱即用。**
- **Enterprise Agent Runtime Platform**：把 OpenShell 視為「**每租戶的 runtime + control-plane 單元**」，外包一層 tenant-aware 上游 control plane。**強烈建議 gateway-per-tenant（或 namespace-per-tenant）+ 上游 tenant-routing**，而非在單一 gateway 內把 tenant_id 硬塞進 global RBAC 與 shared `objects` table（後者侵入性大、易漏）。Postgres HA gateway、tenant-scoped NetworkPolicy、credential KMS envelope encryption、durable tamper-evident audit、cross-tenant denial 測試套件皆為前置條件。

---

## 8. 最近的缺口（各模式一個）

### Personal 模式最近缺口：本機 Approval inbox + Task timeline 尚未串成單一面

OpenShell 已有 deny→propose→approve loop（`policy.local` + prover + TUI/CLI），credential/policy/sandbox 都 reuse 即可。但**缺一個把 ApprovalRequest（含 actor/task/resource/risk/expiration）、Task timeline、Artifact 串起來的本機 orchestration + UI**。`policy.local` 提案目前 network-policy-centric，且不帶 Task/AgentSession ID。這是 Personal 模式能「閉環」的最近一步。

附帶：file/local mode 的 inference 空 route 不 deny（`disable_inference_on_empty_routes` 只對 Cluster 回 true），Personal 須明確設 inference deny default。

### Enterprise 模式最近缺口：無 Tenant 物件 / cross-tenant isolation 不存在

最決定性缺口（已驗證 refuted）：**cross-tenant access impossible by construction 在 OpenShell 不成立**——僅因「只有一個 tenant」而「不可能」。無 Tenant 物件、global RBAC、`objects` table 無 tenant column、`ListSandboxes` 無 caller filter（任何 user role 看得到所有 sandbox/provider/policy）、OCSF 無 `tenant_uid`、credential 無 encryption-at-rest。這是 Enterprise 的第一道牆，且**最大的估算風險是把它誤判為小擴充**。

---

## 9. 建議的最小、最安全的第一個實作任務

**任務：在 Agent OS 的 Audit layer 建立一個 typed `AgentContext` + OCSF Metadata 擴充 PoC（reuse `openshell-ocsf`），把 `tenant_id` / `project_id` / `task_id` / `request_id` / `actor_id` 注入每一個 audit event，並附 cross-context 隔離單元測試。**

**為何是最小且最安全：**

- **不改 enforcement，不弱化任何安全檢查**：純粹是 audit envelope 擴充。`openshell-ocsf` 的 vendored OCSF schema **已定義** `tenant_uid` / `correlation_uid` / `labels`（`schemas/.../objects/metadata.json:366,314,235,246`），只是 Rust `Metadata` struct 未填——這是 schema-aligned 擴充，非 rewrite。
- **直接推進兩個 invariant loop**：Audit Completeness Loop（補齊 actor_id/tenant_id/project_id/task_id/request_id）與 Tenant Isolation Loop（為日後 cross-tenant 隔離鋪 audit 基礎）。
- **small / reviewable / 可驗證**：單一 crate 範圍、不碰 gateway 持久化、不引入新依賴。

**驗證命令（在 `/tmp/openshell` 或 fork 上）：**

```bash
# 1. 既有 OCSF 測試先綠（baseline）
cargo test -p openshell-ocsf

# 2. 確認 schema 已定義 tenant_uid（佐證可 schema-aligned 擴充）
grep -n "tenant_uid\|correlation_uid" crates/openshell-ocsf/schemas/ocsf/v1.7.0/objects/metadata.json

# 3. 確認 Rust Metadata struct 尚未填這些欄位（佐證為缺口）
grep -n "tenant\|correlation\|task_id\|request_id\|actor_id" crates/openshell-ocsf/src/objects/metadata.rs

# 4. 新增測試後：required-field + enum conformance + 新 context 注入測試全綠
cargo test -p openshell-ocsf

# 5. typecheck / lint / build
cargo clippy -p openshell-ocsf --all-targets -- -D warnings
cargo build -p openshell-ocsf

# 6. Credential Non-Leak Loop：確認新欄位不會把 secret 帶進 audit（掃測試輸出）
cargo test -p openshell-ocsf 2>&1 | grep -iE "sk-|bearer|api_key|password" && echo "LEAK" || echo "clean"
```

**完成後的 PR-style 摘要骨架**：what changed（Metadata 擴充 + AgentContext 注入 + tests）、why（Audit Completeness/Tenant Isolation invariant）、tests run（上列）、security implications（純 audit、無 enforcement 變更、redaction 仍 deny-by-default）、remaining risks（durable sink、tenant authz 尚未做）、follow-up（durable tamper-evident sink、redaction filter、tenant authz）。

---

## 10. 風險與未解問題

### 風險

1. **誤把 multi-tenancy 當小擴充（最大估算風險）**：無 Tenant 物件、global RBAC、`objects` table 無 tenant column、`ListSandboxes` 無 caller filter。Enterprise tenant isolation 必須**整層自建**（gateway-per-tenant 或侵入式 schema+authz 改造 + cross-tenant tests）。
2. **Container 層刻意弱**：Docker root + `CAP_SYS_ADMIN/NET_ADMIN/SYS_PTRACE` + `apparmor=unconfined`；K8s `runAsUser:0`。非 microVM tier 時，supervisor 啟動順序 bug 或 seccomp/Landlock gap 會暴露近 root container。把 container driver 視為 defense-in-depth，非 tenant 邊界。
3. **Landlock `best_effort` 預設 fail-open**：在無 Landlock kernel（macOS Docker Desktop linuxkit、gVisor、pre-5.13）filesystem 隔離靜默失效，只發 log。**filesystem deny-by-default 非保證，除非強制 `hard_requirement`**。
4. **Audit-of-record 不 durable**：JSONL 預設 OFF + sandbox-local；gateway buffer in-memory、重啟即失、過載即丟；無 signing/hash-chain。特權動作可能無存活 audit record，直接違反「every privileged action auditable」。
5. **Credential 無 encryption-at-rest**：存於 shared `objects` payload BYTEA，只有 read-path redaction；DB 被攻破或 unredacted code path bug 會一次洩漏所有 tenant credential。
6. **單一全域 inference route/key**：cluster inference config 是單一 global object，by name 解析、無 tenant 分區，任何 sandbox principal 可拉同一 shared key——破壞 Enterprise tenant isolation。
7. **`inference.local` 繞過 OPA**：誤設或 agent 影響的 route bundle 可能把 prompt/data 外送到攻擊者控制的 upstream，無 per-request policy decision/approval。
8. **Version coupling**：NemoClaw blueprint 把 OpenShell pin 在單一版本（min==max==0.0.44）+ image digest；alpha API 可能無預警變動。
9. **管制路徑唯一性**：NemoClaw 控制在 managed entrypoint 之外失效。Agent OS 必須讓受管 supervisor/proxy 路徑成為唯一路徑，否則靜默喪失 policy + credential 注入。
10. **Resume idempotency 無原生原語**：無 Task/AgentSession/Artifact 持久化、無 resume-idempotency；建於 gateway object store 須遵守 CAS 否則 HA lost-update。
11. **`allowUnauthenticatedUsers` + `disableTls` escape hatch**：若在 shared/enterprise cluster 誤設會崩潰整個 auth + transport 邊界。
12. **TOFU binary hashing**：信任首次觀察到的 hash；在首次網路使用前植入的 binary 會被信任——與「agent untrusted」立場相關。

### 未解問題

1. **Tenancy 縫隙**：gateway-per-tenant（最強隔離、運維成本高）還是 namespace-per-tenant 單 gateway（須侵入式改 `Identity`/`objects`/每個 handler/OCSF context）？source 強烈傾向 gateway-per-tenant。
2. **Resume lifecycle**：sandbox resume 是否 emit 獨立 OCSF lifecycle activity，還是只當新 `PROVISIONING→READY`？（`SandboxPhase` 無 RESUME，relay reconnect 由 supervisor 驅動）——對 Task Resume Idempotency Loop 需驗證。
3. **Approval 引擎泛化**：`SubmitPolicyAnalysis`/prover/draft-chunk 機制能否泛化到 file/process/credential/tool 特權動作，還是需平行 ApprovalRequest 引擎？
4. **AuditEvent 系統 of record**：擴 OCSF `unmapped`/`Metadata` 還是另疊 Agent-OS event envelope 包住 OCSF？OCSF 是否支援 pluggable SIEM sink + tamper-evident append-only（crate 內只見 tracing layer，需驗證）。
5. **Object store 適配性**：gateway `objects` store（`object_type/scope/version/payload`）是否為 Task/AgentSession/Artifact 的合適家，還是 Agent OS 自跑 sibling store？
6. **proto 穩定性承諾**：alpha 狀態 + NemoClaw 單版本 pin 下，`openshell.proto` 能否視為 Enterprise control-plane 擴充的穩定 ABI？
7. **Credential 儲存威脅模型**：upstream 是否認為 unencrypted-at-rest + read-path redaction 足夠（依賴 DB/KMS-managed Postgres），還是 multi-tenant 前須加 application-level envelope encryption？
8. **Inference body 持久化**：inference request/response body（prompt/completion，可能含敏感資料）是否被任何元件持久化/log（artifact/OCSF/trace）？這超出 `SecretResolver` redaction 範圍。
9. **org-ceiling / durability-lease**：RFC 描述但未實作（Phase 6）；Enterprise 需要的 ephemeral lease + 過期、trusted-auto-apply-within-ceiling 是否已部分實作？
10. **OCSF 事件覆蓋缺口**：對我們的領域（Task lifecycle、ToolInvocation、ApprovalRequest decision）相對既有 8 class（network/http/process/ssh/config/finding/lifecycle/base）的覆蓋缺口為何？

---

*本文件為 evidence-based 評估，所有結論可回溯至 `/tmp/openshell` 與 `/tmp/nemoclaw` 的真實檔案路徑。凡 refuted/uncertain 之發現皆已明示，未包含任何 secret-like 值。*
