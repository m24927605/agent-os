# Agent OS — 五件套整合架構（Hermes + OpenShell + NemoClaw + AGT + SpendGuard）

> 2026-06-21，Staff+ 團隊（讀真實 clone）設計，純思考無 code。承諾 v1 棧的整合架構。
> 權威約束見 [`AGENTS.md`](../../AGENTS.md)（5 個 vendor-neutral 槽位 + 三大不可插拔壟斷）。

## 核心三大壟斷（不可插拔 = 就是 OS 本身）
1. **PDP（`src/policy/evaluate.ts:95-144`）＝ 唯一 deny 權威**：deny-precedence + deny-by-default + fail-closed。
2. **OpenShell SecretResolver ＝ 唯一憑證注入點**：出口注入、CWE-113/22 fail-closed；腦與成本閘 credential-blind。
3. **Go WORM kernel + 離線 verifier ＝ 唯一證據根**：`ingestpb` 單一 Append RPC、commitgate、`cmd/verifier`。

## 元件呼叫圖（intent 往下流，evidence 收斂到單一根）
```
[Brain Port] Hermes(預設)/FakeBrain — 以長駐進程跑在 OpenShell sandbox 內（NemoClaw nohup+gosu, runtime.ts:143）
   │ 發出 typed PlanStep/ToolCall/MemoryMutation/SkillMutation；credential-blind；永不 deny、永不碰 secret
   ▼
[Control Plane / agent-os CORE = 脊椎，握三大壟斷]
   PDP（唯一 deny）→ createAuditEvent → redact → canonicalize → kernel AppendService（單一 Append）
   → commitgate 擋住 effect 直到 Receipt → cmd/verifier 離線驗鏈
   │ allow + Receipt 後才呼叫 ▼
[ExecutionSubstrate Port] OpenShell adapter → openshell.proto: CreateSandbox/GetSandbox/ExecSandbox/DeleteSandbox/WatchSandbox
   （proto 無 Start/Stop RPC → port 的 start/stop 是 noop/relay shim；無 file-sync RPC）
[AgentHosting Port] NemoClaw adapter → nohup+gosu 啟動腦、recovery、health probe、ConnectSupervisor 生命週期 + 加 tenant scoping
[CostGate Port] SpendGuard → 坐在 inference.local egress 內，只見 redacted header；reserve-before-effect、hard-cap RAISE BUDGET_EXHAUSTED
[Policy Port secondary] AGT GovernedCallable → 僅 advisory input 進 AuditEvent reason，永不平行 deny
```

## 三個重疊消解（各收斂成一條路）
1. **POLICY/deny**：每個特權 op **先**過 PDP；deny-precedence + deny-by-default + fail-closed。AGT 與 OpenShell OPA/Z3 **降為 advisory input**（只進 AuditEvent reason），PDP allow 時**絕不**當 fallback 再問它們;一個 adapter 模組只能 import 一個 policy 引擎（dependency-cruiser 規則）。**現缺**:沒有測試證明 AGT-allow 輸給 PDP-deny。
2. **CREDENTIAL**：只走 OpenShell SecretResolver。secret 只以 placeholder `openshell:resolve:env:v<rev>_<KEY>` 存在，egress 才注入真值。**拒絕** Hermes 自管 `~/.hermes` 與 SpendGuard 的 client-held-key(L0-L2)——把 SpendGuard 移進 inference.local，只見注入後 header。secret 在 canonicalize **之前** redact，永不進 hash-chain bytes。**現缺**:CredentialLease 契約 + pre-egress secret-shape scanner。
3. **AUDIT/evidence**：只有 Go WORM kernel + 離線 verifier 是證據根。AGT audit(plain SHA-256 無簽)與 SpendGuard audit(無 hash-chain、operator-held KMS)**不是證據**;若 ingest 則當 untrusted transport,由 kernel 重簽重鏈。

## 端到端 intent→effect 流
intent(Brain,credential-blind) → gateway 解析 AgentContext(fail-closed) → **PDP(唯一 deny)** →（AGT secondary 僅 advisory）→ deny 則短路、不呼叫 substrate、不注入 credential → **commit-before-effect**(createAuditEvent→redact→canonicalize→kernel.Append→**await Receipt**) → effect 在 OpenShell sandbox 執行(CreateSandbox→GetSandbox READY→AgentHosting.hostAgent) → in-sandbox inference 打 `inference.local` → egress proxy 抽 redacted header → **CostGate.reserve**(hard-cap,denied 則 402、不到 model) → SecretResolver **egress 才注入** key → upstream model → **CostGate.commit**(實際 tokens) → result AuditEvent 鏈到 decision entry → 崩潰時 NemoClaw recovery 先離線驗 WORM checkpoint 再 replay → 稽核者跑 `cmd/verifier`(不信 operator)。
**收斂律:每個 denier 收斂到 PDP;每個 event 收斂到 WORM kernel;credential 只被 SecretResolver 在 egress 碰。**

## 五個 vendor-neutral port（現況）
| Port | 介面（摘要） | 預設 adapter | 第二實作 | 現況 |
|---|---|---|---|---|
| **Brain** | `execute(ctx,intent): AsyncIterable<PlanStep\|ToolCall\|MemoryMutation\|SkillMutation>`;args 只帶 bundleRef、非 literal secret | HermesBrainAdapter | FakeBrain | **0 impl、無介面檔** |
| **ExecutionSubstrate** | `SandboxAdapter{create/start/stop/destroy}`（start/stop 是 shim） | OpenShell gRPC client(P2) | FakeSandboxAdapter | 只有 NullSandboxAdapter |
| **Policy** | `evaluatePolicy(input,ruleSet): PolicyDecision`（唯一 deny）+ `SecondaryPolicyAdapter.evaluate`(advisory) | agent-os PDP + AGT advisory | FakePolicyAdapter | PDP 已建、secondary 未建 |
| **CostGate** | `reserve(ctx,{estTokens,resource})`、`commit(ctx,resId,{actualTokens})`;credential-blind | SpendGuard(in inference.local) | FakeCostGate | **無 port 檔** |
| **AgentHosting** | `hostAgent(ctx,spec)`、`getAgentStatus`、`reconcileAgentProcess`;加 tenant scoping | NemoClaw adapter | FakeHosting | **無 port 檔、0 impl** |

## 三 surface 覆蓋（誠實）
- **Personal（單人）**：棧的**原生契合**——OpenShell single-player + NemoClaw 單 operator hosting + Hermes 廣度 + SpendGuard 用使用者自己的 key + PDP 本機 YAML + WORM 透明度。**仍要建**:Brain Port + Hermes shim、AgentHosting Port、停用 Hermes 原生 6 後端(全走 OpenShell Exec)、curator/memory 寫入加 commit-before-effect barrier。
- **Enterprise（多租）＝ 最大缺口**：WORM kernel + 離線 verifier 是現成的 operator-independent 證據(護城河);PDP 已帶 TenantId;SpendGuard ledger 支援 tenant 分區。**但 NemoClaw 明確單 operator/無 tenant/無 RBAC/無 SSO,OpenShell proto 零 Tenant object → 整個多租脊椎 100% 自建**:gateway-per-tenant(mTLS 帶 tenantId)、tenant-scoped PDP 規則(跨租 deny-by-default)、kernel per-source sequence keyed by tenantId、Hermes skill/memory 隔離 `~/.hermes/{tenantId}`、operator RBAC + operator-mutation audit、approval gate、credential lease。**「三 surface 全支援」對 Enterprise 目前是假的。**
- **Developer**：5 個 port 給 swap surface;AGT 24+ adapter/5 SDK 示範 wrapping;OpenShell GetInferenceBundle 給乾淨 model seam;verifyChain 讓 dev 稽核 operator 誠實。**仍要建**:ToolManifest registry、contract-test harness、dependency-cruiser 反向規則、發布 Port 介面 + FakeAdapters 當 SDK、verifier CLI 當 release artifact。

## NemoClaw 角色（嚴格限縮）
**只當 AgentHosting 的一個 adapter + Brain↔Substrate 接線參考,不 fork、非 runtime 權威。** 用它:in-sandbox 長駐啟動(`runtime.ts:143`)、recovery script(`runtime.ts:94-143`)、health probe(`onboard.ts:376/443`)、binary 驗證、ConnectSupervisor 生命週期、credential 非落地委派給 SecretResolver。**它讓 Personal surface 幾乎免費;對 Enterprise 隔離給的是零——那根脊椎 100% 是我們的,也是真正的工作。**

## Build sequence
- **STEP 0（地基,多數 DONE）**:保留 PDP/AgentContext/redact/canonical/WORM kernel 為不動核心;**先**建 contract-test harness `src/test-contracts/` + dependency-cruiser 反向規則(核心無 vendor 名、vendor 只能從自己 adapter import)——**可插拔法則先於任何 adapter**。
- **STEP 1** ExecutionSubstrate:加 FakeSandboxAdapter（≥2 impl + 共享 contract test;真 OpenShell client 留 P2,不阻塞）。
- **STEP 2** commit-before-effect 接線:每個 PDP allow + SandboxLifecycleEvent 走 commitgate→kernel.Append→await Receipt 才執行;測 Append 出錯/逾時則 effect 絕不發生。
- **STEP 3** Brain Port:介面 + FakeBrain 先(RED),再 Hermes shim;強制 credential-blind(secret-shape arg→deny)+ skill/memory mutation barrier(emit→await Receipt→才寫)。
- **STEP 4** CostGate Port:介面 + FakeCostGate 先,再 SpendGuard adapter in inference.local;證 hard-cap fail-closed + reserve-before-effect + credential-blind。
- **STEP 5** AgentHosting Port:介面 + FakeHosting 先,再 NemoClaw adapter;單租;**完成 Personal 端到端**。
- **STEP 6** Policy secondary:AGT advisory adapter + 測「PDP-deny 勝 AGT-allow」(dedup #1)。
- **STEP 7** Enterprise 脊椎(長桿):tenant-scoped PDP + gateway-per-tenant + per-tenant kernel sequence + Hermes per-tenant 隔離 + operator RBAC + approval gate + credential lease(每個獨立 RED slice)。
- **STEP 8** Tier-2 acceptance + Codex gate + 離線 verifier tamper/gap/跨平台 conformance(release-blocking)。

## 立即下一步：6 個 RED-first slice
- **A**:`src/test-contracts/sandbox-adapter.test.ts`（factory-參數化 contract suite）→ 加 `src/runtime/substrate/fake.ts` 轉綠。機械化證明 ≥2-impl。
- **B**:`.dependency-cruiser.cjs` 加 `no-vendor-in-core`（核心→hermes|nemoclaw|openshell|agt|spendguard 禁止）+ per-vendor leak 規則;失敗 fixture 先紅,真 tree 綠。**在 adapter 增生前鎖死可插拔。**
- **C**:commitgate 整合測試 — kernel.Append throw/timeout 時 effect **不**執行,有 Receipt 才執行;把 commitgate 接進 adapter 路徑轉綠。**補上整個證據宣稱所依賴的 commit-before-effect 缺口。**
- **D**:`src/runtime/brain/port.ts` + contract suite + FakeBrain — 含「ToolCall args 命中 secret pattern → effect 前 deny」。
- **E**:`dedup-policy.test.ts` — AGT secondary 回 allow、PDP 回 deny → 最終 deny、AGT 只進 reason、effect 不執行 → 加 SecondaryPolicyAdapter 轉綠。機械化 dedup #1。
- **F**:`tenant-scoped-rules.test.ts` — Allow/Deny 加 optional tenant_id;tenant-a 規則不 match tenant-b → deny-by-default + tenant-mismatch reason。**Enterprise 脊椎第一塊磚。**

## 風險（BLOCKING 標出）
- **【BLOCKING】dedup #1 無測試**:今天沒東西阻止 AGT/OpenShell 被接成平行 deny gate → Enterprise policy 合規無法證明。需 slice E + dependency-cruiser 規則。
- **【BLOCKING】commit-before-effect 只是口號**:PDP 回呼叫端時**未** await kernel Receipt;commitgate 在 Go 但**未接進 TS adapter 路徑** → 證據鏈可無界落後於 effect,護城河是空的。需 slice C。
- **【dominant 排程風險】Enterprise 多租是 from-scratch,不是整合**:OpenShell 0 Tenant、NemoClaw 單 operator → 「三 surface 全支援」對 Enterprise 目前為假。
- credential 可能滑向 client-ward(SpendGuard client-held-key + Hermes 自管):必須實際把 SpendGuard 塞進 inference.local + 停用 Hermes 原生後端,否則 secret 落在 SecretResolver 之外;且尚無 CredentialLease/secret-shape scanner。
- ExecutionSubstrate proto 不符:openshell.proto **無 Start/Stop、無 file-sync RPC** → port 的 start/stop 必須是明確 noop/relay shim,否則 contract 說謊。
- 跨平台 hash 決定性未驗:Node canonical 與 Go canonical 必須產生相同 entryHash bytes,否則離線 verifier 拒合法鏈(或更糟,放行偽造鏈)。需 release-blocking conformance。
- 離線 verifier 信任綁定:`cmd/verifier` 接受 operator 提供的 Ed25519 公鑰、無 pinning → operator 可換鑰偽造過關鏈。需 artifact-signed key pinning / 外部 root（P4）。
- SpendGuard estimation predictor-down 時 fail-OPEN（`decision.rs:560-568`）違反 fail-closed 律;需 config 改 fail-closed。
- SpendGuard reserve/commit 順序由 proxy code(非 ledger schema)保證;proxy crash 留 orphaned reservation。需 TTL sweeper + durable outbox。
- Hermes curator/memory 自我改進是 fire-and-forget 寫 disk;未反轉成 emit→await Receipt→寫之前,agent 自我變更逃出證據鏈（Hermes 特有治理洞）。
