# Agent OS 機會研究：治理解鎖的殺手級應用

> 本文件為產品機會綜整（opportunity synthesis）。輸入為兩輪 candidate 探索後、經 market + feasibility 雙維度評審（judging）的結果：24 個候選中 **19 個通過（survivors）**、5 個暫不推薦。所有評審皆對照已採用的整合策略 B（Agent OS 作為 OpenShell 之上的獨立層、gateway-per-tenant）與 [openshell.md](./openshell.md) 的真實原始碼勘查。凡屬投機性（speculative）的白地（whitespace）皆明確標註。保留英文技術術語與程式識別符號。
>
> 相關研究：[openshell.md](./openshell.md)、[decision-integration-strategy.md](./decision-integration-strategy.md)、[loops.md](./loops.md)、[README.md](./README.md)。
>
> 日期：2026-06-19。

---

## 1. 摘要 / 戰略命題

**一句話 thesis：Agent OS 的殺手級機會源自「治理解鎖（governance-unlock）」——把本來因為信任、安全、合規、責任或多租戶風險而「不能放手讓 autonomous agent 去做」的高風險／受規範／多方工作，變成可安全、可審批、credential-safe、可隔離、可審計地放手執行。** 我們不跟 agent framework 比「agent 能做什麼（capability）」，我們賣「能讓 agent 安全、受治理、可審計地真的去動真實系統（safe governed auditable action）」。

**3-5 點戰略要點：**

1. **競爭軸是「治理」而非「能力」。** 大多數對手堆 capability；我們堆「by-construction 的 deny-by-default + 可審批 + credential 不外洩 + 隔離 + tamper-evident audit」。最強的機會，恰恰是那些「今天因為 trust/compliance/liability/multi-tenant 而被禁止讓 agent 自動做」、但因為治理而現在能做的事。
2. **「from outside the agent's trust boundary」是貫穿一切的護城河。** logger / policy gate / credential broker 坐在 agent 信任邊界**之外**且在**動作路徑（action path）內**——所以它能記下、能阻擋、能證明 agent 自己無法偽造、無法繞過、無法事後竄改的事實。一個 generic framework 的 log 是「嫌疑人自報」，是文件而非證據。這條原則同時撐起 evidence-grade audit、insurable telemetry、agent passport、Chinese-wall non-contamination。
3. **2026 的法規與責任時鐘是真實的 why-now。** EU PLD strict liability（2026-12-09 轉置）、EU AI Act Art. 12 high-risk logging（2026-08-02 起執法）、CA AB 316（不能用「the AI did it」當抗辯）、SOX/PCAOB AS 2201/2101（2026-12）、NIST agent identity/authorization concept paper（2026-02）、ISO 通用 AI 保險除外（2026-01）共同把「audit / oversight / 委任授權」從 feature 變成「責任界定的 system-of-record」，且把 deployer 推上 liability 的位置。
4. **同一組底層 build-new 工作支撐絕大多數旗艦。** 反覆出現的硬需求是同四件事（見 §5）：**durable、append-only、hash-chained、signed 的 tamper-evident audit sink**（OpenShell 今天沒有）、**OCSF AgentContext 擴充**（tenant/project/task/request/actor）、**per-route inference policy gate**（`inference.local` 刻意繞過 OPA）、**enforced runtime credential-redaction filter**。先把這四件做出來，幾乎所有 survivor 同時受益。
5. **誠實分級：已驗證需求 vs 投機白地。** 旗艦（§2）多有「已資助的買方 + 具體 why-now + 真實 pain」；高潛力領域（§3）需求成立但部分能力正在 commoditize；白地（§4）是大膽的第二序機會，誠實標為投機，是「先卡位、後驗證」而非近期營收賭注。

---

## 2. Top 殺手級應用（旗艦）

挑選邏輯：market × differentiation × 與 Agent OS 治理本質的契合度，並偏好「by-construction 才成立、generic framework 結構上做不到」者。分數為評審給的 market / feasibility（各 1-5）。

### 2.1 Oversight-of-Record：admissible-by-construction 的 tamper-evident 全動作 ledger（c1）

- **是什麼：** 從 agent 信任邊界**之外**、在動作路徑**之內**，把每個 PolicyDecision / approval / credential scope / ToolInvocation hash-chain 成 append-only、外部錨定（RFC-3161 / transparency log）的 WORM ledger；附 deterministic 的「decision-path replay」（重放決策路徑，不重抽模型）與 signed evidence-export bundle。把 audit pillar 從「logs」升級成「法律意義的 system-of-record」，包含證明 **negative**（sandbox 結構性擋住、agent 觸不到的東西）。
- **誰買：** CLO / GC、CRO、CCO、Head of Model Risk、Internal Audit、IG（銀行 / broker-dealer 為主）；其 E&O / cyber 保險人與 outside counsel 越來越要求之。
- **為何只有 Agent OS 能做（治理解鎖）：** tamper-evident 紀錄必須由「被它擔保的信任邊界之外」產生；只有坐在動作路徑內的 policy proxy + credential layer + sandbox 能把 {action, policy version, decision, approver, credential scope, content-addressed input} 綁成一個 signed unit、重放決策路徑、且**獨家 attest-the-negative**。GRC/observability（Fiddler、Galileo、trail-ml）只 scrape framework 自報的 trace——文件不是證據，且結構上無法 attest negative。
- **需要的功能：** hash-chained append-only WORM/17a-4 audit sink（agent 無寫入權）；external anchoring；Decision Record 物件；deterministic decision-path replay；standalone independent verifier（不信任平台亦可重驗鏈+簽章）；enforced credential/PII redaction；OCSF + 框架格式（EU AI Act / Colorado / SR 11-7 / SEC 17a-4）export。
- **新穎度（gap）：** 類別正在快速升溫且競爭（AlphaBitCore、Faramesh、Confluent/Kiteworks、Sakura Sky deterministic-replay 系列）。durable wedge = **attest-the-negative + decision-path replay + external anchoring**，由完整 in-path stack 交付。
- **why now：** EU PLD（2026-12-09，推定 deployer 疏於 oversight 即致害）+ EU AI Act Art. 12（2026-08-02）+ SR 11-7 / SEC 17a-4 / NYDFS 500.6 / DORA / ISO 42001。
- **分數：** market 5 / feasibility 4。**這是 audit pillar 的定義性表達，是旗艦核心。**

### 2.2 Agent Escrow / BYO-Agent-on-My-Data：在你的系統上跑陌生人的 untrusted agent，它看不到 secret、資料不出境（c6）

- **是什麼：** 讓 vendor 的 untrusted agent（KYC/AML、對帳、AWS-bill、SOC2-evidence agent）在**你的 perimeter 內**做一個有界任務，全程不交出你的 Stripe/NetSuite/AWS credential、你的 PHI/PII 不流向 vendor cloud。agent 只看到 authenticated proxy endpoint；egress deny-by-default 不能 phone-home；每次 credential 使用與每個 byte 都是**客戶自有**的 AuditEvent；客戶留下 signed 'execution receipt' + over-permission diff。解凍卡在 security review 的六位數 vendor-agent 交易。
- **誰買：** 客戶端 CISO / TPRM lead（想用 vendor agent 但過不了 security review），CPO/DPO 共簽；加上 vendor 的 GTM（Agent OS 成為其「enterprise-ready」勾選）。雙邊拉力。
- **為何只有 Agent OS 能做：** credential 在 policy-proxy 層注入、**絕不**落到 agent sandbox FS/env/logs/traces（Credential Non-Leak 已 confirmed：`secrets.rs`、placeholder 模型、fail-closed、CWE-113/22 加固）；vendor untrusted code 跑在 deny-by-default egress 的隔離 cell；客戶（非 vendor）擁有 tamper-evident 紀錄。Generic framework 把 secret 交給 agent——game over。「我在我的 key 上跑你的 code，而你從沒看到 key」by construction 為真。
- **需要的功能：** credential broker mode（scoped/time-boxed CredentialBundle 租給 foreign image）；customer-owned vendor-agent sandbox profile（僅 allow-listed result channel 出口）；resource-level per-credential-use AuditEvent；signed execution receipt + vendor attestation；declared-vs-actually-used scope diff；data-exfiltration tripwires（output-channel 檢查）。
- **新穎度（gap）：** Aembit（2026-04 GA）/Astrix 做 secretless credential broker，但只給「你自己的 agent」；AWS AgentCore / Maniac 是你掌控的 VPC agent；Confidential Computing 提供 attestation 原語非成品。沒人賣這個 two-sided「在我的 key 上跑你的 untrusted image」成品。
- **why now：** fintech/bank vendor security review 6-12 週、常在發現平台無法 enforce data-isolation / credential containment 時殺掉可用原型；Protecto（2025-12）已推「help AI agent builders win enterprise contracts」之 SaaS，證明供給側付費意願。
- **分數：** market 5 / feasibility 4。**最高 conviction 的旗艦 wedge。**

### 2.3 Maker-Checker Runtime：by-construction 的 segregation-of-duties（提案者根本拿不到批准能力）（c4）

- **是什麼：** capability 層的 SoD 原語——同一個 AgentSession/credential bundle 若 PROPOSE 一筆匯款/分錄/GL post，就**結構上無法**取得 APPROVE/POST 的 capability。批准路由給不同 actor（人 or 另行授信的 checker agent）；付款/過帳 credential 僅在批准後注入、且綁定確切批准參數（金額/受款人/科目）；每步對應 ICFR/SOX control 並產 non-repudiable signed approval receipt。解凍「autonomous money movement / books-closing 而不造成 material weakness」這個最被卡死的財務自動化。
- **誰買：** Head of Payment Ops / Treasurer、Corporate Controller、VP Internal Audit / SOX owner、共簽的 CISO；Big-4 / mid-tier 審計合夥人。
- **為何只有 Agent OS 能做：** SoD 是 policy + credential + approval 的交集——正是 Agent OS 擁有的。因為 runtime 簽發/scope agent 身分並 broker 每次 credential 注入，能讓「一個身分無法同時持有不相容 capability 對」by construction 成立。GRC（SafePaaS、Saviynt、Pathlock）只在 ERP 之上 DETECT/FLAG，不擁有 runtime 身分、不 broker credential 注入，故無法讓提案者**物理上**拿不到批准能力。
- **需要的功能：** SoD/conflict-pair policy 原語（capability-grant 時 enforce）；step-scoped、role-distinct credential bundles；typed dual-control ApprovalRequest（maker/checker 身分、金額、受款人、簽章）；JIT 付款 credential 僅批准後注入並綁定參數；amount/beneficiary-bound L7 body-match policy；SOX/ICFR control-mapping audit；governed ERP connectors（NetSuite/SAP/Workday，read-GL / post-JE / approve-JE 分權）。
- **新穎度（gap）：** 「by construction 不可繞過」的保證真實且獨佔，需要擁有身分 + credential broking 的 runtime；定位要對準 GRC 的「enforce vs detect」。
- **why now：** PCAOB AS 2201/2101 修訂（FY ≥ 2026-12-15）；CFO 今天只敢「supervised autonomy」正因無法保證 agent 不自批。
- **分數：** market 5 / feasibility 4。**硬性 blocker 的最高價值解。**（依賴 §5 的 durable signed audit sink 才能滿足 SOX 證據。）

### 2.4 Sub-Delegation Firewall：agent swarm 內 non-amplifiable、隔離、可審計的授權交接（c20）

- **是什麼：** 讓授權沿 delegation chain（principal → orchestrator → 動態挑選、常為第三方的 sub-agent）安全 by construction：每一 hop **只能 ATTENUATE**（子的 capability 集合恆為父的嚴格子集，runtime enforce）；sub-agent 跑在隔離 sandbox，無路徑碰到 sibling/parent 的 credential；credential per-hop 注入，full secret 永不下傳；每個 hop emit audit event，組成可端到端重建的 authority chain；delegation-graph inspector 回答監管者的「誰在誰的授權下做了什麼」。
- **誰買：** 在生產跑 multi-agent orchestration 的 platform eng + security team，以及需要治理底座才能「enterprise-credible」的 orchestration-framework vendor。
- **為何只有 Agent OS 能做：** 是 deny-by-default policy（attenuation-only）+ credential isolation（per-hop scoped 注入）+ sandbox isolation（無 sibling/parent credential 路徑）+ per-hop tamper-evident audit 的**聯集**。LangGraph/CrewAI 協調 agent 但「無 permission governance layer」；identity vendor 驗 WHO 不驗跨 hop 的 WHAT。
- **需要的功能：** capability/policy 代數（檔案/網路/process/inference/tool 上 well-defined 的 intersection/subset）+ admission check（child ⊆ parent）；per-hop scoped credential minting；sandbox-per-sub-agent + sibling-isolation 回歸測試；AgentSession/delegation-edge 資料模型；per-hop OCSF event；delegation-graph inspector；SDK hook 讓 orchestrator 衍生 governed sub-session（不取代之）。
- **新穎度（gap）：** RSAC 2026 五家（Cisco/CrowdStrike/Palo Alto/Microsoft Entra Agent ID/Cato）出 agent identity，業界明指 delegation trust + action governance 是「全部都漏」的缺口（「no product currently follows the delegation chain between agents」）。IETF RFC 8693 token-exchange 仍 standards-stage。
- **why now：** agentic CVE 年增 255%，多由 over-broad / long-lived / un-revocable credential 造成；100-agent swarm 無人審批就自動 commit 的案例。
- **分數：** market 5 / feasibility 4。**對 multi-agent 經濟最直接的「demo→production」閘門控制。**

### 2.5 Blast-Radius-Budgeted Production Change Agent：live infra 上有硬傷害上限的 scoped、approval-gated、idempotent ops（c10）

- **是什麼：** 讓 agent 真的**執行**有界生產變更（apply migration、scale fleet、cordon nodes、rotate cert、修髒資料），但把「能搞壞多少」變成預先宣告、被 enforce 的硬數字。每次 tool 呼叫前，policy engine 由 ToolManifest 的 side-effect estimator + live cluster state 算出 blast radius（replica% / node / $ / tenant / 資料敏感度），預算用罄即 by-construction DENY，超預算升級到人；保證 idempotent resume，被砍的 agent 不會 double-apply；dry-run/plan-then-approve 用 diff 把關 apply。
- **誰買：** 有 on-call 與 revenue-per-minute 的 VP Platform Eng / Head of SRE；被 change-management/SOC2 卡住的 DevOps 工具 vendor。
- **為何只有 Agent OS 能做：** 一次需要所有 pillar——deny-by-default scoping、per-step scoped+expiring approval、JIT credential（prod token 不落到 agent 手上）、resume idempotency、full audit。只有坐在 privileged path 的 Agent OS 能把 blast radius 當預算（像 proxy 對待 egress），並 emit「超預算不可能」的 tamper-evident 證明。Generic agent 只能「努力小心」，無法讓超半徑動作不可能。
- **需要的功能：** consumable 多維 blast-radius-budget policy 原語（stateful，net-new）；ToolManifest radius/cost-estimator 欄位；pre-execution effect estimator（查 k8s/cloud inventory，不確定即保守 fail-closed）；blast-radius 入 approval record + 自動升級；idempotency key + resume ledger；dry-run/plan diff gate。
- **新穎度（gap）：** 離散原語已在市場討論（Rego deny-over-$5k、spend envelope、risk-tier interception），但「單一、多維、consumable、跨異質第三方 agent、配 JIT prod credential + idempotent resume + 超預算不可能之證明」尚未產品化；incumbent 綁自家單一 agent 與自家雲（Azure→Azure）。
- **why now：** agentic SRE 已成大且資助的類別（Azure SRE Agent 2026-03-10 GA、Resolve.ai、Cleric、Rootly…），但全業界硬天花板是「read-only 無人值守、remediation 等人」。
- **分數：** market 5 / feasibility 4。**這組最清晰的商業 wedge。**（estimator 精度是真實風險；fail-closed 讓不準只降自主性、不降安全。）

### 2.6 Agent Information-Barrier (Chinese Wall) Runtime：跨 MNPI side 的可證非污染（c12）

- **是什麼：** 把每個 AgentSession 指派到一個「side（deal/research/trading）」作為**高於 tenant** 的一級隔離域：per-side sandbox，無共享 filesystem/memory/cache/vector store/inference context；任何跨 side 存取 by construction 拒絕並升為 wall-crossing 合規事件；附「可證非污染報告（cryptographic non-contamination report）」證明某 session 從未碰過 across-the-wall 資料；control-room override（logged、time-boxed、four-eyes 的合法 need-to-know）。
- **誰買：** bulge-bracket / boutique 投行的 Head of Control Room / Compliance、CCO。
- **為何只有 Agent OS 能做：** information barrier 本質是 isolation + deny-by-default + audit（Agent OS 核心），cross-tenant 自然推廣為 cross-WALL。一個帶共享 RAG/memory/inference 的 generic framework **結構上無法**證明非污染——讓 agent 有用的那個特性（共享 context）正是合規失效點。DLP/surveillance 監人/email、事後偵測，無 cryptographic 證明。
- **需要的功能：** 「Side/Wall」一級隔離域（高於 tenant）；wall-crossing policy + 合規事件 class；**per-side 分區的 governed memory/vector store（NET-NEW，最大 scope 風險）**；per-side inference routing（model cache/context 不可橋接）；hash-chained per-session access log 之上的 signed non-contamination 報告；four-eyes control-room override。
- **新穎度（gap）：** 2026 研究明確點名「advisory-side vs trading-side agent」未解；multitenant RAG 研究實測 98-100% 跨租洩漏，印證核心論點。closest（surveillance / generic agent governance / secure-RAG）皆 detective、面向人、或單 corpus。
- **why now：** FINRA 2241/2242、Investment Advisers Act 204A、FCA SYSC 10.2、SEC OCIE information-barrier exam；MNPI 洩漏 = 執法 + 罰款 + 名譽。
- **分數：** market 4 / feasibility 4。TAM 窄（少數銀行）、採購慢，但 ACV 大、differentiation 5/5。

### 2.7 Tenant-Sealed Agent Fleet：一個 agent image、N 個客戶 estate、跨租存取 by construction 不可能（c3）

- **是什麼：** 同一個 untrusted agent image 跑在數百個 tenant（MSP 客戶 estate、SaaS 的 BYO-agent marketplace、data vendor 的 per-customer warehouse pipeline），每個 tenant 各自 credential bundle / sandbox / policy / blast-radius budget / egress allowlist / audit 分區，跨租讀寫**結構性不可能**（gateway-per-tenant / namespace-per-tenant，是 process 邊界而非 `tenant_id` 過濾）。把持續跑的 Tenant Isolation conformance suite 變成**可賣的 artifact**：signed per-customer isolation attestation +per-customer audit feed + approver-of-record routing。
- **誰買：** MSP/MSSP COO / VP Service Delivery；建 agent extensibility 的 SaaS VP Platform；data & AI SaaS vendor 的 VP Eng / CISO；以及客戶端 procurement/security。
- **為何只有 Agent OS 能做：** cross-tenant isolation by construction + per-tenant credential 注入 + per-tenant audit 是核心 pillar。Generic platform 讓多租戶變開發者的 in-process 共享狀態問題；Agent OS 讓跨租動作成為「可測的結構性不可能」並 emit per-customer 證據。
- **需要的功能：** tenant/sub-tenant hierarchy；process/namespace 邊界隔離（**非 `tenant_id` row 過濾**——載重原語）；per-tenant egress allowlist；per-tenant JIT credential 注入；持續跑、release-blocking 的 Tenant Isolation conformance suite（可作合規 artifact）；embeddable AgentSession SDK；tenant-partitioned client-deliverable audit feed；signed per-tenant isolation attestation。
- **新穎度（gap）：** 隔離底座正快速 commoditize（D3 Morpheus、Blaxel microVM+SOC2、Rafter、Scalekit、Microsoft agent-governance-toolkit）。durable wedge = **attestation-as-product + 治理 untrusted 第三方 image 的姿態**（SOC2 報告是 vendor-wide、NDA-gated，非 per-customer agent-isolation attestation），**不是隔離本身**。
- **why now：** 銀行要求書面 isolation attestation；2026 BYO-agent marketplace + per-customer pipeline 使之急迫（惡意 marketplace agent 已現蹤；OAuth token 不帶 tenant 邊界）。
- **分數：** market 4 / feasibility 5。**最可行且最 on-thesis——本質是把 Enterprise 模式的核心不變量產品化。**（pooled isolation tier 給長尾小租戶時，務必維持 process/namespace 邊界，不可悄悄退化成 `tenant_id` 過濾，否則整個 pitch 崩。）

### 2.8 Insurable Autonomy：可承保並定價 agent E&O 的 control-attested 治理 telemetry（c2）

- **是什麼：** signed、tamper-evident、**deployer-INDEPENDENT** 的治理 telemetry feed（deny rate、escalation rate、approval dwell-time vs 橡皮圖章、credential-scope 緊度、isolation-tier-in-force、blast radius、被擋的 sandbox-escape），保險人拿來當「承保並定價 autonomous-agent 失效風險」的精算輸入。算出 Insurability Score + continuous risk-posture attestation，可綁保單條件（停用 deny-by-default 即 void coverage）。
- **誰買：** 供給側——AI-agent E&O/liability 保險人、MGA、reinsurer（付精算 feed + 保單綁定整合）；需求側——CRO / 想要保費折扣的企業。類比車險 telematics 的自我強化飛輪。
- **為何只有 Agent OS 能做：** telemetry 在動作路徑產生、非被保人自報——擊穿讓 agent log 對承保人毫無價值的 moral hazard。能證明 negative（無 credential 落地、isolation hard-requirement in force），並用 dwell-time / evidence-viewed 區分真 oversight 與橡皮圖章。
- **需要的功能：** 標準化 signed「governance posture」telemetry stream；audit ledger 之上、信任邊界外算的 Insurability Score；continuous risk-posture attestation + coverage-binding hook；insurer-facing read-only API/SDK（per-tenant consented）；real-oversight-vs-rubber-stamp metrics；tamper-evident posture history；isolation-tier downgrade 視為 material risk event。
- **新穎度（gap）：** Klaimee / AIUC 做 point-in-time 認證/審計 + 保險（self-attested 或 auditor-snapshot）；**無人**提供「continuous、deployer-independent、signed、在 enforced action path 產生的 controls-in-force telemetry + coverage-binding」。
- **why now：** ISO/Verisk 通用 AI CGL 除外（2026-01，影響 ~82% P&C 保單）；多家 AI-agent E&O carrier/MGA 2026 開張（Mount YC S26、Corgi、Klaimee、Armilla+Chaucer），承保資料極度匱乏。
- **分數：** market 4 / feasibility 4。two-sided cold-start + 標準可能被 carrier/AIUC 自建是風險。**屬「白地」型旗艦——同時列入 §4。**

> **未進旗艦但確定 KEEP 的近旗艦：** **Break-Glass Delegated Authority（c5）**——ephemeral、scoped、self-revoking 的 agent「power of attorney」（mint→inject→use→revoke→expire 的 lease lifecycle，hard TTL、限額/受款人/資源綁定、真正切斷 mid-task 的 kill-switch）。market 5 / feasibility 4，是**多數其他旗艦依賴的基礎原語**（c4/c10/c19/c22 都建在它上面），但 differentiation 僅 3（JIT token broker 已 commodity：Britive/Aembit/Teleport/Infisical Agent Vault/Vault+STS）。定位必為「credential governance 融合 sandbox isolation」而非「又一個 JIT token broker」。**Provable-Access RAG（c17）**——retrieval-time 在 agent 之外做 per-cell ABAC entitlement + per-answer provenance receipt（market 4 / feasibility 3）；wedge 是「untrusted agent 無法繞過 + per-answer 收據」，非 generic RAG authz（Cerbos/Oso/Permit 已做 caller-trusting 的 row-level 過濾）。

---

## 3. 高潛力領域（broader domains）

較廣的領域機會，需求成立但部分能力正在 commoditize 或需 design partner 驗證。

| 領域 | 候選 | 機會與買方 | 治理 wedge / 風險 | 分數 (m/f) |
|---|---|---|---|---|
| **Regulated / RegTech** | Compliance Evidence Runtime（c11） | 在 agent 可做的受規範工作中，「治理 trail 即產品」：proxy 在 **field/column 層**做 minimum-necessary minimization（PHI 18 識別符、Safe Harbor/k-anonymity 轉換、跨查詢 re-identification scoring），每條 AllowRule 對應 control ID（HIPAA/EU AI Act/SOC2/Part 11），per-task 導出 auditor-ready evidence pack。買方：CCO/GRC、CPO、data governance（finance/health/insurance/pharma）。 | Wedge = 「做 minimization 的邊界，正是證明 minimization 的邊界，且 agent 是 untrusted」。風險：空間擁擠（OneTrust/Credo/Straiker/hoop.dev）、cross-query re-id scorer 是硬 data-science、Aug-2026 deadline 已滑（standalone high-risk 移至 2027-12）。 | 5 / 4 |
| **Sanctions / Financial Crime** | Pre-Action Sanctions/OFAC Gate（c13） | 在動作執行**前**於 runtime 篩 counterparty/egress 對 OFAC SDN/EU/UN——pre-action 授權閘而非事後 alert；blocked 即 SAR-formatted audit + versioned list snapshot 綁定決策供 replay。買方：Head of Financial Crime / BSA Officer、CCO。 | Wedge = 在 egress 授權時刻攔截、跨任意 rail（feasibility 4，是 deny-by-default egress proxy 的近乎直接 reuse）。但 market 3 / differentiation 2：CLEARAGENT/Rain/Unit21/Sardine/WorkFusion 已做 pre-settlement 篩查，篩查邏輯是 commodity。**最佳定位：attach 到 Maker-Checker（c4）/Delegated Authority（c5）的 feature，而非 standalone wedge。** | 3 / 4 |
| **Identity / Reputation** | Agent Passport & Counterparty Trust Score（c19） | 由 runtime 親見的**非偽造行為證據**（policy-violation rate、credential hygiene、dispute/escrow 結果）鑄造可攜 signed identity+reputation（DID/VC）；policy 可要求「trust score ≥ N」；以及 **Delegation Capsule**（signed、expiring、scope/spend-capped、runtime-enforced 且 agent 物理上不可逾越的授權）。買方：marketplace operator、onboard 第三方 agent 的企業、保險人。 | Wedge = 「只有治理執行的人，才能鑄造無法作弊的行為 reputation」。Delegation Capsule 是高可行近期可交付件（≪12mo）。passport 互通正在 commoditize（W3C Agent Identity CG、ERC-8004）、有「35% portability discount」+ network-effect cold-start；ZK 最小揭露與 cross-runtime federation 列 phase-2。 | 4 / 3 |
| **Government / Defense** | Sovereign / Air-Gapped Agent Enclave + Cross-Domain Guard（IL5/IL6）（c21） | 離線 on-prem 治理底座：on-prem inference/telemetry（不 phone-home）、offline tool registry、supply-chain attestation gate（EO 14028/SLSA，drift 即 deny）、continuous-ATO（評估 agent 唯讀、結構上寫不到 evidence ledger）、cross-domain no-write-down 資訊流 lattice。買方：Cross-Domain AO、DoD/IC/DOE AO、ISSO/3PAO、coalition C2/NATO。 | Wedge = 把 untrusted agent 當 Bell-LaPadula 主體做 no-write-down + coalition tenants=nations + SoD evidence ledger（generic framework 做不到）。風險：SigilArk/Glyphon 已在 IL4/5/6 air-gapped 出貨（air-gap/audit 已被競爭）；軟體 no-write-down ≠ 認證 CDS；IL5/IL6 ATO 是 12-36 月、3PAO 依賴；**硬前置：須確認 OpenShell 能完全 disconnected 運行**。 | 4 / 3（feasibility maybe） |

---

## 4. 白地 / 尚未被發現（explicit — 投機性）

> **誠實標註：以下為大膽、少人做的第二序機會。多數是 moonshot：技術上 plausible 且最大化利用 Agent OS 的 pillar，但部分依賴兩面採用（two-sided adoption）、研究級 component（cross-org 共享 ledger、ZK、DP-composition）、或尚未成形的買方需求。是「先卡位、後驗證」，非近期營收賭注。**

### 4.1 Agent 責任險 / Insurable Autonomy（c2，亦列旗艦）

把治理 posture 變成精算商品（見 §2.8）。**投機點：** 兩面 cold-start，且 carrier/AIUC 可能自建標準而非買中立 feed。這是「agent 責任險」白地最具體的形態，why-now（ISO 除外）最硬。

### 4.2 Evidence-grade Audit / Flight-Recorder（c1，亦列旗艦）

Oversight-of-Record（見 §2.1）即「evidence-grade agent flight-recorder」白地的旗艦化身：attest-the-negative + decision-path replay + external anchoring。**投機點：** 類別升溫快，必須以 in-path 全 stack 的「attest-the-negative」差異化才不被 GRC observability 吞掉。

### 4.3 Agent Mesh：跨組織可組合的治理工作流，各組織保有自己的治理邊界（c7）

我方 procurement agent 與你方 sales agent 協商、我方 logistics agent 在你方 carrier agent 訂艙——每組織把對手互動跑在自己的 Agent OS cell（deny-by-default egress、scoped credential 不過線），並共享一份**雙方都能獨立驗證、因為都不是任一方 agent 寫的** tamper-evident audit。一個 governed session 把另一組織的 governed session 當「declared、scoped、audited 的 tool」在兩方 policy 下呼叫（capability federation）。
- **為何只有 Agent OS：** 跨信任邊界的 governed execution 組合，唯有**兩端都有治理 runtime** 才可能。A2A/MCP/x402 標準化 message/payment，但都假設各組織信任自己 agent 的自報 log。
- **投機性：** market 4 / feasibility 2。moonshot，依賴 Agent OS 成為兩端標準（chicken-and-egg）+ cross-org 共享 hash-chained ledger（研究級分散式信任）。**應在單組織 Escrow + Oversight-of-Record 原語成熟後才播種，屬 phase-2。**

### 4.4 Agent Treaty Runtime：機器協商的協議編譯成 runtime-enforced 雙邊 policy（c8）

兩組織 agent 協商條款（API rate/pricing、data-sharing scope、供貨承諾），協議編譯成 matched、signed 的 policy bundle，各自 Agent OS 在本地對自己 agent enforce——任一方不能偷偷作弊、雙方都能證明談了什麼；shared compliance ledger + 自動 breach 偵測；人類批准閘（agents 提案、人批准才生效）。
- **為何只有 Agent OS：** treaty 就是雙邊 policy，因為各方 deny-by-default enforcer **物理上**阻止自己 agent 違約而安全。Generic framework 能輸出合約文字，但無法保證自己 agent 遵守、也無法向對手證明。
- **投機性：** market 3 / feasibility 2。Pactum 等驗證了「協商」需求，但賣的是 artifact 非 enforcement；雙邊 mutual-enforcement + shared ledger 是未認領白地，主要風險是兩面採用，且面對 on-chain（ATCP/IP）替代敘事。**可行 slice：單邊 enforceable-commitment + 自證 audit trail 給對手。** Singapore IMDA Agentic-AI 框架（2026-01）點名 multi-agent liability 為未解。

### 4.5 Counter-Agent Deception Range：安全誘捕並 forensically 捕獲 autonomous AI 攻擊者的 governed honeypot（c15）

反轉論點：Agent OS sandbox 一個**敵意** agent。蓄意可被攻陷的 deception range 跑 live attacker code、deny-by-default egress 使其 pivot 到虛無；decoy honeytoken CredentialBundle 只開 honeypot 資源、一旦在別處使用即告警；每個動作進 tamper-evident log 作 court-admissible intel + autonomous-adversary TTP fingerprint。
- **為何只有 Agent OS：** 容納 trusted-but-untrusted agent 的同一組 isolation/deny-egress/credential/audit，正好安全容納蓄意敵意者並捕情報。沒有完美隔離，在你網路旁跑 live 對手 code 本身就是 breach。
- **投機性：** market 3 / feasibility 4。threat class 尚早（領先研究 3 個月只見 ~8 個候選 AI 攻擊者），買方窄而慢（CERT/frontier lab/deception vendor），incumbent（CounterCraft/VMRay/CrowdStrike/Acalvio）可能吸收為 feature。**高 differentiation 的 moonshot，給 frontier-lab/CERT design partner，非近期營收。** chain-of-custody / TTP attribution 是我們缺的領域能力。

### 4.6 Regulation-to-Policy 連結 + Agent Passport / Delegation Capsule（c16、c19）

- **Regulation-to-Policy Compiler（c16）：** 把法規編成同時是（a）律師審過的 clause mapping、（b）machine-enforced deny-by-default gate、（c）fire 時 emit clause-citing 證據的 policy-as-code；法規變更時出 DIFF（哪些 clause 變、哪些 policy 不合規、哪些 agent 動作翻轉 allow/deny）。**投機點：** market 4 / feasibility 3。可行且差異化的子集 = provenance-bound policy + clause-citing PolicyDecision + policy-change flip 模擬 + version drift alert；**但「NL 法條→enforced policy 的自動 compiler」是未解 NLP/法律推理問題 + 責任風險，必須降級為「律師作者的 mapping workbench」。**
- **Agent 身分與委任授權（c19）：** 見 §3。**Delegation Capsule 是這片白地最可交付的近期件**；portable passport / cross-runtime federation / ZK 揭露屬投機 phase-2。

### 4.7 Agent fleet 治理 / Compliance-as-a-Service（橫向白地）

跨上述者浮現一條橫向白地：把「治理 posture + 證據 + 委任 + isolation attestation」打包成**對外可交付、可訂閱的 fleet-governance / compliance-as-a-service** 層——signed isolation attestation（c3）、insurability score（c2）、evidence pack（c1/c11）、delegation-graph 證據（c20）、agent passport（c19）皆為其組件。**投機性：** 高；是 §2 多旗艦商業化後的聚合產品，現階段作為「north star 收斂方向」記錄，不單獨投入。

---

## 5. 反推的 Agent OS 該有功能（rollup，直接餵 roadmap）

把所有 survivor 的 impliedFeatures 聚合、去重、排優先級。標註對應現有 7 大 pillar（延伸 = Extend）或新功能（新 = Build-new）。**P0 = 多旗艦共同硬依賴；P1 = 旗艦核心；P2 = 領域/白地專屬。**

| 優先 | 功能 | pillar 對應 | 服務哪些候選 | 備註 |
|---|---|---|---|---|
| **P0** | **Durable、append-only、hash-chained、signed 的 tamper-evident audit sink（WORM/17a-4），agent 無寫入權，從 supervisor/gateway 路徑（非 sandbox-local JSONL）持久化** | audit（新——OpenShell 今天無 durable 中央 store；JSONL 預設 OFF、gateway buffer in-memory、無 signing/hash-chain） | c1, c2, c3, c4, c6, c10, c11, c17, c19, c20, c23, c24 | **最重的單一 lift，且是 c1/c4/c23 法律/合規價值的 gating 前置。** |
| **P0** | **OCSF AgentContext 擴充**：每個 event 填 actor_id / tenant_id / project_id / task_id / sandbox_id / request_id / result | audit（延伸——schema 已定義 `tenant_uid`/`correlation_uid`，Rust `Metadata` struct 未填值；研究列為「最小第一任務」） | 全部 | 低成本、解鎖一切下游 evidence。 |
| **P0** | **enforced runtime credential/PII redaction filter**（包住 OCSF JSONL/audit 路徑，allowlist scrub stage） | credential / audit（新——目前是 convention 非 enforced） | c1, c6, c11, c24 | Credential Non-Leak invariant 的硬化。 |
| **P0** | **per-route / per-model inference policy gate**（deny-by-default，關掉 `inference.local` 繞過 OPA 與 local-mode empty-route deny gap） | inference routing（新/upstream PR——`inference.local` 刻意繞過 OPA） | c11, c17, c18, c21, c24 | 沒它，授權資料可經 model route 外洩。 |
| **P1** | **Tenant / sub-tenant hierarchy + gateway-per-tenant / namespace-per-tenant 進程邊界隔離**（非 `tenant_id` row 過濾）+ Tenant Isolation conformance suite（release-blocking） | enterprise tenant/IAM（新——無 Tenant 物件、cross-tenant「refuted」） | c3, c2, c7, c12, c14, c21 | Enterprise 模式存在的前提；c3 直接產品化此不變量。 |
| **P1** | **泛化 ApprovalRequest 引擎**：超出 network policy，涵蓋 file/process/credential/tool/irreversible-op；dual-control（maker≠checker）；typed 欄位（actor/resource/action/risk/expiration/scope）；Z3 finding-delta 作 risk_summary | approval（延伸——proposal→Z3-prover→pending-inbox→approve/reject/edit/undo 已存在，目前 network-centric） | c4, c5, c10, c19, c20, c22, c24 | approval UX consistency loop 的落地。 |
| **P1** | **ephemeral、scoped、self-revoking CredentialBundle（lease lifecycle）**：hard TTL、限額/受款人/資源綁定、scope 越界自動 revoke、per-request scope-derivation engine、真正切斷 mid-task 的 kill-switch | credential（新——RFC 描述但未實作；短 TTL token minting 已存在 `provider_refresh.rs`/`token_grant_injection.rs` 可 reuse） | c5, c4, c10, c20, c22 | 多旗艦的基礎原語；mid-task sever 對非網路 grant 受 Landlock immutable 限制（須 broker/egress revocation hook）。 |
| **P1** | **Decision Record + deterministic decision-path replay engine + standalone independent verifier**（綁 action↔exact policy version↔PolicyDecision↔approver↔credential scope↔content-addressed input；重放決策路徑、非重抽模型） | audit（部分延伸 + 新——typed PolicyDecision + Z3 provenance 已有；replay/verifier 為新） | c1, c16 | attest-the-negative 與 evidence export 的核心。 |
| **P1** | **ToolManifest / ToolInvocation registry**（name/version/input·output schema/required permissions/side-effect classification + radius·cost estimator/timeout/audit behavior/docs；第三方 agent image 的 required-scope 宣告與打包） | tool registry（新——OpenShell 無原生 Tool 物件） | c6, c10, c13, c20, c22, c24 | Tool Registry Contract loop；c10 的 estimator 欄位掛在此。 |
| **P1** | **Agent OS 受管路徑為唯一路徑** + binary-identity TOFU 強化（在 managed entrypoint 之外啟動會喪失 policy/credential 注入） | sandbox runtime adapter（延伸） | c4, c6, c23, c24 | 否則 SoD / escrow / RoE 會被靜默繞過（NemoClaw caveat）。 |
| **P1** | **per-credential-use、resource-level AuditEvent + over-permission diff（declared vs actually-used scope）** | audit / credential（延伸） | c6, c5, c11, c20 | escrow execution receipt 與 least-privilege 證據。 |
| **P2** | **SoD / conflict-pair policy 原語**（capability-grant 時 enforce 不相容 capability 對）+ step-scoped role-distinct credential bundles + amount/beneficiary-bound L7 body-match | policy / credential（新概念疊在現有 enforcement） | c4 | Maker-Checker by construction 的核心。 |
| **P2** | **consumable 多維 blast-radius-budget policy 原語**（stateful per-incident/window 累計）+ pre-execution effect estimator（查 live infra、保守 fail-closed）+ idempotency key/resume ledger | policy / orchestration（新——OPA evaluator 是 stateless binary allow/deny） | c10, c22 | task resume idempotency loop；估算不準只降自主性、不降安全。 |
| **P2** | **「Side / Wall」一級隔離域（高於 tenant）+ per-side 分區 governed memory/vector store + per-side inference keying + non-contamination 報告** | isolation / inference / audit（新——記憶體/RAG 層非 OpenShell 原生，最大 scope 風險） | c12, c14, c18 | Chinese-wall / sealed-room 的核心 net-new 子系統。 |
| **P2** | **field/column-level deny-by-default + 標籤化 + inline de-identification（Safe Harbor/k-anonymity/tokenization）+ 跨查詢 re-identification scorer + control-framework mapping + evidence-pack export** | policy / audit（延伸 + 新；re-id scorer 是硬 data-science） | c11, c17, c18 | proxy query-rewrite/response-filter 層；v1 先單查詢 minimization，跨查詢 scorer 列 fast-follow。 |
| **P2** | **Delegation Capsule + signed behavioral attestation（VC over audit ledger）+ counterparty_trust_score ≥ N policy predicate** | policy / credential / audit（延伸） | c19, c20 | Capsule 近期可交付；cross-runtime federation + ZK 揭露 phase-2。 |
| **P2** | **non-exfiltration custody mode**（deny-all egress + in-boundary inference + read-only no-write-back mount + output-channel gate + DerivedArtifact provenance + signed custody attestation）+ honeytoken CredentialBundle + forensic-capture audit mode | isolation / inference / credential / audit（組合既有 + 新 output classifier） | c18, c15 | output classifier 對抗式可繞（steganographic），強保證須 human output-release + 結構化低頻寬輸出；attestation 措辭須限定在 OS-enforced channel。 |
| **P2** | **pluggable screening-provider adapter（OFAC/EU/UN）+ versioned list-snapshot 綁定 + L7 counterparty extraction/fuzzy match + SAR formatting** | policy（延伸 pre-action hook） | c13 | attach 到 c4/c5。 |
| **P2** | **capability/policy 代數**（檔案/網路/process/inference/tool 上 well-defined 的 intersection/subset operator）+ delegation-edge 資料模型 + delegation-graph inspector + 對 LangGraph/CrewAI 的 SDK hook | policy / orchestration / SDK（新） | c20, c7 | 最難一塊；須專屬 adversarial test suite 證明 child 無法升權/竊取 parent/sibling secret。 |
| **P2** | **per-engagement RoE-to-policy compiler/validator + per-session time-window TTL（hard kill）+ signed engagement attestation** | policy / orchestration（薄層疊在 SandboxPolicy） | c23 | 三項中兩項近 reuse；attestation 依賴 P0 audit sink。 |

---

## 6. 推薦的 beachhead 與下一步驗證

**先打哪個楔子（建議排序）：**

1. **Personal-first 楔子 → Local-First Per-Client Workstation（c24）作為「載具」與漏斗。** 評審給 c24 feasibility 5（「almost out-of-the-box」於 Personal/local 模式），且它的 build surface 幾乎逐項對應 §5 的 P0（durable hash-chained sink、inference route gate、credential redaction、泛化 approval）。它讓我們在**單機、無多租戶控制面**的最低風險環境下，先把 P0 基礎件做出來並驗證——這些件接著被所有 Enterprise 旗艦復用。market 僅 3（買方付費意願軟），故定位為 **dev-advocate 漏斗 + P0 試煉場**，不是主要營收賭注。

2. **Enterprise lighthouse 楔子（二選一，平行 design partner）：**
   - **Agent Escrow（c6）** —— 最高 conviction、雙邊拉力、pain 已被金額量化（6-12 週 security review 殺原型），且 1:1 對應 OpenShell 最強 confirmed 原語（credential 不落地 + deny-by-default egress）。
   - **Tenant-Sealed Agent Fleet（c3）** —— feasibility 5、最 on-thesis，本質是把 Enterprise 不變量產品化；其 P1（gateway-per-tenant 進程邊界隔離）正是 Enterprise 模式存在的前提。
   兩者都把 **§5 的 P0 audit sink** 變成 gating 依賴，與 c24 共用基礎。

3. **隨後接 Oversight-of-Record（c1）+ Maker-Checker（c4）。** 兩者把已建的 P0 audit sink 升級成「法律 system-of-record」，吃下最硬 why-now（PLD 2026-12 / SOX PCAOB 2026-12），是最大 ACV 的旗艦。

**要驗證什麼假設（按優先）：**

1. **【最高】signed attestation / evidence pack 的「auditor-grade 可採信度」假設。** c1/c3/c4/c18 的價值全押在「signed claim 是資產而非負債」。**驗證方式：** 找 1-2 個 design partner（含其 outside counsel / auditor / E&O insurer）審視我們的 attestation 措辭與 evidence bundle，確認可採信、且 attest-the-negative 與 covert-channel 邊界誠實標定。**這是技術之外的最大不確定性。**
2. **P0 audit sink 的工程假設。** durable、append-only、hash-chained、signed、從 supervisor/gateway 持久化、尊重 gateway object-store CAS 契約（避免 HA lost-update）。**驗證方式：** 先做最小 PoC + standalone verifier，跑 §5 P0 全鏈。
3. **「受管路徑唯一」假設。** SoD/escrow/RoE 一旦能在 OpenShell managed entrypoint 之外啟動 runtime 即靜默繞過。**驗證方式：** 對抗式測試證明繞過路徑被堵（NemoClaw caveat）。
4. **gateway-per-tenant 隔離假設（Enterprise）。** cross-tenant「by construction 不可能」目前 refuted（僅因單租戶）。**驗證方式：** 跑 Tenant Isolation conformance suite（c3 的可賣 artifact），把 pooled isolation tier 維持在 process/namespace 邊界。
5. **buyer WTP 與 pain 的對齊。** c24 的「客戶是否契約性要求個人 freelancer 提供 notarized run」未證實；c6 的 vendor 是否願把 image 送進客戶 perimeter（有些偏好自家雲）。**驗證方式：** design-partner 訪談先於擴大投入。

---

## 7. 簡短「考慮過但暫不推薦」（誠實）

5 個候選在 market 或 feasibility 任一維度被評為 maybe/kill、或定位後判定不單獨追：

| 候選 | 一句話理由（不推薦/降級） |
|---|---|
| **c9 Agent Escrow & Settlement Clearinghouse**（持有 funds + deliverable 的中立結算所） | maybe（m3/f3）。空間擁擠且快速收斂於 crypto/on-chain rail（ERC-8183、Arkhai、RAILS、x402/AP2、Kleros）；RAILS 明確主張可不靠 execution isolation 達成可信結算，削弱「需 sandbox」論點；**持有真實資金 = money-transmitter/MTL/KYC 的非工程硬 blocker**。可行 slice 限縮為非貨幣/partner-settled escrow。 |
| **c14 Federated Sealed-Room Mesh for Regulated Research**（跨機構 agent 證明不混合站點資料） | maybe（m3/f3）。買方池小且採購極慢（多季 consortium/legal cycle）；**cross-tenant DP-budget accountant 是研究級正確性工作**（OPA 是 stateless per-request，無跨查詢 re-id 會計）；需先建整個 Tenant 層（現 refuted）；incumbent（Lifebit/Rhino/Owkin）擁有資料網路可加「untrusted-agent mode」。需 design-partner consortium 證明法律可採信才升 keep。 |
| **c7 Agent Mesh**（跨組織可組合治理工作流） | maybe（feasibility 2）。differentiation 5 但 moonshot：依賴兩端標準採用（chicken-and-egg）+ cross-org 共享 hash-chained ledger（研究級分散式信任）。**降為 phase-2 白地**，須單組織 Escrow/Oversight 原語先成熟（見 §4.3）。 |
| **c8 Agent Treaty Runtime**（協商編譯成雙邊 runtime-enforced policy） | maybe（m3/f2）。雙邊 mutual-enforcement + shared ledger 是真白地，但兩面 cold-start + on-chain 替代敘事（ATCP/IP）；as-stated core 在窗口內不可交付。**可行 slice = 單邊 enforceable-commitment + 自證 audit；降為 phase-2 白地**（見 §4.4）。 |
| **c13 Pre-Action Sanctions/OFAC Gate**（作為 standalone wedge） | maybe（m3/差異化 2）。runtime egress 攔截 feasibility 高，但篩查邏輯（SDN 解析/list 版本/SAR）是 commodity，CLEARAGENT/Rain/Unit21/Sardine/WorkFusion 已做 pre-settlement；OFAC 法定執行點仍在 payment system。**不單獨追——降為 c4/c5 的 attach feature**（見 §3）。 |

> 另記：**c22 Critical-Infrastructure Action Airlock**（OT/grid/telco）survivor 中 feasibility 最低（2，maybe）——治理 spine 完美契合，但 Modbus/OPC-UA/DNP3 binary-protocol DPI + stateful 安全包絡 + IEC 62443/SIL 認證使 tri-domain scope 在 6-18 月不可交付。**保留為單域 wedge（先 telco router/switch config，最接近現有 SSH/CLI proxy + ITIL/CAB）**，但不列近期旗艦。**c15、c18、c21** 同為高 differentiation 但近期非營收賭注，已歸入 §3/§4。

---

*方法：本綜整以 24 個 candidate 的雙維度評審 verdict（market + feasibility，各附 rationale 與 competitorsOrEvidence）為輸入，對照 [openshell.md](./openshell.md) 的真實原始碼勘查與已採用的策略 B。凡屬投機白地皆明示。不含任何 secret-like 值。*
