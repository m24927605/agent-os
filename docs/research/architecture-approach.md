# Agent OS 架構推薦做法（Lead/Principal Architect 決策）

> 本文件為首席架構師（lead/principal architect）對「如何建構 Agent OS 以交付 8 個 killer app + 7 大 pillar」的最終決策。輸入為 7 份提案（proposals）與其對抗式評審（delivery lens + enterprise lens 共 14 篇 critique），並對照 [openshell.md](./openshell.md)、[opportunities.md](./opportunities.md)、[decision-integration-strategy.md](./decision-integration-strategy.md) 與已採用的策略 B（不 fork OpenShell）。語言/框架選擇被視為「重新開放（re-opened）」的問題，本文件給出明確結論。保留英文技術術語與程式識別符號。
>
> 日期：2026-06-19。狀態：**已採用（Accepted）**。

---

## 1. 摘要 / 推薦做法

**一句話：採用「Two-Plane Polyglot」混合架構 —— TypeScript 治理控制平面（沿用並擴充現有 scaffold）驅動原封不動的 OpenShell，外加一個語言上、進程上、身分上皆獨立的 Go evidence kernel（建在 Trillian-Tessera tile-based transparency log 上）作為 tamper-evident WORM audit spine；四項強制路徑硬化以 upstream Rust PR 進入 OpenShell；agent-facing SDK 用薄 Python shim。**

**為何最適合交付這 8 應用與 7 pillar：** 8 個 killer app 的共同護城河不是「隔離」（OpenShell 已給、且正在 commoditize），而是「從 agent 信任邊界**之外**、在動作路徑**之內**產生、且第三方可獨立驗證的證據」——這正是 c1（Oversight-of-Record）、c2（Insurable Autonomy）、c4（Maker-Checker SOX 證據）、c3（Tenant-Sealed Fleet 的 signed attestation）的字面產品。因此本架構把**唯一不可恢復（correctness-under-adversary）的元件**——durable / append-only / hash-chained / signed / externally-anchored WORM ledger + standalone verifier——隔離成獨立 Go kernel，建在 2025 已 production-ready 的 Tessera 上（這是評審一致證實「mature、proven、Go-native」的 transparency-log 基礎）；同時把佔 90% 表面積、需每週與 design partner 迭代的治理邏輯（orchestration、approval、tool registry、tenant routing、capability algebra）留在 TypeScript，以最大化 time-to-first-app 並沿用已寫好 deny-by-default / fail-closed 不變量的 scaffold。這是「polyglot by failure-mode（依失敗模式分語言），not by preference」。

**綜合來源（hybrid 出處標註）：** 本做法是 Approach 6（Two-Plane Polyglot：TS plane + Go evidence kernel + Rust upstream）為骨幹，嫁接：
- Approach 2 的「Rust/Go kernel 必須是 standalone independent verifier」與「Python agent shim 為 marshaling-only、credential-blind」與「scaffold 是延續不是重寫」；
- Approach 5 的**正確語言修正**——audit spine 用 **Go（Tessera）**，這直接修補 Approach 2/3 把 transparency-log 生態系誤判為 Rust-mature 的致命缺陷，也修補 Approach 5/8 押在 maintenance-mode Trillian 的缺陷（改用其官方後繼 Tessera）；
- Approach 3/8 的「audit 完整性必須在 enforcement 邊界保證、不能由下游 signer 主張」與「attestation 須綁定 enforcement-tier-in-force」；
- 所有提案一致同意的「ingest 完整性（transactional outbox + sequence-gap detection）」與「synchronous-commit-before-effect」這兩個被多數提案漏掉、但評審反覆點名的硬需求，本文件升格為一級設計要求。

---

## 2. 語言決策（核心問題的明確結論）

> 原則：**語言依「失敗模式（failure mode）」而非偏好分配。** 高速迭代的治理表面 → TypeScript；correctness-under-adversary 的證據基底 → Go（因為成熟 transparency-log 生態系在 Go，且需 single static verifier binary）；OpenShell 強制路徑內部 → Rust（且只以 upstream PR）；agent 生態系接觸面 → Python。

| 元件 | 語言 | 框架 | 結論理由（以 app 需求為依據） |
|---|---|---|---|
| **核心控制平面（Governance Core）** | **TypeScript（Node 22）** | Fastify（HTTP/SSE edge）+ `@connectrpc/connect-node`（ConnectRPC：對 OpenShell 講 gRPC、對 SDK/UI 講 Connect/gRPC-Web）+ Zod（單一 schema source）+ XState（Task/AgentSession/ApprovalRequest/lease 狀態機）+ Drizzle ORM | 治理邏輯本質是 typed discriminated-union 狀態機（PolicyDecision / ApprovalRequest / lease lifecycle / delegation attenuation），TS+Zod 表達最乾淨且在每個 untrusted 邊界做 runtime 驗證——現有 ~500 行 scaffold（branded ids、fail-closed `evaluatePolicy`、Zod-validated `AuditEvent`、redaction）已驗證此 idiom。8 個 app 中差異化邏輯（c4 SoD、c20 attenuation、c10 budget、c3 tenant routing）皆在此層，必須每週迭代——TS 提供最大 velocity + 最深 hiring pool。`connect-node` 的 `createGrpcTransport` 可直接對 OpenShell 的 Rust tonic server 講 native gRPC（評審 delivery lens 已驗證），無需 Envoy。 |
| **SDK（primary：agent-facing）** | **Python** | 薄 package：包裝 OpenShell 官方 Python SDK（`python/openshell/sandbox.py`）+ ConnectRPC client 到 Core；提供 `with agentos.session(...) as s:` governed-session context manager、sub-session 衍生（c20）、ToolInvocation helper | API/SDK-first 是產品 stance，且我們 host 的第三方 agent（Claude Code/Codex/OpenClaw）與 OpenShell 官方 SDK 都是 Python-native。**shim 是 marshaling-only：所有治理在 Core，shim 從不持有 credential**，by construction 維持 no-leak（Approach 2 的 best idea）。這是 vendor 打包 untrusted agent 的接觸面（c6 escrow）。 |
| **SDK（secondary：integrator-facing）+ CLI** | **TypeScript** | 由同一份 proto/Zod 生成的 `connect-es` client，發為 npm；CLI 用同 client（thin commander/oclif） | 非 Python 的 platform/SRE 整合者（c10）、MSP fleet（c3）拿到第一級 typed client；與 Core/UI 共用 schema source 消除 drift。 |
| **UI** | **TypeScript** | Next.js（App Router/RSC）+ shadcn/ui + Tailwind + TanStack Query（`connect-query-es`）+ React Flow（delegation/decision-path graph）；evidence viewer 內嵌 verifier 的 WASM build | Approval Inbox、Task Timeline、Decision-Path Replay、Tenant Isolation attestation dashboard 是 c1/c4/c20 的人面產品。UI 明確 secondary（產品 stance），但與 Core 共用 TS 型別與 Zod schema，approval/audit 形狀不會 drift。**註：browser 不能對 raw gRPC server 直連**——UI 走 Core 暴露的 Connect/gRPC-Web；live replay/approval feed 用 server-streaming 或 polling，非 bidi（Approach 2 delivery 評審指正）。 |
| **OpenShell adapter** | **TypeScript（drive）+ Rust（upstream PR，harden）** | `connect-node` typed client 對 `proto/openshell.proto`（~50 RPC），pin 在 version+image digest（NemoClaw `min==max==0.0.44` 紀律）+ contract-test gate；CLI subprocess 僅作 Personal-mode fallback | 策略 B 字面執行：typed gRPC（typed breakage on drift、streaming、testability）優於 CLI scraping。adapter 是 single chokepoint，enforce「受管路徑唯一」。四項活在強制路徑內部、外層 TS 碰不到的硬化以 **upstream Rust PR** 進入 OpenShell（同 tonic/prost stack，idiomatic），避免 alpha rebase 稅。 |
| **Durable audit sink（evidence kernel）** | **Go** | **Trillian-Tessera**（tile-based RFC-6962 transparency log，2025 production-ready，Rekor v2 同基底）+ Ed25519 checkpoint 簽章 + BLAKE3 hash-chain + RFC-3161 TSA / transparency-log witness 外部錨定 + S3 Object-Lock WORM blob；**獨立 single static verifier binary（+ WASM build）** | 此元件的正確性**就是** c1/c2/c3/c4 的產品。它必須 tamper-evident、append-only by construction、可被「不信任我們平台」的 auditor/insurer 獨立驗證。**關鍵語言結論（修正多份提案的事實錯誤）：成熟、proven、tile-based 的 transparency-log 生態系是 Go（Tessera/Sunlight/TesseraCT/Sigstore Rekor v2），不是 Rust。** 在 Rust 你會 hand-roll RFC-6962 tile log + 外部錨定 + witness cosigning——這恰是「絕不能有 bug」的法律級程式碼。Go 給：成熟函式庫（不 hand-roll crypto on the moat，符合「不證明就不宣稱 secure」）、單一 static verifier binary（auditor 信任 500 行 verifier、不信任我們），以及與 control plane 不同進程+不同語言+不同身分的結構分離（被審計者結構上無法改寫 audit）。 |
| **Persistence（control-plane domain state）** | **TypeScript over SQL** | Postgres（Enterprise，**database/schema-per-tenant**，非 `tenant_id` row filter）/ SQLite（Personal）皆走 Drizzle；CAS optimistic concurrency（對齊 OpenShell object-store 契約、支撐 resume idempotency）；credential **絕不**以明文持久化——只存 lease metadata + reference，secret 委由 OpenShell SecretResolver | 可變、可查詢、需 migration 與 tenant 分區的營運狀態用 Postgres。**刻意把可變營運狀態（Postgres）與不可變證據（Go evidence kernel 的 WORM store）分成兩個 store、兩個身分**——這是核心正確性邊界：DB 被攻破不能改寫歷史（c1/c4 admissibility 的基礎）。不存進 OpenShell `objects` table（CAS-coupled、alpha、無 tenant column）。 |

### 明確回答「為什麼不是其他語言」

- **為什麼核心不是 Rust（駁 Approach 3/8）：** 控制平面是 90% 的 plumbing（orchestration、approval inbox、tenant routing、tool registry），是 I/O-bound、需每週迭代、需廣招募。Rust 在此 tax velocity 而**不買到任何 integrity**——integrity 已被錨在 OpenShell 的 Rust 強制路徑與我們的 Go evidence kernel。Approach 3/8 把整個 spine 放 Rust 導致「velocity inversion」：最慢、最稀缺人才、生態系最不成熟（Rust transparency-log）的工作被前置在任何營收 app 之前 1-2 季——evidence lens 給 lead，但 delivery lens 給 contender，正因如此。
- **為什麼核心不是 Go（駁 Approach 5）：** Approach 5 的 enterprise lens 拿到 lead（它**唯一選對** audit 語言），但 delivery lens 是 contender，兩個致命延遲：(1) 它把已能跑、已測試的 TS scaffold 重寫進 Go（Phase 0 燒數週的 schedule debt）；(2) OpenShell 官方 SDK 是 Python、參考棧 NemoClaw 是 TS，**沒有現成 Go OpenShell client**，等於對 alpha 不穩 proto 從零寫 adapter——是可選語言中 integration friction 最高者。Go 缺 sum type，治理建模靠可被 `//nolint` 繞過的 exhaustive linter，是 c4/c20/c10 正確性的持續 discipline 稅。**我們只取 Approach 5 對的那一半：audit kernel 用 Go。**
- **為什麼核心不是 Python（駁 Approach 1）：** Python/FastAPI 是 integration friction 最低（OpenShell 官方 SDK 是 Python）、velocity 高，但：(1) Pydantic 只在 `validate()` 邊界保證 field 一致性，`model_construct` 快路徑一用即失效，且**無法表達 maker≠checker、child⊆parent、budget 單調遞減等跨物件 stateful 不變量**——「runtime typed correctness」被誇大為 policy correctness（enterprise lens 指正）；(2) 若單一 Python control plane 跨租戶服務，會重新引入「一個漏掉的 caller-scope check = cross-tenant breach」的 shared-trust-domain 失敗模式（c3/c12 須 per-tenant by construction）。**Python 退回它真正最強的位置：agent-facing shim。**
- **為什麼 evidence kernel 不是 TypeScript（駁 Approach 2 的字面 Rust kernel、並反向排除 TS kernel）：** 在 TS hand-roll Merkle consistency proof 是「在護城河上發明 crypto」，違反 CLAUDE.md「不證明就不宣稱 secure」；且 TS 無 single static verifier binary、GC/fsync window 對 WORM 路徑是風險。
- **為什麼 evidence kernel 不是 Rust（修正 Approach 2/3/8 的事實錯誤）：** 見上表。Rust 有成熟 primitive（ed25519-dalek、BLAKE3）但**沒有**成熟 tile-log/witness 生態系——你得 hand-roll 法律級程式碼。Approach 2 的 enterprise 評審明確證實「production tile-log/witness 生態系是 Go（Tessera/Sunlight/sigsum）」。Approach 5/8 選了 Trillian——但 web 查證確認 **Trillian 已進 maintenance mode、Google 官方建議新 log 用 Tessera**。本文件因此選 **Tessera（Go）**，同時取得「成熟生態系」與「不押 deprecated 依賴」。

---

## 3. 整體架構

### 元件 / 服務分解（兩平面 + OpenShell + 兩 store）

```
┌──────────────────────────────────────────────────────────────────────────┐
│  GOVERNANCE PLANE (TypeScript / Node 22)  ── 90% 表面積、每週迭代            │
│  Task/AgentSession/Artifact orchestration (XState + resume ledger)         │
│  ApprovalRequest engine (maker≠checker by capability possession)           │
│  Tool registry (ToolManifest/ToolInvocation, blast-radius estimator)       │
│  Policy LAYER (PDP): capability algebra(child⊆parent) / SoD conflict-pairs  │
│                      / consumable blast-radius budget / inference-route gate│
│  CredentialBundle lease lifecycle (mint→inject→use→revoke→expire)          │
│  Tenant/User/Project routing  ·  ConnectRPC API surface                    │
└───┬───────────────────────────┬──────────────────────────────┬───────────┘
    │ connect-node (native gRPC) │ append-only ingest (gRPC)     │ Drizzle
    ▼                            ▼                               ▼
┌─────────────────────┐  ┌──────────────────────────┐  ┌──────────────────┐
│ OpenShell (PEP)     │  │ EVIDENCE KERNEL (Go)      │  │ Postgres / SQLite │
│ 原封不動，per-tenant │  │ 獨立進程/身分/語言         │  │ per-tenant DB     │
│ Landlock/seccomp/   │  │ Tessera tile log +        │  │ (mutable 營運狀態) │
│ netns/microVM       │  │ Ed25519 + RFC-3161 anchor │  │ lease metadata    │
│ OPA L4/L7 + Z3      │  │ + standalone verifier     │  │ (NO plaintext     │
│ SecretResolver      │  │ (WORM, append-only)       │  │  credential)      │
│ inference router    │  │ control plane 無改寫權     │  └──────────────────┘
│ OCSF v1.7.0 emit    │  └──────────────────────────┘
└─────────────────────┘
  ▲ upstream Rust PR (4 項硬化)                       Python agent shim ──┐
                                                       (marshaling-only)   │
                                              hosts Claude Code/Codex/… ──┘
                                              在 OpenShell sandbox 內
```

**PDP / PEP 切分（Approach 1 best idea）：** OpenShell 是 kernel/egress 的 **Policy Enforcement Point**（OPA L4/L7 + Z3 + Landlock/seccomp/netns）；TS Governance Plane 是 kernel 之上一切的 **Policy Decision Point**（tool 准入、approval、lease、budget、delegation、inference-route allowlist）。決策向下流，事件向上流入 evidence kernel。

### 如何驅動 OpenShell

- Governance Plane 透過 `connect-node` 的 typed gRPC client 對 OpenShell `proto/openshell.proto`（~50 RPC）Create/Stop/Delete/Exec sandbox、resolve provider、submit/approve policy draft、讀 OCSF。
- **single chokepoint = OpenShell adapter module**：Governance Plane 是 sandbox 的**唯一**建立者與 credential lease 的**唯一**鑄造者，使「受管路徑唯一」成為結構不變量（c4/c6/c20 靜默依賴它）。配對抗式 bypass 測試為 release gate。
- 四項強制路徑硬化以 upstream Rust PR 進入 OpenShell（見 §4）。

### Data flow（一個 privileged action 的正則路徑）

1. agent（untrusted，在 OpenShell sandbox 內）發出 tool/credential/egress/inference 請求 → Python shim 經 ConnectRPC 轉給 Governance Plane。
2. Governance Plane PDP 評估 ToolManifest + Policy + budget + delegation algebra（deny-by-default）。
3. 若 privileged → 鑄 ApprovalRequest（maker≠checker 由 capability 持有性 enforce，非 if-check）→ 路由到 Inbox。
4. 批准後 → 鑄 scoped CredentialLease（TTL / amount / beneficiary / resource-bound）→ 經 OpenShell SecretResolver 在 egress 注入（agent 從不見 secret）。
5. **每一步 synchronous-commit-before-effect**：先把 AgentContext-tagged 事件**確定寫入並 hash-chain 進 evidence kernel**，再放行外部副作用（避免「副作用已發生、紀錄遺失」的 c1/c4 證據毀滅 window，Approach 8 enterprise 評審指正）。
6. evidence kernel hash-chain + 簽章 + 週期外部錨定；over-budget 或 unmatched policy = deny by construction + audited。

### 部署 topology

- **Personal Agent Workstation：** 單一 Node 進程（Governance Plane）+ 本機 Go evidence kernel（SQLite-backed tile store，**先簡後繁**：MVP 用簡單 append-only hash-chained + 簽章，再 in-place 升級為完整 Tessera + 外部錨定）+ 一個本機 OpenShell gateway（Docker/Podman/libkrun）+ SQLite + 本機 UI。single-user mTLS。為降低本機安裝重量，evidence kernel 與 Core 以 docker-compose / 單一 launcher 打包。
- **Enterprise Agent Runtime Platform：** **gateway-per-tenant**（進程/namespace 邊界，非 `tenant_id` row filter）——每租戶一個 OpenShell gateway + 一個 shared-nothing Governance Plane shard + per-tenant Postgres DB，前置一個 tenant-routing gateway（Envoy）。evidence kernel 為 multi-tenant cluster，但**每租戶獨立 Merkle tree + 每租戶獨立簽章金鑰**（修正 Approach 7 的 shared-key 缺陷：per-customer isolation attestation 不能由「簽每個客戶鏈的同一把 key」背書）。沿用 OpenShell 既有 Helm/K8s + per-tenant namespacing + tenant-scoped NetworkPolicy。

---

## 4. 7 Pillar → 元件對照 + Sequencing

| Pillar | 對照元件 | reuse / build / extend |
|---|---|---|
| 1. Agent hosting & task orchestration | TS Governance Plane（XState Task/AgentSession/Artifact + resume ledger）；Python shim host 第三方 agent | **BUILD** |
| 2. Secure sandbox & isolation | OpenShell（Landlock/seccomp/netns/microVM），TS adapter 1:1 包裝；Landlock `hard_requirement` 預設經 upstream PR | **REUSE**（+1 upstream 硬化） |
| 3. Deny-by-default policy/permission | OpenShell OPA L4/L7 + Z3（PEP）+ TS PDP layer（tool/budget/SoD/delegation/inference-route） | **REUSE + BUILD** |
| 4. Human-in-the-loop approval | extend OpenShell proposal→Z3→inbox 引擎，泛化到 file/process/credential/tool/irreversible；maker≠checker by capability | **EXTEND + BUILD** |
| 5. Credential & inference governance | reuse OpenShell SecretResolver（no-leak confirmed）+ BUILD TS lease lifecycle + redaction filter（upstream）+ per-route inference gate（upstream） | **REUSE + BUILD（+2 upstream）** |
| 6. Tool registry & governed invocation | TS Zod-typed ToolManifest/ToolInvocation（OpenShell 無 Tool 物件） | **BUILD** |
| 7. Tamper-evident audit & observability + Enterprise tenant/IAM | reuse OCSF v1.7.0 為 wire shape；**BUILD Go evidence kernel**（Tessera WORM + verifier）+ OCSF AgentContext（upstream）+ gateway-per-tenant + 跨租 conformance suite | **REUSE + BUILD（+1 upstream）** |

### Sequencing（先做哪個 — 對應 P0）

> 原則：先建服務 12+ app 的 cross-app P0 基底，於最低風險的 Personal 模式試煉，再升入 Enterprise lighthouse。**但修正 Approach 3/6 的「velocity inversion」：在完整 anchored kernel 與 upstream PR 落地之前，先用 TS plane + 簡單 append-only 簽章 log 把一個垂直 app 端到端跑起來，讓首個 user value 先於 moat 硬化。**

- **Phase 0（延續 scaffold，非重寫）：** 擴充現有 TS scaffold — 完成 OCSF AgentContext 對映（`actorId/tenantId/projectId/taskId/requestId/sandboxId/result`，scaffold 的 `AuditEvent` 已帶這些 branded id）+ TS 邊界 redaction filter。同步開出四項 upstream Rust PR（OCSF tenant fields、redaction、Landlock `hard_requirement`、inference gate）——**把 inference-gate 與 Landlock PR 立刻啟動（外部 review queue lead time 最長、最不可控）**，並以 Core-side egress allowlist 作 interim 緩解，使 c6 no-exfil 不阻塞於 NVIDIA review queue（Approach 2 delivery 評審建議）。
- **Phase 1（P0 #1 + #2，最重 lift、gating c1/c2/c3/c4）：** 立起 **Go evidence kernel**（獨立進程/身分）— append-only hash chain + Ed25519 簽章 + **standalone verifier** 先行；Governance Plane 與 OpenShell supervisor 皆**只能 append**。加上 **kernel-enforced monotonic per-source sequence + gap detection + transactional outbox**，使「ingest 完整性」（而非僅過去紀錄不可變）可證——這是 attest-the-negative 誠實成立的缺片（Approach 6/8 評審指正）。隨後 in-place 升級為完整 Tessera tile log + RFC-3161/transparency-log 外部錨定。
- **Phase 2（Personal beachhead，c24）：** TS plane 串 Approval Inbox + Task Timeline + Artifact + Tool registry + credential lease lifecycle，於單一本機 OpenShell + SQLite，host 一個真實第三方 agent（Claude Code），事件落入 evidence kernel。閉環、可 demo、無多租戶風險。
- **Phase 3（Enterprise lighthouse，平行 design partner）：** **Agent Escrow（c6）** — 最高 conviction，1:1 對應 OpenShell 最強 confirmed 原語（no-leak + deny-egress）+ 我們的 lease lifecycle + scope-diff + kernel-issued signed execution receipt。並行 **Tenant-Sealed Fleet（c3）** — gateway-per-tenant + release-blocking 跨租 conformance suite + per-tenant-keyed signed isolation attestation。
- **Phase 4（最高 ACV 旗艦，建在成熟 spine 上）：** **Oversight-of-Record（c1）** decision-path replay + 外部錨定 + EU AI Act/SR-11-7/17a-4 evidence export；**Maker-Checker（c4）** SoD conflict-pair + dual-control + amount-bound L7 body-match + SOX 證據。吃最硬 why-now（EU PLD / SOX PCAOB 2026-12）。
- **Phase 5（最大 net-new scope，最後）：** Sub-Delegation Firewall（c20 capability algebra，配 property-based + adversarial 測試 + 考慮把 lattice kernel 形式化/推向 Rust）、Blast-Radius-Budgeted Change（c10 stateful budget + estimator，fail-closed-on-uncertainty）、Chinese-Wall（c12 per-side governed memory/vector store — 最大 net-new 子系統，且 per-side inference keying 須先有 per-route gate）。

---

## 5. 8 應用如何被此做法支撐（各一句）

- **c1 Oversight-of-Record：** Go evidence kernel（Tessera WORM + 外部錨定 + standalone/WASM verifier）+ decision-path replay 就是字面產品；ingest-completeness（sequence-gap detection）+ enforcement-邊界 emit 使 attest-the-negative 誠實成立。
- **c6 Agent Escrow / BYO-Agent：** 直接 reuse OpenShell confirmed no-leak + deny-egress；Python shim host vendor untrusted agent（credential-blind）；客戶擁有 kernel 簽發的 execution receipt + declared-vs-used scope diff。
- **c4 Maker-Checker Runtime：** TS capability-possession 使 proposer 結構上拿不到 approve；Go kernel 供 SOX/PCAOB non-repudiable approval receipt。
- **c20 Sub-Delegation Firewall：** TS attenuation-only capability algebra（child⊆parent）+ per-hop scoped lease + sandbox-per-sub-agent + per-hop 事件入 kernel；配 adversarial 測試證明無升權/竊取 sibling secret。
- **c10 Blast-Radius-Budgeted Change：** TS PDP 的 stateful consumable budget + ToolManifest estimator + JIT prod credential + idempotent resume ledger；over-budget by construction DENY。
- **c12 Agent Chinese-Wall：** Side/Wall 高於 tenant 的隔離域 + per-side inference keying（依賴 upstream inference gate）+ per-session hash-chained access log 上的 signed non-contamination 報告（attestation 嚴格限定 OS-enforced channel）。
- **c3 Tenant-Sealed Fleet：** gateway-per-tenant 進程邊界 + per-tenant Postgres + per-tenant-keyed kernel partition；release-blocking 跨租 conformance suite 產品化為 per-customer signed isolation attestation。
- **c2 Insurable Autonomy：** evidence kernel 的 deployer-independent signed telemetry 為唯讀投影；WASM verifier 讓 insurer 在自己瀏覽器端 re-verify controls-in-force，不需信任我們。

---

## 6. 對現有 ~500 行 TS scaffold 的處置

**保留並擴充（KEEP + EXTEND），不重寫。成本：低（數天，非數週）。** 理由：

- scaffold 已編碼本架構所需的核心不變量，且語言決策（TS 核心）與其一致：
  - `src/iam/ids.ts` 的 branded `TenantId/ProjectId/TaskId/ActorId/RequestId/EventId/SandboxId` **正是** OCSF AgentContext 所需欄位 → 直接餵 Phase 0 的 AgentContext 對映。
  - `src/audit/event.ts` 的 `createAuditEvent` 已 fail-closed（缺欄位即 throw、無 partial event）→ 成為流入 Go evidence kernel 的 typed domain event。
  - `src/policy/evaluate.ts` 的 deny-by-default + fail-closed（malformed/error → deny）→ 成為 TS PDP layer 的種子。
  - `pnpm verify` gate + pre-commit secret guard → 保留為 dev-loop gate。
- **明確拒絕 Approach 5/8 的「Phase 0 重寫進 Go/Rust」**：那是純 schedule debt（評審 delivery lens 一致點名），且與本架構「TS 核心」結論矛盾。Go 只用於 evidence kernel（新建，非移植 scaffold）；Rust 只用於 upstream PR（不碰 scaffold）。
- docs 與 methodology 無論如何保留（任務前提）。

---

## 7. 關鍵權衡、風險，與「需使用者拍板的人為判斷」

### 關鍵權衡

- **Polyglot 維運稅（3 語言 TS/Go/Rust + 隱含 Python shim）：** 換來「moat 程式碼落在對的語言」。緩解：Rust 僅 upstream（由 OpenShell CI 承載）、Go 僅一個 narrow-gRPC-ingest 的自包含 kernel、TS 為主體；單一 Zod/proto schema source 釘住跨語言契約。仍是 greenfield team 的真實 hiring/on-call/SBOM 表面擴張。
- **可變狀態 vs 不可變證據分離：** 兩 store、兩身分增加複雜度，但這是「DB 被攻破不能改寫歷史」的結構正確性邊界，c1/c4 admissibility 不可妥協。
- **typed correctness 在 TS（非形式驗證）：** c4/c20/c10 的 by-construction 保證活在 TS，須以 property-based + adversarial conformance suite 作 release gate；Go kernel 證明「發生了什麼」、不證明「policy 邏輯正確」。

### 風險

- **OpenShell alpha：** proto/ABI 無預警漂移；四項 upstream PR 在 NVIDIA review queue、我方無 merge 權。緩解：version+digest pin、adapter chokepoint、contract test；PR 未落地前以 microVM tier + Core-side egress allowlist 緩解 fail-open，並**把 c6/c3/c12 的 isolation attestation SKU gate 在實際 merge（不是 PR 提交）**。
- **「受管路徑唯一」是不變量，非已證機制：** agent 若在 managed entrypoint 之外啟動 runtime，靜默喪失 policy/credential 注入且 kernel 無事件可記（attest-the-negative 退化為 attest-nothing）。須 admission-control / sealed-launch gate + 對抗式 bypass 測試為 release gate。
- **attest-the-negative 與 non-contamination 的可採信度與邊界：** 只在 OS-enforced channel 成立；covert/side channel 對抗式可繞。attestation 措辭須綁定 **enforcement-tier-in-force**（container tier vs libkrun microVM；非 Landlock kernel 上 fail-open），kernel 須 per-session 記錄 tier。
- **libkrun microVM experimental：** 唯一真硬體隔離 tier，目前忽略 CPU/memory limit；c3/c12 最強 tier 須先 upstream 硬化。
- **Tessera < 1.0：** 2025 production-ready 但 API 在 1.0 前可能 minor breaking。緩解：RFC-6962 tile 格式穩定；把 kernel 放在 log-engine interface 後（engine 可換），Personal MVP 先用簡單 hash-chained log 再升級。

### 需使用者拍板的人為判斷（swing factors — 每個答案把推薦推向哪個方向）

1. **團隊母語 / 招募池（最大 swing）：**
   - 若團隊是 **TS-heavy、小團隊、求最快 time-to-first-app** → **強化本推薦**（TS 核心 + Go kernel 一個專責 hire）。
   - 若團隊已 **Rust-heavy 且能吃 velocity 前置稅** → 推向 **Approach 3/8**（Rust spine），但仍應把 audit kernel 留 Go（生態系事實不變）。
   - 若團隊是 **Python/ML-heavy** → 推向 **Approach 1**（Python 核心），代價是 typed-invariant 與 per-tenant 隔離須額外硬化。
2. **誰是整合者（OpenShell 接觸面）：** 若主要買方/整合者在 **Python（data/ML、c6 vendor）** → 維持 Python primary SDK（已是本推薦）；若在 **TS/platform（c10 SRE、c3 MSP）** → 把 TS SDK 升為 primary。本推薦兩者皆生成，預設 Python primary 因 agent 生態系在 Python。
3. **attestation 可採信度（非工程、最大不確定性）：** c1/c2/c3/c4 的價值全押「signed claim 是資產而非負債」。**必須**在擴大投入前找 design-partner 的 outside counsel / auditor / E&O insurer 審視 attestation 措辭與 evidence bundle。答案為「不可採信」會推翻整個 moat 論述、迫使重估產品定位——這是任何架構都無法靠工程解決的 swing factor。
4. **首個 Enterprise lighthouse 二選一（c6 vs c3）：** 若能簽到願把 image 送進客戶 perimeter 的 vendor → **c6**（最高 conviction）；若先有 MSP/SaaS BYO-agent 買方 → **c3**（最可行、最 on-thesis）。兩者共用 P0 基底，順序由 design-partner 可得性決定。

---

## 8. 評審分數摘要（各 approach 的 verdict 與致命缺陷一句）

| Approach | delivery / enterprise verdict | 致命缺陷（一句） |
|---|---|---|
| 1. Python-First + 編譯 audit spine | contender / contender | audit spine 把 Trillian 誤宣為「boring/proven」，實為 maintenance-mode；Pydantic 的「runtime typed correctness」被誇大為 policy correctness，且單一 Python control plane 跨租戶會重引 shared-trust-domain 失敗模式。 |
| 2. One TS Core + **Rust** WORM kernel + Python shim | **lead** / contender | 把「成熟 transparency-log 生態系」誤判為 Rust——實為 Go，Rust 須 hand-roll 法律級 crypto，反升正確性風險。 |
| 3. Rust spine + TS control plane | contender / **lead** | velocity inversion：最慢、最稀缺、生態系最不成熟（Rust anchoring 用 sigstore-rust v0.3）的工作前置在任何營收 app 之前 1-2 季。 |
| 4. Two-Plane（TS plane + Go kernel + Rust upstream）| contender / **lead** | sequencing 把 Go kernel + upstream PR 前置在任何可觸碰 app 之前（time-to-first-app inverted），且 Personal local-first 安裝過重——**骨幹採用，sequencing 已修正**。 |
| 5. Go core + Tessera spine | contender / **lead** | **唯一選對 audit 語言（Go/Tessera）**，但 Phase 0 重寫 TS scaffold 進 Go 是 schedule debt，且無現成 Go OpenShell client（integration friction 最高）——**只取其 audit-語言修正**。 |
| 6. Governed Sidecar（TS + Rust ledgerd）| contender / contender | NemoClaw 證據與 connect-es-直連-OpenShell 前提相左（官方 SDK 是 Python）；新治理維度（tool/lease/SoD gate）落在非 in-path 的 TS sidecar，by-construction 被誇大。 |
| 7. Evidence-Core（Rust spine + Trillian + per-tenant OpenShell）| contender / **lead** | 押在 maintenance-mode Trillian（未提 Tessera）；velocity 前置稅 + 三 toolchain；attest-the-negative 視為已解、覆蓋面誇大。 |

> 註：原 7 份提案中編號 4/6 在不同 lens 下分屬不同名稱（Two-Plane / Governed Sidecar），本表以評審 critique 的命名對齊。本推薦以 Approach 4（Two-Plane）為骨幹，嫁接 Approach 5 的 Go/Tessera audit-語言修正、Approach 2 的 standalone-verifier + Python-shim + scaffold-延續、Approach 3/8 的 enforcement-邊界完整性與 tier-bound attestation。

---

*本文件為 evidence-based 架構決策。語言選擇明確、可回溯至 8 app 的需求與評審 critique 的事實查證（含 Trillian maintenance-mode 與 Go/Tessera 生態系成熟度的 web 查證）。凡 team-dependent 的判斷皆標為 swing factor 並說明擺向。未含任何 secret-like 值。*
