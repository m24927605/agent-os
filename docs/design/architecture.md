# Agent OS 架構設計（Architecture Design）— Two-Plane Polyglot, Buildable

> 狀態：**Accepted（可建構版）**。日期：2026-06-19。
>
> 本文件把 [`docs/research/architecture-approach.md`](../research/architecture-approach.md) 採用的 **Two-Plane
> Polyglot** 決策，落成一份**可直接建構（buildable）**的設計：明確的 component 邊界與 **typed interface**、
> **TS↔Go ingest 契約**、**OpenShell adapter chokepoint**、**agent-type-agnostic domain model**、**proto/Zod
> single-source**、**deployment topology**、**enforcement-tier-in-force binding（attestation）**、**11-layer map +
> 依賴方向**，並**證明依賴圖無環（acyclic）**。
>
> 本文件本身即受 **Looping Engineering**（`AGENTS.md` §Looping Engineering）與**兩個 HARD CONSTRAINT**
> （low-coupling/high-cohesion；per-slice adversarial review）約束：每一條驗收條件都對應一條**可執行指令**
> （only command output is truth），低耦合/高內聚由 **dependency-boundary check** 在 `pnpm run verify` 內**強制**，
> 違反即 fail。保留英文技術術語與程式識別符號。
>
> 上游事實依據：[`docs/research/openshell.md`](../research/openshell.md)（adapter chokepoint、OCSF 缺口、
> enforcement tier）。語言/失敗模式決策的理由不在此重述，見 architecture-approach §2。

---

## 0. 本文件如何被驗證（Acceptance — 只信指令輸出）

> **Status 欄（杜絕把 TARGET 讀成 CURRENT）：** **CURRENT** = 今天即可跑（已用 2026-06-19 `package.json`
> 核實）；**TARGET（slice）** = 指令/檔案**尚未存在**，隨指定 slice 落地，落地前不可當已綠。
> **已核實的現況：** `package.json` 的 `verify = typecheck && lint && build && test && secret-scan`——
> **不含 `deps`**，且無 `deps` script、無 `.dependency-cruiser.cjs`、無 `proto/` / `kernel/` / `sdk/python/`。

| 驗收維度 | 指令（single source of truth） | 通過條件 | Status |
|---|---|---|---|
| 全域 gate（現況） | `pnpm run verify` | exit 0（**現** = `typecheck && lint && build && test && secret-scan`） | **CURRENT** |
| 全域 gate（加 deps 後） | `pnpm run verify` | exit 0（**S1 後** = `… && deps`） | **TARGET → S1** |
| **依賴邊界（HARD A）** | `pnpm run deps:check`（= `depcruise --config .dependency-cruiser.cjs src`） | exit 0；**0** circular、**0** boundary violation、**0** deep-import | **TARGET → S1** |
| 依賴圖可視化（人審佐證） | `pnpm run deps:graph`（`depcruise … --output-type dot \| dot -Tsvg > docs/design/deps.svg`） | 產出 SVG，與本文件 §10 圖一致；箭頭全部 inward | **TARGET → S1** |
| 跨平面契約一致 | `pnpm run proto:check`（`buf lint && buf breaking --against '.git#branch=main'`）+ `pnpm run contract:check`（Zod↔proto round-trip） | exit 0 | **TARGET → S3**（建 `proto/`） |
| Go kernel 自證 | `cd kernel && go test ./... && go vet ./...` | exit 0；ingest 完整性測試（sequence-gap / outbox）綠 | **TARGET → S4/P1**（建 `kernel/`） |
| Python shim credential-blind | `cd sdk/python && import-linter && pytest -k credential_blind` | exit 0；contract test 證 shim 從不持有 raw secret | **TARGET → P3**（建 `sdk/python/`） |
| **per-slice adversarial review（HARD B）** | 見 §11 與 `docs/standards/adversarial-code-review.md`；merge-gate 機制見 §11 末 | 每個 slice 合併前 = PASS（fresh-context reviewer），且 PASS verdict 為 durable artifact | **CURRENT（流程）** |

> 本文件描述的任何 module/interface，在被實作前必須先有 **RED failing test**（TDD），且其 slice 必須通過
> adversarial review 才能 merge。**本架構文件不解除任何 invariant；它只把 invariant 綁到可執行的 gate 上。**
> 標 **TARGET** 的指令在其落地 slice 完成前**不可被當成已綠**（gate-first）。

---

## 1. 設計目標與不可協商約束（從 AGENTS.md 繼承）

1. **Agent-type-agnostic domain model**：domain 物件不得內建 coding-agent 假設（AGENTS.md §What Agent OS is）。
2. **Deny-by-default + fail-closed everywhere**：未知 = deny；malformed/missing context/internal error = deny。
3. **Credentials NEVER** 進 workspace / logs / artifacts / snapshots / traces / fixtures；raw secret 不進 persistence 與 audit payload。
4. **Every privileged action → 完整 AuditEvent**，且 **synchronous-commit-before-effect**（先寫證據再放行副作用）。
5. **Cross-tenant access impossible by construction**（enterprise = gateway-per-tenant），且有測試覆蓋。
6. **受管路徑唯一（managed-path-is-only-path）**：OpenShell adapter 是 sandbox 建立與 credential lease 鑄造的**唯一 chokepoint**。
7. **HARD A — low coupling / high cohesion**：一模組一職責；只經 public surface 消費；acyclic inward 依賴；平面間只走 typed contract。**由 dependency-boundary check 強制，違反即 fail `pnpm run verify`**。
8. **HARD B — per-slice adversarial code review**：小 slice、獨立可驗、合併前必過 fresh-context 對抗式 review。

---

## 2. 系統概觀（Two Planes + OpenShell + Two Stores + SDKs/UI）

兩個**進程/語言/身分皆獨立**的平面，跨平面**只**透過 typed contract（proto / Zod）通訊，**從不**互相 deep-import：

- **Governance Plane（TypeScript / Node 22）** — 90% 表面積、每週迭代的治理邏輯（PDP）。它是 sandbox 與
  credential lease 的**唯一**建立者（chokepoint）。對 OpenShell 講 native gRPC、對 SDK/UI 講 Connect/gRPC-Web、
  對 Go kernel 講 append-only ingest gRPC。
- **Evidence Kernel（Go）** — 獨立進程/身分/語言的 tamper-evident WORM audit spine（Tessera tile log + Ed25519 +
  RFC-3161 anchor + standalone/WASM verifier）。Governance Plane **只能 append，無改寫權**。
- **OpenShell（PEP，原封不動）** — kernel/egress 強制執行點（Landlock/seccomp/netns/microVM + OPA L4/L7 + Z3 +
  SecretResolver + inference router + OCSF emit）。四項強制路徑硬化以 upstream Rust PR 進入（§7）。
- **Two stores（刻意分離）** — Postgres/SQLite（mutable 營運狀態，Drizzle，**無明文 credential**）與 Go kernel 的
  WORM store（immutable 證據）。**兩 store、兩身分** = 「DB 被攻破不能改寫歷史」的結構正確性邊界。
- **SDKs/UI** — Python primary SDK（credential-blind marshaling shim）、TS secondary SDK + CLI、Next.js UI（內嵌 WASM verifier）。

```
                         ┌───────────────── consumers ─────────────────┐
   Python SDK (shim) ──┐ │  TS SDK + CLI (connect-es)   UI (Next.js)    │
   credential-blind    │ │        │                         │ (Connect/gRPC-Web only;
   hosts 3rd-party     │ │        ▼                         ▼  no raw gRPC, no bidi)
   agent in sandbox    └─┼──► ┌──────────────────────────────────────────────┐
                         │    │  GOVERNANCE PLANE (TypeScript / Node 22) — PDP │
                         │    │  edge: Fastify(HTTP/SSE) + ConnectRPC          │
                         │    │  domain  ◄─ application ◄─ adapters (inward)   │
                         │    └───┬───────────────┬──────────────────┬────────┘
                         │  connect-node      append-only          Drizzle
                         │  (native gRPC)    ingest (gRPC)            │
                         ▼        ▼               ▼                   ▼
   ┌──────────────────────┐  ┌─────────────────────────┐  ┌────────────────────┐
   │ OpenShell (PEP)      │  │ EVIDENCE KERNEL (Go)     │  │ Postgres / SQLite   │
   │ 原封不動，per-tenant  │  │ 獨立進程/身分/語言         │  │ per-tenant DB        │
   │ Landlock/seccomp/    │  │ Tessera tile log +       │  │ (mutable 營運狀態)    │
   │ netns/microVM        │  │ Ed25519 + RFC-3161 +     │  │ lease metadata only  │
   │ OPA L4/L7 + Z3       │  │ standalone/WASM verifier │  │ (NO plaintext cred)  │
   │ SecretResolver       │  │ WORM, append-only,       │  └────────────────────┘
   │ inference router     │  │ control-plane NO rewrite │
   │ OCSF v1.7.0 emit     │  └─────────────────────────┘
   └──────────────────────┘
     ▲ upstream Rust PR (4 hardenings, §7)
```

**PDP/PEP 切分：** OpenShell = kernel/egress 的 **PEP**；TS Governance Plane = kernel 之上一切的 **PDP**（tool 准入、
approval、lease、budget、delegation、inference-route allowlist）。**決策向下流，事件向上流入 Evidence Kernel。**

---

## 3. The 11 Layers — Map + 依賴方向（inward only）

11 個 concern layer（AGENTS.md §Low coupling）映射到具體 module；**依賴只能向內**（domain ← application ←
adapters），跨平面只走 typed contract。「Plane」欄標示該 layer 落在哪個進程。

| # | Layer | Plane | Module（public surface = `index.ts` / package root） | 一句職責（high cohesion） | 允許依賴（→ 向內） |
|---|---|---|---|---|---|
| 1 | CLI / UI | TS SDK / UI | `cli/` · `ui/` | 呈現與輸入；**只**經生成 client 呼叫 Governance API | → contracts（生成 client）only |
| 2 | Task orchestration | TS gov | `src/orchestration/` | Task/AgentSession/Artifact 生命週期（XState + resume ledger） | → application、domain、contracts |
| 3 | Approval workflow | TS gov | `src/approval/` | ApprovalRequest 引擎（maker≠checker by capability possession） | → domain、policy(port)、audit(port) |
| 4 | Tool registry | TS gov | `src/tools/` | ToolManifest/ToolInvocation 註冊與 governed invocation；blast-radius estimator | → domain、policy(port) |
| 5 | Policy engine (PDP) | TS gov | `src/policy/` | deny-by-default 決策：capability algebra / SoD / budget / inference-route gate | → domain only（**無對外依賴**） |
| 6 | Credential provider | TS gov | `src/credential/` | CredentialBundle **lease metadata** lifecycle（mint→inject→use→revoke→expire）；**永不持明文** | → domain、sandbox-adapter(port) |
| 7 | Sandbox runtime adapter | TS gov | `src/adapters/openshell/` | OpenShell **chokepoint**：唯一 sandbox/credential 路徑 | → domain、contracts/openshell(proto) |
| 8 | Inference routing | TS gov | `src/inference/` | per-route policy gate + route 解析（經 adapter 下達 OpenShell） | → domain、policy(port)、sandbox-adapter(port) |
| 9 | Audit / event log | TS gov ↔ Go | `src/audit/` ↔ `kernel/` | TS：產出 typed domain event（fail-closed）；Go：durable WORM ingest + verify | TS audit → domain；Go kernel → 無（**獨立進程**） |
| 10 | Persistence | TS gov | `src/persistence/` | mutable 營運狀態（Drizzle / CAS）；**無明文 credential** | → domain（實作 repository port） |
| 11 | Enterprise tenant/IAM | TS gov | `src/iam/` | branded ids（= OCSF AgentContext）+ tenant-scoped routing（gateway-per-tenant） | → domain only |

**依賴方向硬規則（dependency-boundary check 強制，§9）：**

- `domain` 是內核：**不依賴任何其他 layer**（包含不依賴 zod-runtime 之外的 framework）。
- `application`（orchestration/approval/tools/inference 的 use-case 編排）依賴 `domain` + **ports（interface）**，**不依賴 adapters 的具體實作**。
- `adapters`（openshell / persistence / kernel-ingest client）實作 ports，**只被 application 透過 port 注入**，**不被 domain 依賴**。
- 跨 layer **只經 public surface**（`index.ts`）；**禁止 deep import**（`src/policy/internal/*`）。
- **跨平面**（TS↔Go↔Python↔UI）**只**走 proto/Zod 生成的 client；**禁止**任一平面 import 另一平面的內部 module。

> 為什麼 Policy(5) 沒有對外依賴：PDP 是純函式核心（沿用 scaffold `evaluatePolicy` 的 fail-closed/deny-by-default
> idiom）。讓它零外依賴，等於讓「正確性最關鍵的模組」最容易被獨立測試與對抗式 review（HARD B）。

---

## 4. Agent-type-agnostic Domain Model（typed, Zod single-source）

domain 物件用 **Zod schema 為 single source**（runtime 驗證 + 推導 TS 型別 + 生成 proto 對映），且**不含任何
coding-agent 專屬欄位**。沿用 scaffold：`src/iam/ids.ts` 的 branded ids **即** OCSF AgentContext 欄位。

```ts
// src/domain/ids.ts  —— 沿用現有 src/iam/ids.ts，branded、non-empty
//   TenantId · ProjectId · TaskId · ActorId · RequestId · EventId · SandboxId
//   這 7 個 branded id = OCSF AgentContext 的 (tenant/project/task/request/actor/event/sandbox)。

// src/domain/task.ts
export const Task = z.object({
  taskId: TaskId, tenantId: TenantId, projectId: ProjectId,
  status: z.enum(["created","running","awaiting_approval","resumed","completed","failed","cancelled"]),
  idempotencyKey: z.string().min(1),        // resume idempotency（不重複外部副作用）
  createdBy: ActorId,
});

// src/domain/agent-session.ts  —— agent-type-agnostic：不綁 Claude/Codex/任何 agent
export const AgentSession = z.object({
  sessionId: z.string().min(1), taskId: TaskId, sandboxId: SandboxId,
  agentKind: z.string().min(1),             // 自由字串標籤，OS 不解讀其語意（host any agent）
  parentSessionId: z.string().min(1).optional(),  // c20 sub-delegation
});

// src/domain/tool.ts  —— Tool Registry Contract（AGENTS.md loop 8 的 9 個必填欄位）
export const ToolManifest = z.object({
  name: z.string().min(1), version: z.string().min(1), description: z.string().min(1),
  inputSchema: z.unknown(), outputSchema: z.unknown(),
  requiredPermissions: z.array(z.string()).default([]),
  sideEffect: z.enum(["none","read","write","irreversible","external"]),
  timeoutMs: z.number().int().positive(),
  auditBehavior: z.enum(["always","on_effect"]),
  docsUrl: z.string().min(1),
});
export const ToolInvocation = z.object({
  invocationId: z.string().min(1), tool: z.string().min(1), version: z.string().min(1),
  sessionId: z.string().min(1), requestId: RequestId,
});

// src/domain/approval.ts  —— Approval UX Consistency（actor/task/resource/action/risk/reason/scope+expiry）
export const ApprovalRequest = z.object({
  approvalId: z.string().min(1), requestId: RequestId, actorId: ActorId, taskId: TaskId,
  resource: z.string().min(1), requestedAction: z.string().min(1),
  riskSummary: z.string().min(1), policyReason: z.string().min(1),
  scope: z.object({ expiresAt: z.string().datetime({offset:true}), amount: z.number().optional() }),
  state: z.enum(["pending","approved","rejected","expired"]),
});

// src/domain/credential.ts  —— CredentialBundle = LEASE METADATA ONLY，永不含明文 secret
export const CredentialLease = z.object({
  leaseId: z.string().min(1), bundleRef: z.string().min(1),   // reference，不是值
  beneficiary: ActorId, resource: z.string().min(1),
  ttlSeconds: z.number().int().positive(), amount: z.number().optional(),
  state: z.enum(["minted","injected","used","revoked","expired"]),
}).strict();   // .strict() 防止意外多帶欄位把 secret 夾帶進來

// src/domain/audit-event.ts  —— 沿用現有 src/audit/event.ts createAuditEvent（fail-closed）
//   AuditEvent = { eventId,requestId,timestamp,tenantId,projectId,taskId,actorId,
//                  sandboxId?, action, resource, policyDecision, result }

// src/domain/tenant.ts
export const Tenant = z.object({ tenantId: TenantId, displayName: z.string().min(1) });
```

**設計鐵則：** `CredentialLease.bundleRef` 是 reference；真正 secret 永遠只在 OpenShell `SecretResolver`，由
egress proxy 在注入點解析（openshell.md §4.3 confirmed）。`.strict()` + secret-scan + Credential Non-Leak Loop
共同保證 lease 物件不可能夾帶明文。

---

## 5. proto / Zod single-source（消除跨平面 drift）

**single-source 原則：** 一份契約定義，跨四個平面（TS gov / Go kernel / Python SDK / TS SDK+CLI / UI）共用，杜絕 schema drift。

- **目錄**：`proto/`（Buf 管理）為跨平面 wire 契約的 source of truth：
  - `proto/openshell/*.proto` — vendored 自 OpenShell（~50 RPC），**pin 在 version + image digest**（NemoClaw `min==max==0.0.44` 紀律）。
  - `proto/agentos/v1/*.proto` — 我們的 control-plane API（Task / ApprovalRequest / Tool / Tenant / CredentialLease）。
  - `proto/agentos/audit/v1/ingest.proto` — **TS↔Go ingest 契約**（§6）。
- **生成物（codegen，不手寫、不 drift）**：
  - TS gov + TS SDK + CLI + UI：`buf generate` → `connect-es`/`connect-node` typed client/server stub。
  - Go kernel：`buf generate` → Go ingest server stub。
  - Python SDK：`buf generate` → Connect-Python client stub。
- **Zod ↔ proto 對映**：domain 的 Zod schema（§4）是 TS 內部 runtime 驗證的 source；`proto/agentos/v1` 是 wire
  source。兩者由 `pnpm run contract:check` 以 round-trip property test 釘住（任一改動使另一邊測試 RED）。
- **gate**：`buf lint`（風格）+ `buf breaking --against '.git#branch=main'`（破壞性變更偵測）併入 `pnpm run proto:check`，再進 `pnpm run verify`。

> UI 限制（architecture-approach §2 已指正）：**browser 不能對 raw gRPC server 直連**——UI 與 CLI 走 Governance Plane
> 暴露的 **Connect / gRPC-Web**；live approval/audit feed 用 **server-streaming 或 polling**，**非 bidi**。

---

## 6. TS ↔ Go Ingest 契約（證據完整性的核心）

Evidence Kernel 的唯一入口是一個**狹窄、append-only**的 gRPC ingest service。它是 TS Governance Plane（auditee）
與 Go kernel（auditor）之間**唯一**的耦合點——典型 low-coupling：兩個獨立進程只透過一份 proto 對話。

```proto
// proto/agentos/audit/v1/ingest.proto  （single-source；Go server stub + TS client stub 皆由此生成）
service EvidenceIngest {
  // 唯一寫入路徑：append-only。kernel 對 control plane 不提供任何 update/delete RPC。
  rpc Append(AppendRequest) returns (AppendReceipt);   // synchronous-commit-before-effect
  rpc GetCheckpoint(CheckpointRequest) returns (SignedCheckpoint);  // 唯讀，供 verifier / UI
}

message AppendRequest {
  AgentContext context = 1;        // tenant/project/task/request/actor/sandbox（= OCSF AgentContext）
  string source_id = 2;            // 每個 emitter 一個 id（gov-shard / openshell-supervisor）
  uint64 sequence = 3;             // kernel-enforced monotonic per-source；gap = ingest 不完整 → 偵測
  string event_type = 4;           // domain event 種類（policy_decision / lease / approval / lifecycle …）
  bytes payload = 5;               // 已 redact 的 typed domain event（NO raw secret；見 §4 鐵則）
  string enforcement_tier = 6;     // §8：當下 in-force 的隔離 tier（attestation 綁定用）
}

message AppendReceipt {            // 回給 control plane 的不可否認收據；control plane 先收到才放行副作用
  uint64 leaf_index = 1;          // 在 Tessera tile log 中的位置
  bytes leaf_hash = 2;            // BLAKE3 hash-chain leaf
  bytes signed_proof = 3;         // Ed25519 over (root, leaf_index)；per-tenant key
}
```

**ingest 完整性（attest-the-negative 誠實成立的缺片，architecture-approach §1/§4 升格為一級要求）：**

1. **kernel-enforced monotonic per-source sequence + gap detection**：kernel 對每個 `source_id` 記錄期望的下一個
   sequence；缺號 = 偵測為 ingest 不完整並 raise。**control plane 不能自證完整，由 kernel 判定。**
2. **transactional outbox（在 TS 側）**：domain event 與「待 ingest」標記在**同一個 Postgres 交易**內寫入 outbox
   table；背景 dispatcher（**有 iteration cap**，無 unbounded loop）讀 outbox → `Append` → 收到 `AppendReceipt`
   後才標記 sent。crash 後重送以 `(source_id, sequence)` 去重（idempotent ingest）。
3. **synchronous-commit-before-effect**：任一外部副作用（egress / credential 注入 / sandbox 動作）放行**之前**，
   對應 domain event 必須已 `Append` 成功並拿到 `AppendReceipt`。順序硬性為 **emit → commit-to-kernel → effect**，
   消除「副作用已發生、紀錄遺失」的證據毀滅 window（c1/c4 admissibility 基礎）。
4. **append-only by construction**：kernel **不暴露** update/delete RPC；control plane **無**改寫權（不同進程/身分/語言）。

**驗收（指令）：**`cd kernel && go test ./ingest/...` 必含 (a) gap-detection RED→GREEN 測試、(b) outbox 重送
idempotency 測試、(c) 「commit-before-effect 順序違反即 fail」測試。

---

## 7. OpenShell Adapter — 單一 Chokepoint（受管路徑唯一）

`src/adapters/openshell/` 是**唯一**能建立 sandbox、鑄造 credential lease、下達 inference route 的 module。這把
「受管路徑唯一」從口號變成**結構不變量**：domain/application 層**沒有**任何其他通往 OpenShell 的路徑。

**public surface（port，由 application 注入；application 依賴 interface 不依賴實作）：**

```ts
// src/domain/ports/sandbox-runtime.ts  —— PORT（interface），定義在 domain，實作在 adapter
export interface SandboxRuntimePort {
  createSandbox(ctx: AgentContext, spec: SandboxSpec): Promise<SandboxId>;   // 唯一建立點
  stopSandbox(ctx: AgentContext, id: SandboxId): Promise<void>;
  destroySandbox(ctx: AgentContext, id: SandboxId): Promise<void>;
  exec(ctx: AgentContext, id: SandboxId, inv: ToolInvocation): Promise<ExecResult>;
  injectLease(ctx: AgentContext, lease: CredentialLease): Promise<void>; // 唯一 credential 注入點；走 SecretResolver
  resolveInferenceRoute(ctx: AgentContext, route: InferenceRouteRef): Promise<void>; // 經 per-route gate 後才下達
  readEnforcementTier(id: SandboxId): Promise<EnforcementTier>;          // §8 attestation 綁定
}
```

**chokepoint 設計要點：**

- adapter 用 `connect-node` 的 `createGrpcTransport` 對 OpenShell Rust tonic server 講 **native gRPC**（無 Envoy；
  architecture-approach delivery lens 已驗證）；CLI subprocess 僅作 Personal-mode fallback。
- **pin version + image digest** + **contract-test gate**（`pnpm run proto:check`），對 alpha proto drift 做 typed breakage。
- **release-blocking 對抗式 bypass 測試**（HARD B 的延伸，也是 Sandbox Escape Regression Loop）：證明 application
  層無法繞過 adapter 直接觸達 OpenShell；agent 在 managed entrypoint 之外啟動 runtime 必須被 admission-control /
  sealed-launch gate 擋下並 audited（attest-the-negative 退化為 attest-nothing 的防線）。
- 四項**強制路徑硬化**（活在 OpenShell 強制路徑內部、外層 TS 碰不到）以 **upstream Rust PR** 進入，**不 fork**：
  (1) inference-route policy gate（`inference.local` 預設繞 OPA → 補 deny-default）；
  (2) Landlock `hard_requirement`（預設 best_effort 在無 Landlock kernel fail-open）；
  (3) OCSF tenant/AgentContext fields（schema 已定義 `tenant_uid`，Rust struct 未填）；
  (4) 強制 runtime redaction filter（目前 non-leak 僅 convention）。
  **PR 落地前**：以 microVM tier + Core-side egress allowlist 作 interim，且把 c6/c3/c12 的 isolation attestation
  **SKU gate 在實際 merge（非 PR 提交）**。

---

## 8. Enforcement-Tier-in-Force Binding（attestation 不可超賣）

attestation（c1/c2/c3/c12 的字面產品）只在 **OS-enforced channel** 成立；其措辭**必須**綁定**當下 in-force** 的
隔離 tier，否則在「非 Landlock kernel fail-open」或「container tier」上會超賣保證。

- `EnforcementTier` 為 typed enum：`container`（弱、defense-in-depth）｜`landlock_enforced`（filesystem 硬隔離）｜
  `microvm`（libkrun，唯一硬體虛擬化，experimental）。
- **kernel 必須 per-session 記錄 tier**：adapter `readEnforcementTier()` 取得當下 tier → 隨每個 `AppendRequest.enforcement_tier`
  寫入 Evidence Kernel（§6）。verifier 重放時，attestation 的可採信度**由該 session 記錄的 tier 決定**。
- **fail-closed**：若 tier 為 `container`（非 Landlock kernel）或 tier 未知/讀取失敗 → attestation 措辭降級為
  「未由 OS channel 保證」並 **deny** 任何宣稱 OS-level isolation 的 high-assurance 動作（c3/c12 最強 tier 須 microVM）。
- **驗收（指令）：**`pnpm test -- enforcement-tier` 含「container tier 時 high-assurance attestation 被 deny」測試；
  kernel 端 `go test ./attestation/...` 證每筆證據都帶 tier、且 verifier 拒絕無 tier 的 attestation 宣稱。

---

## 9. 強制低耦合/高內聚（HARD A）— 具體 tooling 與規則

**機制（per-language，名指具體工具，併入 `pnpm run verify`）：**

| 平面 | 工具 | 強制規則 |
|---|---|---|
| TS（gov / SDK / CLI / UI） | **dependency-cruiser**（`.dependency-cruiser.cjs`） | `no-circular`（0 環）；`no-deep-import`（只准 `index.ts`，禁 `src/X/internal/*`）；`domain-no-outward`（`src/domain` 不得依賴其他 layer）；`app-not-adapter`（application 不得 import adapters 具體實作，只准 ports）；`no-cross-plane-internal`（禁 import Go/Python/UI 內部）。 |
| Python SDK | **import-linter** | `shim-credential-blind`（shim 不得 import 任何 secret-bearing module）；contract：只准依賴生成 client + domain DTO。 |
| Go kernel | **depguard** + **internal/ packages** | kernel `internal/` 不可被外部 import；ingest 與 verifier 之間單向；無對 control plane 的反向依賴。 |

`.dependency-cruiser.cjs`（節錄，forbidden 規則；`severity: "error"` 使違反即 `exit≠0`）：

```js
module.exports = { forbidden: [
  { name: "no-circular",  severity: "error", from: {}, to: { circular: true } },
  { name: "no-deep-import", severity: "error",
    from: { pathNot: "^src/([^/]+)/" },
    to:   { path: "^src/[^/]+/(?!index\\.ts)", pathNot: "^src/[^/]+/index\\.ts$" } },
  { name: "domain-no-outward", severity: "error",
    from: { path: "^src/domain/" },
    to:   { path: "^src/(orchestration|approval|tools|policy|credential|adapters|inference|audit|persistence|iam)/" } },
  { name: "app-must-use-ports", severity: "error",
    from: { path: "^src/(orchestration|approval|tools|inference)/" },
    to:   { path: "^src/adapters/" } },   // application 只准依賴 domain/ports，不准直接 import adapters
]};
```

> **HARD A 不是 aspirational**：上述 `severity: "error"` 使任一違反導致 `pnpm run deps:check` exit≠0 → `pnpm run verify`
> 失敗 → pre-commit guard 擋下 commit。coupling/cohesion 同時是 adversarial review 的**明確 blocking 維度**（§11）。
>
> **落地狀態（誠實揭露）：** `pnpm run deps:check`、`.dependency-cruiser.cjs` **今天尚不存在**，`pnpm run verify`
> **尚未**包含 `deps`。把 `deps` wire 進 verify 是 **Slice S1** 的交付物（見 §11）；在 S1 merge 前，本節描述的是
> **TARGET 形態**，HARD-A 的逐 slice 把關暫由 adversarial review 以 per-language 等效指令人工執行
> （`docs/standards/adversarial-code-review.md` §5 的 MAJOR-with-tracking 規則）。另：規則 `no-deep-import`
> 對全 `src/` 開啟前，須先完成 per-module barrel 遷移（現況 `src/audit/event.ts`、`src/policy/types.ts`
> 直接 import `../iam/ids.js`，無 per-module `index.ts`）——見 `docs/standards/engineering-standards.md` §4.1
> 的 binding ordering。

---

## 10. Module / Plane 依賴圖 — 證明 Acyclic

下圖為 §3 的依賴關係。**箭頭 = 「依賴」，全部 inward-pointing**；跨平面邊（虛線）只經 typed contract。

```
  CLI ─┐                    UI ─┐
       └──► gen-client ◄────────┘                 [Plane: TS SDK/UI]
                │  (Connect/gRPC-Web only)
                ▼
   ┌─────────────────────── GOVERNANCE PLANE (TS) ───────────────────────┐
   │  orchestration ─┐  approval ─┐  tools ─┐  inference ─┐                │
   │      │          │     │      │    │    │     │       │  (application) │
   │      └────┬─────┴─────┴──────┴────┴────┴─────┘                       │
   │           ▼                                                          │
   │        ports (interfaces in domain)  ◄── adapters implement ports    │
   │           │                                   ▲                      │
   │           ▼                                   │                      │
   │        policy ──► domain ◄── iam              │ (adapters depend     │
   │                      ▲    ▲                    │  inward on domain)   │
   │        credential ───┘    └─── audit(TS)       │                      │
   │                                                │                      │
   │  adapters: openshell-adapter ─┐  persistence ─┐│  kernel-ingest-client│
   └──────────────────────────────┼───────────────┼┼──────────────────────┘
        │ (native gRPC)           │ (Drizzle/SQL)  ││ (append-only gRPC)
        ▼                         ▼                ▼▼
   [OpenShell PEP]          [Postgres/SQLite]   [Evidence Kernel (Go)]
   (Rust, 原封不動)          (mutable state)      ingest ─► tessera-log ─► verifier
                                                  (Go internal/, 單向, 無反向邊)

   Python SDK (shim) ┄┄► gen-client ┄┄► Governance Plane API   (跨平面，只走 contract)
```

**無環證明（拓撲排序存在 ⇔ DAG ⇔ acyclic）。** 給每個節點一個 rank，所有邊 high→low：

> **無環證明的 load-bearing 前提（必須在此明說，否則 §3 看似有 rank1→rank2 回邊）：**
> **所有 port（interface）都定義在 `domain`（rank 0），實作才在 adapters（rank 2）。** 因此 §3 row 6
> `credential → sandbox-adapter(port)` 與 row 8 `inference → sandbox-adapter(port)` 的箭頭，**指向的是
> 位於 domain（rank 0）的 port interface，不是 adapter 具體實作（rank 2）**。依賴反轉（DIP）：高層只依賴
> 抽象（port∈domain），adapter 在 composition root 被注入。少了這條前提，會誤判出一條 rank1→rank2 的回邊；
> 有了它，所有邊嚴格 high→low。

| rank | 節點 |
|---|---|
| 0（最內） | `domain`（**含全部 ports interface**——所有 `XxxPort` 都在此 rank） |
| 1 | `policy`、`iam`、`audit(TS)`、`credential`（其對 sandbox 的依賴是 **port∈rank0**，非 adapter） |
| 2 | `adapters`（openshell-adapter / persistence / kernel-ingest-client）— **實作** rank0 的 ports，依賴 domain |
| 3 | `application`（orchestration / approval / tools / inference）— 依賴 domain + ports（rank0） |
| 4 | `gen-client` |
| 5（最外） | `CLI`、`UI`、`Python SDK` |
| 獨立進程（無入邊到 TS 內部） | `OpenShell PEP`、`Postgres/SQLite`、`Evidence Kernel`（只被 adapters 經 typed contract 觸達） |

每條邊都從較高 rank 指向較低 rank（application(3)→ports/domain(0)、application(3)→domain(0)、adapters(2)→domain(0)、
policy/credential/audit/iam(1)→**port∈domain(0)**、gen-client(4)→Governance API、CLI/UI/SDK(5)→gen-client(4)）。
**存在嚴格遞減的 rank 排序 ⇒ 不存在回邊 ⇒ 圖無環。** 三個外部進程是 sink-only（無指向 TS 內部的邊），跨平面邊
全部經 typed contract，故不引入跨平面環。**此性質由 `pnpm run deps:check` 的 `no-circular` 規則機器強制**（§9，
S1 落地後），非僅紙上證明。

---

## 11. Per-Slice Adversarial Review（HARD B）— 套用到本架構

實作**必須**切成小 slice（`docs/standards/slice-spec.md`），每個 slice：先寫 RED failing test（TDD）→ GREEN →
過 `pnpm run verify`（含 `pnpm run deps:check`）→ **fresh-context adversarial reviewer**（`docs/standards/adversarial-code-review.md`，
其職責是 BREAK 它）→ PASS 才 merge。**無 slice 可僅憑 self-review 合併。**

> **本表是「順序總覽（ordering overview）」，不是 slice-doc 本身。** 每一列在實作前**必須**展開成一份
> 符合 `docs/standards/slice-spec.md` §10 範本的完整 slice-doc（含完整 DoD、單一責任、**~≤1 day / ~≤300→400
> LOC / ~≤8→12 files / ~≤2→3 modules 尺寸界**、剛好一次 adversarial review），存放於 `docs/design/slices/`
> （該目錄須隨第一份 design-slice 一併建立）。**逾尺寸的列必須先拆**：
> - **S4 明顯多日、多責任**（ingest proto + 整個 Go kernel + gap detection + outbox），**拆為** S4a
>   kernel skeleton／S4b ingest proto 契約／S4c gap-detection／S4d transactional outbox 四個獨立 slice。
> - **S5**（adapter chokepoint + bypass 測試）**拆為** S5a adapter interface + null/fail-closed 實作／
>   S5b live connect-node client + pin／S5c release-blocking bypass conformance。
>
> Phase 0 的可實作 slice 以 `docs/slices/phase-0/`（S0.1–S0.6）為準；下表 S1–S7 為跨 phase 的設計順序總覽，
> 與 `docs/slices/phase-0/` 的對應關係：S1 ↔ `SLICE-P0-003`、S2 部分 ↔ `SLICE-P0-001`、S4a 種子 ↔ `SLICE-P0-005`、
> S5a ↔ `SLICE-P0-004`。

| Slice（順序總覽） | 內容 | RED→GREEN gate | adversarial reviewer 必試 break 的點（含 coupling/cohesion） |
|---|---|---|---|
| S1 | dependency-boundary check 上線（`.dependency-cruiser.cjs` + `pnpm run deps:check` 進 verify；含 pinned dev dep） | `pnpm run deps:check` 對一個刻意違規 fixture exit≠0；對現 src exit 0 | 能否新增一條深 import / 環而不被擋？domain 能否偷偷依賴 adapter？ |
| S2 | domain Zod schemas（§4，agent-agnostic）+ ports interface | `pnpm test -- domain` | 能否塞 coding-agent 專屬欄位？`CredentialLease` 能否夾帶明文（`.strict()` + secret-scan）？ |
| S3 | proto/Zod single-source + codegen + `proto:check` | `pnpm run proto:check`；`contract:check` round-trip | 改 proto 不改 Zod，contract test 是否 RED？breaking change 是否被 `buf breaking` 擋？ |
| **S4（須拆 S4a–S4d）** | TS↔Go ingest 契約 + Go kernel（簡單 append-only 簽章 log）+ gap detection + outbox | `cd kernel && go test ./...` | 缺號 sequence 能否被吞？control plane 有無任何 update/delete 路徑？crash 重送是否重複 leaf？ |
| **S5（須拆 S5a–S5c）** | OpenShell adapter chokepoint + bypass 測試 | `pnpm test -- adapter-bypass`（release-blocking） | 能否繞過 adapter 直達 OpenShell？managed entrypoint 外啟動是否被擋並 audited？ |
| S6 | enforcement-tier binding（§8） | `pnpm test -- enforcement-tier` | container tier 時 high-assurance attestation 是否仍被放行（必須被 deny）？無 tier 證據 verifier 是否拒絕？ |
| S7 | synchronous-commit-before-effect 編排（orchestration） | `pnpm test -- commit-before-effect` | 能否構造「副作用先於 ingest」的順序？crash window 是否丟證據？ |

> reviewer 的 coupling/cohesion checklist（每個 slice 必跑）：是否新增跨 layer/跨平面依賴？是否 deep-import？模組
> 是否仍單一職責？是否經 public surface 消費？任一為「否」即 review FAIL，slice 不得 merge。
>
> **HARD B 的 merge-gate 機制（讓「review 發生過」本身可驗證，非自述）：** 每個 slice 的 merge 前置是一份
> 依 `docs/standards/adversarial-code-review.md` §4 模板填寫、含 reviewer(!=author) 親跑指令 exit code 的
> **結構化 PASS verdict**，作為 **durable artifact** 寫入該 slice 的 `## Adversarial Review` 區段 / PR 描述；
> pre-merge 檢查該區段存在且 `VERDICT: PASS`（無此 artifact 即視為未審、不得 merge）。**Pre-Commit Guard
> （`.githooks/pre-commit` 跑 `pnpm run verify`，禁 `--no-verify`）是其機械底線。**

---

## 12. Deployment Topology

**Personal Agent Workstation（local-first）：**

- 單一 Node 進程（Governance Plane）+ 本機 Go Evidence Kernel（SQLite-backed tile store；**先簡後繁**：MVP 用簡單
  append-only hash-chained + Ed25519 簽章，再 **in-place** 升級為完整 Tessera + RFC-3161 外部錨定）+ 一個本機
  OpenShell gateway（Docker/Podman/libkrun）+ SQLite + 本機 Next.js UI。
- single-user **mTLS**。為降低本機安裝重量，Evidence Kernel 與 Core 以 **docker-compose / 單一 launcher** 打包。
- Python shim 在 OpenShell sandbox 內 host 一個真實第三方 agent；事件落入 Evidence Kernel（c24 beachhead）。

**Enterprise Agent Runtime Platform（multi-tenant）：**

- **gateway-per-tenant（進程/namespace 邊界，非 `tenant_id` row filter）**：每租戶一個 OpenShell gateway +
  一個 shared-nothing Governance Plane shard + **per-tenant Postgres DB（database/schema-per-tenant）**，前置一個
  **tenant-routing gateway（Envoy）**。
- Evidence Kernel 為 multi-tenant cluster，但**每租戶獨立 Merkle tree + 每租戶獨立簽章金鑰**（per-customer isolation
  attestation 不能由「簽每客戶鏈的同一把 key」背書）。
- 沿用 OpenShell 既有 **Helm/K8s + per-tenant namespacing + tenant-scoped NetworkPolicy + mTLS + OIDC RBAC +
  SPIRE/SPIFFE**。
- **release-blocking 跨租 conformance suite**：tenant A 嘗試讀/寫 tenant B 的 task/credential/log/sandbox/policy/
  artifact，全數 **denied + audited**（Tenant Isolation Loop；無此 suite 綠不得 release）。

---

## 13. 一個 privileged action 的正則路徑（端到端 data flow）

1. agent（untrusted，在 OpenShell sandbox 內）發 tool/credential/egress/inference 請求 → **Python shim** 經 ConnectRPC
   轉給 Governance Plane（shim **credential-blind**：只 marshaling，從不持 secret）。
2. Governance Plane **PDP（policy layer）** 評估 ToolManifest + Policy + budget + delegation algebra（**deny-by-default**）。
3. 若 privileged → 鑄 **ApprovalRequest**（maker≠checker **by capability possession**，非 if-check）→ 路由到 Inbox。
4. 批准後 → 鑄 **scoped CredentialLease**（TTL / amount / beneficiary / resource-bound）→ **唯一**經 adapter 的
   `injectLease()` 由 OpenShell SecretResolver 在 egress 注入（agent 從不見 secret）。
5. **synchronous-commit-before-effect**：先把 AgentContext-tagged、已 redact 的 domain event **`Append` 進 Evidence
   Kernel 並拿到 `AppendReceipt`**，**再**放行外部副作用（§6 步驟 3）。
6. Evidence Kernel hash-chain + 簽章 + 週期外部錨定；over-budget 或 unmatched policy = **deny by construction +
   audited**。每筆證據帶 §8 的 `enforcement_tier`。

---

## 14. Open Issues（交給後續 design/eng review 與 implementer）

1. **proto 穩定性**：OpenShell alpha proto 視為 Enterprise 穩定 ABI 的程度？以 version+digest pin + contract-test 緩解，但 NVIDIA 無 merge 承諾。
2. **Tessera < 1.0**：API 1.0 前可能 minor breaking；把 kernel 放在 log-engine interface 後（engine 可換），Personal MVP 先用簡單 hash-chained log。
3. **attestation 可採信度（非工程）**：c1/c2/c3/c4 的價值押在「signed claim 是資產」；須在擴大投入前找 outside counsel / auditor / E&O insurer 審視措辭與 evidence bundle（最大不確定性 swing factor）。
4. **libkrun microVM experimental**：唯一硬隔離 tier 目前忽略 CPU/memory limit；c3/c12 最強 tier 須先 upstream 硬化。
5. **Zod↔proto 對映工具鏈**：`contract:check` 的 round-trip 測試以手寫 mapper 還是 codegen mapper？implementer 二選一，但**必須**有 RED test 釘住 drift。
6. **outbox dispatcher iteration cap 的具體值**：背景 dispatcher 必須有 cap（無 unbounded loop）；具體 cap 與退避策略待 P1 定。
7. **本文件引用的檔案尚未存在（誠實揭露，不可被讀成已可跑）**：`.dependency-cruiser.cjs`、`proto/`、`kernel/`、`sdk/python/`、`cli/`、`ui/`、以及 `pnpm run deps:check` / `proto:check` / `contract:check` script **目前都不在 repo**（已用 2026-06-19 `package.json` 核實）。§0 表中標 **TARGET** 的指令，**只在其對應 slice（S1 / S3 / S4 / …）以 TDD 建好後才會綠**；在那之前不得把它們當成已通過的驗收。本文件不解除此事實，只把它綁到 slice。

---

*本文件把 Two-Plane Polyglot 決策落成可建構設計；每條驗收皆對應可執行指令（only command output is truth，
標 TARGET 者於對應 slice 落地後方綠）。低耦合/高內聚將由 dependency-cruiser/import-linter/depguard wire 進
`pnpm run verify` 強制（HARD A；TS 端為 Slice S1 的交付物，落地前由 adversarial review 以等效指令人工把關），
每個 slice 須過 fresh-context 對抗式 review 並留下結構化 PASS verdict（durable artifact）才 merge（HARD B）。
沿用並擴充現有 scaffold，不重寫。未含任何 secret-like 值。*
