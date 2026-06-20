# Agent OS — 完整產品架構（一台會自己操作的電腦）

> 2026-06-20，Staff+ 架構團隊（讀真實 repo + Hermes 原始碼）產出，**校正版**：能力 × 體驗為 headline，治理為**支援子系統（保留、不刪）**，願景**不縮**。
> 取代先前 governance-centric 的草稿（那版把「安全帶」當成了「車」）。權威定位見 [`AGENTS.md`](../../AGENTS.md) north star。

## 產品一句話
**Agent OS 是一台會自己操作的電腦**：你用**說的或打字**說出意圖，整台電腦（瀏覽器、檔案、Email、行事曆、終端機、網路、每個 app）就**自己完成**。個人**比手機還好用、零學習成本**；企業**一個人就能讓整間公司自己運轉**。底層由一個會自我進化的 **brain（預設 Hermes，可換）** 驅動，後面有一個**隱形的 undo／稽核／信任子系統**兜底。

## 三層架構（OpenShell＝身體 · Hermes＝腦 · agent-os＝脊椎 + 新膠水）
```
體驗層（薄，NEW P2）         IntentGateway(語音/文字，最先建) → clarify(≤3 白話問題) → 計畫預覽(白話、非 JSON)
                            → ApprovalInbox(敏感才點一下) → TaskTimeline(從 WORM 重建、可離線驗) → 白話失敗處理
                            ＋ 任何裝置入口（重用 Hermes gateway：Telegram/Slack/WhatsApp/Signal/Email/SMS）
                            ＋ 企業 operator console（P3：一個畫面開公司）
能力引擎（心臟，DOING）       Brain Port（預設 Hermes、可換）→ intent→plan→tool-call 串流 + memory/skill 變更事件
                            ── 每一步走 Commit-Before-Effect：AgentContext → XState orchestration(可 resume 步圖)
                               → ToolManifest 註冊檢查(未註冊→deny) → PDP(deny-by-default) → 敏感則 approval
                               → CredentialLease(僅 bundleRef) → canonical+redact 的 AuditEvent Append 到 WORM 並等 Receipt
                               → 才在 OpenShell sandbox 執行(SecretResolver egress 注入 secret；Landlock/seccomp/microVM；egress allowlist)
                               → 結果 audit → timeline 重建
                            ── 廣度與自我進化來自 Hermes：6 執行後端 + computer_use/browser/file/code + curator 學習迴圈 + cron + subagents
支援子系統（配角，BUILT P1） Go evidence kernel（append-only 簽章 hash-chain + 離線 standalone verifier + sequence/gap + outbox
                            + commit-before-effect + append-only gRPC ingest）+ TS PDP/身分/redaction + SandboxAdapter chokepoint。
                            ── 它是 undo／稽核／信任，讓「一個自主的東西操作你的電腦/公司」可被中斷重跑、可追溯、可信。
                            ── 在意圖的關鍵路徑**之外**，對「你想做什麼」零摩擦。**保留、不刪、但不當招牌。**
```
**組合**：OpenShell＝身體（Strategy B 不 fork，pinned gRPC client）；Hermes＝腦（MIT，credential-blind host，預設但可換）；agent-os＝脊椎（orchestration 膠水 + 治理/證據）。跨 plane 只走 typed proto/Zod 契約，dependency-cruiser/import-linter/depguard 守低耦合。

## 腦的決策（預設 Hermes，但不 hard-lock）
**預設 brain ＝ Hermes Agent**（MIT，已 clone）——因為它是**唯一已經把「整台電腦憑意圖自己跑」做出來的資產**（file-grounded）：
- 6 執行後端 `tools/environments/{local,docker,ssh,singularity,modal,daytona}.py`——同一意圖能在筆電或 serverless fleet 跑。
- `tools/computer_use/` + browser/file/code/email/calendar 工具——真的操作 GUI/瀏覽器/檔案/終端/網路。**這就是「什麼都能做」的身體。**
- ~18 個訊息平台 `gateway/platforms/*`——任何裝置都能下指令。
- 真實自我進化：`agent/memory_manager.py` + `context_engine.py` + `insights.py`（跨 session 記憶/使用者模型）+ `agent/curator.py`（自動審閱/pin/合併/修補/封存 agent 自建技能、**從不自動刪、archive 可復原**）。
- `cron/scheduler.py`（自然語言排程）+ `delegate_tool`（subagent 並行）。
- model-agnostic providers（anthropic/bedrock/gemini/azure/codex/OpenRouter/Nous）——連推理模型本身都可換。

**怎麼接而不鎖死**：**不 fork Hermes、不把 agent-os 重寫成繞著它**。定義**一個 typed Brain Port**（intent→plan→tool-call 串流 + memory/skill 變更事件），今天由一層薄的 **credential-blind Python shim** 滿足。Hermes 只「提議」tool call 與 skill/memory 變更，**永不持有明文 secret、永不直接碰 WORM**。同一個 port 也收 Claude Code 或任何第三方——**換腦是 config 改動、不是重架構**。Brain 是 **untrusted-by-construction**：每個 plan step 都重新過 PDP + lease + commit-before-effect，所以換強換弱的腦只改**能力/品質**、不改**安全**。

**誠實分工**：腦負責**推理品質/意圖理解/規劃/技能內容**（吃模型）；Agent OS 負責讓那輸出**可靠且完整**的底座——orchestration/resume、tool registry、credential leasing、sandbox 生命週期、體驗殼、以及證據/undo 子系統。Hermes 弱的地方（崩潰冪等的多小時執行、任意 GUI 可靠度）＝**底座要解的工程問題**，不是縮腦的理由。

## 可插拔是硬性約束（腦與身體都必須能換，AGENTS.md 已鎖）
**Hermes（腦）與 OpenShell（身體）都只是「預設值」，兩者都必須能抽換成其他工具。** 強制方式：
- **vendor-neutral port**：腦只經 **Brain Port**、身體只經 **ExecutionSubstrate port**；核心型別/契約/路徑**不得出現廠商名**——`src/runtime/openshell/` 改名 `src/runtime/substrate/`，`openshell/` 只是其下**一個 adapter**；Hermes 同理只活在它的 brain-adapter/shim。
- **廠商只能從自己的 adapter import**：核心以外任何地方 import OpenShell client 或 Hermes ＝ `pnpm run verify` 失敗（TS dependency-cruiser + Python import-linter + Go depguard）。
- **用第二個實作證明、不靠宣稱**：每個 port 附 vendor-neutral **contract test** + **≥2 個實作**（真實 + fake/第二 adapter）都要通過——ExecutionSubstrate：`OpenShellSubstrate` + `LocalProcess/Fake`；Brain Port：`HermesBrain` + `Fake/第二腦`。**彈性只有第二個實作存在才算數。**
- **換 = 改 config，不是重架構**：核心/PDP/audit spine/契約不因換腦或換身體而變。
- 違反（核心洩廠商名、缺 contract test、port 只有一個實作）＝對抗式 review 的阻斷維度、且 `verify` 紅。

> 目前狀態（誠實）：Brain Port **尚未建**（P2）；ExecutionSubstrate port **已存在但只有 NullSandboxAdapter、且路徑帶 openshell 廠商名**——P2 要 (a) 改名 substrate/、(b) 補 contract test、(c) 加第二實作（OpenShell + Fake/LocalProcess、Hermes + Fake）才算滿足此硬性約束。

## 外部工具決策：SpendGuard（成本閘實作）與 AGT（policy adapter 來源）
> 2026-06-20 對真 clone 做對抗式評估後定案。**共通結論:兩者的 audit 都過不了 attester≠actor／離線 verifier 鐵律 → 借它們成熟的功能層,但 audit root 永遠留在我們的 Go WORM kernel;兩者都藏在 vendor-neutral port 後(符合可插拔硬性約束)。** 這反證:我們已建的 WORM kernel + 離線 verifier,正是連 Microsoft AGT 與一個成熟 cost-firewall 都沒有的那塊。

**SpendGuard（你的 repo）＝ 能力引擎「budget/blast-radius ledger + inference gate」的具體實作（adapt-integrate，非 adopt-as-is）。**
- 重用:Rust ledger + reserve/capture(Stripe auth/capture)、**fail-closed hard cap**(`migrations/0063` `RAISE BUDGET_EXHAUSTED` under FOR UPDATE 鎖)、credential-blind(`RedactedAuth`,單一 `forward.rs:692` expose_secret)。
- 被 adapter 降為受控 enforcer:① **PDP 先跑**(唯一 deny 權威)→ allow 才呼叫 SpendGuard;any-deny-wins 合併成單一 AuditEvent。② 坐在 OpenShell `inference.local` **內側**,只看注入後 header——**不用它 client-holds-key(L0-L2)模型**。③ cost decision 餵進 WORM kernel 當 untrusted transport,kernel 用獨立 root 重新 hash-chain + 重簽;SpendGuard 自己的 audit_outbox 留作 billing/operational。
- **必補 gap**:audit 無 hash-chaining(prev_hash/merkle/tessera 全空)→ 不可當證據脊椎;KMS 簽章(已是真 AWS KMS、非 stub)root 仍 operator 控制;**estimation predictor-down 時 fail-OPEN**(`decision.rs:560-568`)→ 加 predictor-down/低信心 → deny/require-approval 二級 gate;commit-before-effect 順序 ledger 不強制 → 需不可繞過 egress chokepoint;tenant 由 header 帶(process-trusted)→ admission 邊界 immutable 綁定;fencing lease ↔ task/session 映射。

**AGT（Microsoft）＝ vendor-neutral policy port 的「一個」adapter 來源 + framework adapters（adopt-partial）。**
- 重用:policy 層 deny-by-default/fail-closed/commit-before-effect(`govern.py:239-298`)、24+ framework adapters(LangChain/CrewAI/AutoGen/OpenAI/MCP)、compliance mapping(SOC2/HIPAA/GDPR/EU AI Act)。
- **不用它的 audit**:baseline 是 plain SHA-256 無簽(`audit.py:190`,`ADR-0017:41` 自承無法防 chain replacement);TRACE v0.1 default-off、per-session digest、金鑰由 operator env 載入、無 standalone verifier → attester==operator。audit 一律回我們 kernel。
- ⚠️ **陷阱**:AGT 載入 0 policy 預設 **allow(ungoverned)**→ 初始化必須強制 deny-all fallback。若日後 TRACE Phase 2(TEE-bound key + 強制簽 + standalone verifier)落地,再重評 audit 那關。

## 各面作法
- **個人（一台自己操作的電腦）**：host Hermes 當預設腦、套零技能殼。**先建順序校正**（現 repo 把 UI 排最後是錯的）：**IntentGateway → ApprovalInbox → TaskTimeline 是前門、不是裝飾**——沒有它們就沒有閉環。P2 MVP 跑**模板化 + tool-based** workflow（email/檔案/行事曆/搜尋/文件/瀏覽器，腦在已知模式內帶參數），未知 workflow → fail-closed 白話「我還不會做這個」。任何裝置入口重用 Hermes gateway。能力靠**改進腦 + 擴模板/技能 + 對低風險動作降低審批摩擦**成長——不是靠藏難處。任意 GUI 自動化在 roadmap（Hermes computer_use 已在，可靠度是工程目標），非永久排除。
- **企業（一個人開公司）**：同一引擎、多 agent + 多租。一群腦（Hermes 實例 + 第三方）跑已知 org workflow，orchestration 在 approval/budget 邊界**序列化跨 agent 副作用**。gateway-per-tenant（進程/namespace 邊界、per-tenant Postgres、per-tenant-keyed kernel partition）使跨租存取**結構性不可能**（release-blocking conformance）。operator console＝一個畫面開公司（fleet、live timeline、per-agent 成本/預算、policy 決策、evidence 匯出）。自我優化（找/修問題、降本、跑實驗）由 Hermes curator/insights + 排程 + budget ledger 提供，**每個提議的 policy/workflow 變更人工把關到模型成熟降低門檻**。「取代所有員工」是架構**沿 workflow-library 覆蓋 + 已知形狀的確定性執行**長進去的軌跡——誠實分段、志向不縮。
- **開發者（在平台上建/擴）**：OpenShell 已把 dev runtime 做得好；Agent OS 加 governance-native SDK。Python credential-blind shim（import-linter 禁帶 secret 的 import）+ TS SDK；作者宣告 Zod ToolManifest（schema/permissions/side-effect/estimator）並發布**簽章、版本化**的技能/工具，插進個人與企業面。Hermes 既有技能生態（curator/skill_bundles）是**散布底座**，Agent OS 讓每個技能的權限/lease/provenance 一級化且可獨立驗證。寫一次、部署到任何 Agent OS instance，走同一條 PDP→lease→commit-before-effect→sandbox 路徑——開發者永不碰 secret、永不繞過治理。**這是讓這台完整電腦持續變得更完整的方式。**

## 分階段規劃
| Phase | 目標 | 交付 |
|---|---|---|
| **P0** ✅ | 兩條 hard constraint 可指令驗 + 治理種子 | dependency-cruiser/import-linter/depguard 入 verify；branded ids + AgentContext；deny-by-default PDP；redaction；NullSandboxAdapter chokepoint |
| **P1** ✅ | 支援安全/可復原子系統（獨立進程） | Go evidence kernel（WORM + 離線 verifier + sequence/gap + outbox + commit-before-effect + gRPC ingest）；TS↔Go conformance（verify:p1-exit 6/6） |
| **P2（NEXT）** — 能力引擎 + 體驗層「活起來」 | 用真實 host 的腦把 intent→effect 閉環打通；Agent OS 從脊椎變成「自己操作的電腦」 | **IntentGateway（文字+語音，先建）** + ApprovalInbox + TaskTimeline；ToolManifest registry；CredentialLease；XState orchestration + resume ledger；**live OpenShell gRPC adapter**（injectLease/resolveInferenceRoute/readEnforcementTier）；sync-commit ingest + outbox；**credential-blind Python shim host Hermes**；inference-route gate + budget seed；docker-compose（Node plane + Go kernel + OpenShell + Next.js UI，mTLS）。**Exit：一個人說/打意圖 → grounded → approved → leased → sandboxed → WORM → timeline；credential 不洩 + resume 冪等綠。** |
| **P3** — 企業多租 fleet | 在公司資料上跑不可信 agent fleet、結構性隔離 | gateway-per-tenant + per-tenant Postgres + per-tenant-keyed kernel partition；release-blocking 跨租 conformance；managed-path bypass 測試；operator console；簽章執行回執 + declared-vs-used diff；per-tenant egress deny-by-default |
| **P4** — production 信任 + 可靠自主 | 不信 operator 也能信紀錄、可重播決策 | Tessera tile-log；RFC-3161/transparency-log 外部錨；**外部化簽章 root（客戶 KMS/HSM）**；WASM 離線 verifier 嵌入殼；決定性 decision-path replay；capability-possession maker-checker |
| **P5** — 自我優化的一人企業 | 有界自主優化 + 多 agent 規模 | sub-delegation capability algebra（child ⊆ parent）；blast-radius budget（over-budget by-construction 不可能）；Chinese-Wall per-side governed memory；有界的自主技能創建 + 成本優化實驗 |

## 立即下一步（P2，每個 RED-first；FRONT DOOR 先行）
1. **IntentGateway**（語音/文字入口，**先建**）+ clarify-or-fail-closed（≤3 白話問題、絕不亂猜）——沒有它就沒有閉環。
2. **Brain Port 契約**（typed intent→plan→tool-call 串流 + memory/skill 變更事件）+ **credential-blind Python shim host Hermes**（import-linter 禁帶 secret 的 import）。RED：shim 試圖持久化 secret → parse 失敗。
3. **Hermes 工具 → ToolManifest**（`src/tools/manifest.ts`+`registry.ts`，Zod `.strict()`）+ PDP 加 `tool:invoke` rule。RED：未註冊 tool → deny+audit。
4. **live OpenShell adapter**（取代 NullSandboxAdapter，pinned proto + image digest）+ injectLease/resolveInferenceRoute/readEnforcementTier，fail-closed 預設。RED：effect 在 Receipt 前跑 → 失敗（adapter 邊界的 commit-before-effect）。
5. **CredentialLease（bundleRef-only）+ sync-commit ingest（canonicalize→redact→Append→await Receipt）+ XState Task FSM + resume ledger**。RED：task 中途 crash → 從下一步 resume、無重複外部 effect。
6. **docker-compose 端到端**（Node plane + Go kernel/SQLite + OpenShell + Next.js 殼，mTLS）證明 Personal 閉環：說/打意圖 → grounded → approved → leased → sandboxed → WORM → timeline；gate＝credential 不洩 scan + resume 冪等。
7. **interim inference-route gate + budget seed**（腦不能呼叫未核准/昂貴模型、不能把使用者的錢花光）——自主的安全地板。
8. **Tier-2 Independent Verifier** + Codex review gate 後才宣告 P2 done。

## 困難能力＝工程路線圖（非縮限理由）
- **任意 app 可靠操作**：腦負責推理、引擎讓它可靠（P2 收斂到模板/tool-based + ToolManifest + resume ledger + commit-before-effect）；靠改進腦 + 擴技能庫 + 對證實低風險動作降摩擦成長。
- **意圖落地**：引擎在腦規劃前把 AgentContext 加上現場狀態（開啟的 app/檔案清單/近期 WORM 事件）+ Hermes 使用者模型；clarify-or-fail-closed。
- **無逃逸沙箱**：OpenShell 的 Landlock/seccomp/netns/microVM + chokepoint + managed-path conformance + 每筆 AuditEvent 帶誠實 EnforcementTier；隨 4 個上游 Rust PR merge 成長，interim ＝ container-tier + egress allowlist + fail-closed tier 降級。
- **多小時無人執行 + 復原**：XState FSM + append-only resume ledger + content-hash dedup + 短期 lease——**現在可建、非模型限制**。
- **多 agent 協調無 race**：orchestration 單一協調點 + 單一 monotonic-sequence kernel + budget 在 approval 邊界檢查。
- **可證明的自我學習**：Hermes curator/insights/skill_* 的每次 skill/memory **變更都是特權動作**、走 commit-before-effect（canonical/redact/Receipt 後才生效）→ 稽核者能重播「哪些經驗造就哪些技能」。品質吃腦、provenance 是密碼學。
- **不信 operator 的信任**：離線 standalone verifier（TS/Go byte-for-byte，已建）；P4 外部化簽章 root + WASM verifier。root 外部化前，對外誠實封頂在「tamper-evident、separate-process」。
- **任意 GUI/陌生 app**：Hermes computer_use + vision_routing 已在，可靠度是缺口；P2 結構化 API+已知 app、P3 模板表單、P4+ 新 GUI 帶 human-in-the-loop。框架：未知 app + 未知 workflow ＝ default-deny 直到有模板或核准。

## 治理的定位（保留、不刪、配角）
既有 Go WORM kernel + standalone verifier + commit-before-effect + PDP + redaction + SandboxAdapter chokepoint **全部保留**，但**從產品身分降為承重支援**：它是任何自主東西操作你電腦/公司**結構上需要**的 undo/安全/紀錄，**留在意圖關鍵路徑之外、零摩擦**。具體它**服務能力與體驗**：commit-before-effect ＝讓崩潰可重跑、無重複 effect 的可靠性閘（**能力 enabler**）；deny-by-default + credential-blind lease ＝讓我們能**安全 host 一個不受信任的腦**（這正是「可換腦的完整性」的解鎖）；WORM + 離線 verifier ＝使用者讀的 TaskTimeline 與企業/稽核信的 proof；誠實 EnforcementTier ＝能力誠實。**它是安全帶，不是車。** north-star 以「治理護城河」為中心是對的工程、錯的產品定位——已在 AGENTS.md 校正。
