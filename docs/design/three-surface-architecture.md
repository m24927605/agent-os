# Agent OS — 三 surface 完整產品架構（架構 / 作法 / 規劃）

> 2026-06-20，Staff+ 架構團隊（讀真實 repo）產出。權威定位見 [`AGENTS.md`](../../AGENTS.md) north star。
> 目標：像「**給人一台電腦**」——一個治理核心驅動三個 co-equal surface（Personal 零技能 / Enterprise 自主組織 / Developer 平台）。
> **誠實原則**：明標「已 BUILT」vs「NEW（要建）」vs「capability-gated（卡在 agent/model 能力尚未成熟）」。無情緒價值。

## 一句話
Agent OS 字面上就是 **不可信自主 agent 的作業系統**：一個治理核心（kernel + PDP + 身分/audit + ExecutionSubstrate drivers + system services），三個 surface 只差 **shell（體驗層）** 與宣告的 **Guarantee Ladder tier**——共用同一個 kernel、PDP、adapter、audit spine 與契約。

## 把它讀成一台電腦（端到端組合）
```
SHELL（體驗層，per-surface，NEW）        Personal 零技能殼 / Enterprise operator console / Developer SDK 面
   │  intent（語音/文字）或 API
USERLAND（NEW）                          被治理的「不可信」hostable agent（Claude Code / Hermes / OpenClaw / Codex）+ skills/workflows
   │                                     ── 自我改進的 memory/skill 必須先 Append-to-WORM 才生效（否則 operator-forgeable）
SYSTEM SERVICES（多為 NEW）              orchestration(XState Task/AgentSession + resume ledger) · approval(sudo, maker≠checker)
   │                                     · tool registry(ToolManifest) · secrets broker(CredentialLease 純參照) · inference routing
   │                                     · persistence(Drizzle) · Tenant/IAM(gateway-per-tenant)
SYSCALL/PERMISSION（PDP，BUILT seed）    src/policy/evaluate.ts：deny-by-default + deny-precedence + fail-closed（純函數、零外向依賴）
   │                                     身分/syslog：src/iam/ids.ts AgentContext · src/audit（event/redact/canonical）
DRIVERS（ExecutionSubstrate，STUB）      src/runtime/openshell/adapter.ts：SandboxAdapter chokepoint（目前只有 NullSandboxAdapter）
   │                                     OpenShell = Substrate #1（Rust：Landlock/seccomp/netns/microVM、OPA+Z3、SecretResolver、OCSF），strategy B 不 fork
KERNEL（信任/證據 spine，BUILT）          kernel/（Go，獨立進程）：append-only 簽章 hash-chain + per-source sequence/gap + outbox
                                         + commit-before-effect + append-only gRPC ingest + **離線 standalone verifier**（cmd/verifier）
```
**組合流**：surface 發 intent → orchestration 拆成 Task/AgentSession → 每個特權動作過 PDP（deny-by-default）→ 敏感則 ApprovalRequest（maker≠checker，靠 capability 持有、非 if-check）→ AuditEvent fail-closed 建立、canonicalize、redact、**同步 Append 到 Go kernel 並等 Receipt 後才放行 effect**（commit-before-effect）→ effect 在 OpenShell sandbox 內經 adapter chokepoint 執行、credential 由 SecretResolver 以**參照**注入（不落地）→ 結果 audit → standalone verifier 可離線重驗。

**護城河（release-blocking 鐵律）**：attester ≠ attested actor——verifier 必須**離線、不連後端、不信 operator** 驗章+驗鏈+gap；attester 絕不可綁回 operator。

## 層級狀態表（BUILT / NEW）
| 層 | 是什麼 | 狀態 |
|---|---|---|
| Kernel 證據 spine (Go) | WORM 簽章 hash-chain + 離線 verifier + sequence/gap + outbox + commit-before-effect + append-only ingest | **BUILT（P1 merged，TS↔Go byte-for-byte）** |
| PDP syscall gate (TS) | deny-by-default + deny-precedence + fail-closed 純評估器 | **BUILT seed（P0）**；P2–P5 擴充 tool/budget/SoD/inference/egress 規則 |
| 身分 + syslog (TS) | branded IDs + AgentContext、fail-closed AuditEvent、canonical+hash、TS ingest client | **BUILT（P0/P1）**；缺 SourceId 綁定 + enforcement-tier 欄位 |
| Drivers ExecutionSubstrate | SandboxAdapter chokepoint（驅動 OpenShell，strategy B 不 fork） | **STUB（只有 NullSandboxAdapter）**；NEW：live gRPC client + injectLease/resolveInferenceRoute/readEnforcementTier |
| orchestration / scheduler | XState Task/AgentSession + resume ledger（crash 冪等復原） | **NEW（P2）** |
| approval (sudo) | ApprovalRequest，maker≠checker by capability possession | **NEW（P2 inbox；P4 SoD + property tests）** |
| tool registry | agent-agnostic Zod ToolManifest + registry + blast-radius estimator | **NEW（P2；estimator P5）** |
| secrets broker | CredentialLease 生命週期，純參照（secret 從不進 TS plane） | **NEW（P2）** |
| inference routing | per-route/model deny-by-default gate | **NEW interim（P0/P2）；完整待上游 merge（P3）** |
| persistence | Drizzle 可變狀態（SQLite Personal / per-tenant Postgres Enterprise），無明文 secret | **NEW（P2/P3）** |
| Tenant / IAM | gateway-per-tenant（進程/namespace 邊界，非 row-filter）+ per-tenant kernel partition（per-tenant Merkle + key） | **NEW（P3）**；branded TenantId 已 BUILT |
| Userland hostable agents + governed memory | 不可信第三方 agent，credential-blind 經 Python shim host；自改 memory/skill 須 Append-to-WORM-before-effect | **NEW（shim P2/P3；governed memory P5）** |
| Shell — Personal / Enterprise / Developer | 三個體驗層 | **NEW（P2 / P3-P4 / P2-P3）** |

## agent-agnostic 契約（要定義／擴充）
- **ExecutionSubstrate / SandboxAdapter**（擴充既有）：加 `injectLease(ctx, lease)`、`resolveInferenceRoute(ctx, route)`、`readEnforcementTier(sandboxId): EnforcementTier`；`AdapterResult`/`SandboxLifecycleEvent` 帶 enforcement tier（attestation 不得超claim）。
- **ToolManifest + ToolInvocation**（NEW）：Zod `.strict()`、agent-type-agnostic、9 欄（name/version/in-out schema/requiredPermissions/sideEffect[none|read|write|irreversible|external]/timeoutMs/auditBehavior/docsUrl）；未註冊 tool ⇒ PDP deny。
- **AgentSession + Task**（NEW）：`agentKind` 為自由標籤（語意中性）→ Claude Code/Hermes/OpenClaw/自研被同一套治理。
- **Ingest client + branded SourceId**（NEW wrapper + 擴 ids.ts）：每 emitter 確定性 SourceId；canonicalize→redact→Append→**await Receipt 才放行**。
- **CredentialLease**（NEW，`.strict()`）：`bundleRef` 純參照（非 secret）；secret 只由 OpenShell SecretResolver 在 egress 解析。
- **ApprovalRequest**（NEW）：maker≠checker 由 capability 持有結構性保證（proposer 結構上拿不到同 (resource,action) 的 APPROVE）。
- **Tenant**（NEW）：綁 gateway-per-tenant 拓撲（獨立 namespace + Plane shard + Postgres + kernel partition）；隔離是進程邊界、非 row filter；release-blocking 跨租 conformance。
- **EnforcementTier**（NEW enum）：container|landlock|libkrun|unknown，掛在每筆 AuditEvent/AppendRequest；tier 為 container/unknown 時 verifier 降級/拒絕高保證 attestation（fail-closed）。

## 各面作法（含 capability-gated 誠實標記）
- **Personal（Tier-Brokered 誠實）**：在共用核心上加一層薄殼——intent→clarify→plan→approve→execute→confirm（語音/文字、approval inbox、task timeline、內嵌 WASM verifier）。本機 docker-compose：一個 Node Plane + 一個 Go kernel(SQLite) + 一個 OpenShell gateway，組件間 mTLS。預設**逐步審批**（每個特權 tool call 之間重核）。比手機簡單＝無術語、白話失敗 UX（含糊就追問、絕不亂猜）、大目標、TTS 確認。
  - **capability-gated**：novel 領域的 intent→plan 卡在 agent 推理成熟度（幻覺工具/順序錯/漏步）。MVP 緩解＝**預建 workflow 模板**（email/檔案/搜尋/文件），使用者選模板填槽、agent 只在已知模板內提參數變體、未知模板 fail-closed。**任意桌面 GUI 自動化 gated**（脆弱、非確定）→ P2 只做 API/tool-based 動作，GUI 留 P3+。
- **Enterprise（Tier-Hosted，ACV 旗艦）**：同核心上 gateway-per-tenant（進程/namespace 邊界 + per-tenant Postgres + per-tenant kernel partition 各有 Merkle+Ed25519 key），**release-blocking 跨租 conformance**（A 讀/寫/列/刪 B ⇒ 403+audited）+ **managed-path-is-only-path** sealed-launch bypass 測試（亦 release-blocking）。c3 Tenant-Sealed Fleet 先 → c6 Agent Escrow（host 廠商不可信 agent、credential-blind、給客戶 kernel 簽章執行回執 + declared-vs-used scope diff、egress deny-by-default）→ c1 Oversight-of-Record（**policy 決策**的 decision-path replay + evidence-pack 匯出）+ c4 Maker-Checker。
  - **capability-gated（殘酷誠實）**：「自主優化/找機會」v1 只能是**人類發起**的參數微調（agent 只建議、不能自寫新 workflow/policy）。「decision-path replay」replay 的是**確定性 PDP 決策**、不是 agent 重推理（LLM variance 使 plan-replay 非確定）——attestation 價值是「policy 一致地被套用」，不是「達到同樣結果」。「取代所有員工」是 ceiling，**不是近期 slice**；能誠實成立的是 attenuation + budget 約束下對**已知 workflow** 的 governed orchestration。
- **Developer（Tier-Hosted/SDK）**：SDK-first。Python primary credential-blind shim（import-linter 禁 import 帶 secret 的模組，contract test：import boto3/azure-identity 即失敗）+ TS 次要 + 薄 CLI。單源 proto codegen（buf）→ TS/Python/Go stub。OpenShell adapter chokepoint ＝可重現 sandbox provisioning 面（本就是 substrate 的強項）。observability ＝ task timeline + decision-path replay + standalone/WASM verifier（relying party 是開發者的 CISO/稽核，**不是**開發者本人）。
  - **capability-gated**：OpenShell 隔離強度（Landlock hard_requirement、per-route inference gate、OCSF tenant 欄、redaction filter）卡在 **4 個上游 Rust PR**（SF5，不可控）；interim ＝ Core-side egress allowlist + container-tier-only + fail-closed tier 降級；isolation-attestation claim **SKU-gate 在實際 merge**、非 PR 提交。

## 分階段規劃（接在已 merged 的 P0/P1 上）
| Phase | 目標 | 交付（command-verifiable） | 依賴 |
|---|---|---|---|
| **P0** boundary+contracts | 兩條 hard constraint 可指令驗；身分/audit/PDP seed + null adapter + interim F3/F4 + 4 上游 PR | ✅ DONE | — |
| **P1** Go evidence kernel | WORM spine + 離線 verifier + sequence/gap + outbox + commit-before-effect + ingest | ✅ DONE（verify:p1-exit 6/6） | P0 |
| **P2** Personal beachhead c24（**NEXT**） | 本機閉環：orchestration + approval + ToolManifest + lease + live OpenShell adapter + TS→kernel sync-commit ingest，host 一個真實第三方 agent | E2E：intent→approval→approve→lease→kernel→timeline 重建；credential 6-sink 不洩；resume 冪等無重複 effect；verify:py 級聯 | P1 + 新 SourceId/tier + adapter injectLease |
| **P3** Enterprise c6+c3 | gateway-per-tenant（per-tenant Postgres + per-tenant-keyed kernel partition）+ Agent Escrow 簽章回執 | release-blocking 跨租 conformance + managed-path bypass 測試 + escrow 回執可離線驗 + egress deny-by-default | P2 + tenant routing + 上游 PR merge |
| **P4** flagship c1+c4 | F1 升 Tessera tile-log + RFC-3161 錨定 + WASM verifier；Oversight-of-Record；capability-possession maker-checker | WASM verifier 離線重驗（含外部錨）；decision-path replay 確定性；c4 property/adversarial 證 PROPOSE 拿不到 APPROVE | P1/P3 + SF3 商業 gate（不擋 build） |
| **P5** net-new c20+c10+c12 | sub-delegation capability algebra；blast-radius budget；Chinese-Wall per-Side governed memory | c20 child⊆parent 證明；c10 over-budget by-construction 不可能；c12 cross-Side deny by-construction + non-contamination report | P4 + F4 inference keying；governed memory Append-before-effect |

## 立即下一步：P2 的 6 個 slice（每個 RED-first）
1. **P2-S1**：`src/iam/ids.ts` 加 branded `SourceId` + `EnforcementTier` enum；穿進 AuditEvent 與 proto AppendRequest。RED：無確定性 sourceId 的 AuditEvent / 無 tier 的 append 失敗。（解鎖其餘 P2 ingest）
2. **P2-S2**：`src/audit/kernel/ingest.ts` TS sync-commit ingest wrapper（canonicalize→redact→Append→**await Receipt 才回傳**）+ outbox（capped dispatcher、無 unbounded loop）+ (sourceId,sequence) dedup。RED：effect 在 receipt 前跑＝時序測試失敗。
3. **P2-S3**：`src/tools/manifest.ts` + `registry.ts`（Zod `.strict()` ToolManifest）+ 擴 `policy/evaluate.ts`：未註冊 tool ⇒ deny。RED：呼叫未註冊 tool 被 deny+audit。
4. **P2-S4**：`src/credential/lease.ts`（`.strict()`，bundleRef 純參照）+ contract test（raw-secret 欄位 parse 失敗、secret-scan clean）+ 擴 adapter `injectLease`/`readEnforcementTier`。
5. **P2-S5**：`src/orchestration/task.ts` + `agent-session.ts`（XState FSM + resume ledger）。RED：crash 後 resume 重跑前一步須 dedup 成無重複外部 effect。
6. **P2-S6**：`src/approval/request.ts` + `ui/`（approval inbox + task timeline + IntentInput 語音/文字 + 內嵌 verifier）+ `scripts/personal-launcher.sh` + docker-compose。RED：intent→approve→lease→kernel→timeline 重建的 E2E 起初失敗（殼未接）。

## 前緣與風險（founder 親自承擔的非工程 gate）
- **SF3（擋 GTM、不擋 build）**：簽章 WORM 只有在 design-partner 的外部律師/稽核/E&O 承保人**書面**確認「偏好且可採納」才是資產；未過前對外封頂在「tamper-evident(post-hoc)、separate-process 非 separate-org」。
- **SF6（存活 gate）**：若簽章 key 由我方持有，我方＝另一個 operator，per-attested-action 溢價不誠實 → 須**外部化簽章 root**（客戶 KMS/HSM 或外部 transparency log/eIDAS QTSP）。Microsoft 開源 Agent Governance Toolkit 已商品化「治理證據即 artifact」；唯一持久差異＝外部化 root + operator-independent 離線 verifier，約 6–18 月領先、非永久。
- **SF5（不可控）**：4 個上游 OpenShell Rust PR 在 NVIDIA review queue、無 merge 時程；interim＝container-tier + egress allowlist + fail-closed tier 降級；高保證 claim SKU-gate 在實際 merge。
- **capability-gated**：intent→plan、自主機會探索、cost estimator、任意 GUI 自動化都受 agent/model 成熟度限制。誠實框架：**Agent OS 擁有 audit/approval/credential/sandbox 層（現在可建）；planner 是不可信 agent 的責任。** 不講「取代所有員工」話術。
- **單一可信元件**：standalone verifier（~500 行）是唯一被信任的元件——bug＝稽核者信任被竄改的鏈。保持小、TS/Go byte-for-byte parity、WASM verifier 是 defense-in-depth 而非「獨立」（仍是我方 shipped code）。
- **attest-the-negative 誠實**：無違規事件＝**consistent-with** 隔離、非 proof-of 隔離（covert/OS 級通道在觀測外）；claim 強度綁 enforcement-tier。c12 語意通道洩漏（embeddings/model-cache）超出 Landlock，是最高風險 net-new。
</content>
