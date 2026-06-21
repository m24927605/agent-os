# 設計文件 — R6 inference routing gate（推論路由閘）

> 2026-06-21。Doc-first（無 code）。方法論見 [`looping-engineering.md`](../standards/looping-engineering.md)：
> 小 slice、RED 先行、Independent Verifier Pass（獨立 Opus 4.8 reviewer）、5 回合上限 → Staff+ 升級。
> 權威約束見 [`AGENTS.md`](../../AGENTS.md)（PDP=唯一 deny 權威；三大不可插拔壟斷；5 個 vendor-neutral 槽位）。
> 上層計畫骨架見 [`../slices/phase-2-remaining/INDEX.md`](../slices/phase-2-remaining/INDEX.md) ITEM **R6**。
> 架構脈絡見 [`three-surface-architecture.md`](./three-surface-architecture.md) 與 [`five-piece-integration.md`](./five-piece-integration.md)。
> **AGENTS.md 在任何衝突上勝出。only command output is truth。**

---

## 1. What / Why（要做什麼、為何要做）

### 1.1 問題

Agent 的「推論呼叫」（送 prompt 給某個 model/provider 取得 completion）是一條**特權 egress 路徑**：
它把 workspace 內容、對話歷史、甚至注入的憑證送往一個**外部主機**，並產生**真實成本**。
目前 Agent OS core 已具備三大壟斷的種子——PDP（`src/policy/evaluate.ts`）、CostGate port
（`src/cost/port.ts`）——但**還沒有任何一層把「哪個 model 可被路由、egress 去哪、要不要先過 PDP、
要不要先 reserve 成本」收斂成單一可驗的 gate**。沒有這層，一個失控的 brain 可以：

1. 路由到一個**未經授權的 model**（例如把資料送進一個未審核的 frontier model）；
2. egress 到一個**不在 allowlist 的主機**（資料外洩路徑）；
3. 在**未過 PDP**、**未 reserve 成本**的情況下就觸發昂貴的 provider 呼叫。

### 1.2 目標（this ITEM）

新增一個 vendor-neutral 的 **InferenceRoutingGate**：在任何推論 egress **發生之前**，把四道關卡串成
**單一 chokepoint**，每一道都 deny-by-default + fail-closed：

1. **per-model deny-by-default**：請求的 `(model, provider)` 必須在一份明確的 allowlist 上，否則 deny。
2. **egress allowlist（interim）**：解析出的 egress host 必須在一份明確的 host allowlist 上，否則 deny。
3. **PDP 整合**：把推論請求轉成 `PolicyRequest(action="inference:invoke")` 餵給既有 PDP
   （`evaluatePolicy`），PDP deny 即 deny（PDP 是唯一 deny 權威，gate 不得自行翻轉）。
4. **CostGate hook**：用 `model → estimatedTokens/cost` 對映向既有 CostGate `reserve` 預留；
   reserve denied（hard-cap）即 deny（reserve-before-effect）。

**任一關卡 deny → 整體 deny**（any-deny-wins）。只有四關全 allow + 成本已 reserve，gate 才回
`{ decision: "allow", reservationId }`，呼叫方才可進行真實 egress。

### 1.3 為何 vendor-neutral（low coupling）

依 [`AGENTS.md`](../../AGENTS.md)「no vendor name in core」：gate 落在 core，**不得**提及任何 vendor
名稱。OpenShell 的 `inference.local` / `GetInferenceBundle` 是**預設 adapter** 將來消費的下游介面
（落 `src/runtime/<vendor>/` 或 `src/cost/adapters/<vendor>/`），不是 core 的依賴。gate 只認
vendor-neutral 的型別化請求（model id、provider type、egress host），以及既有 core port（PDP、CostGate）。

---

## 2. Architecture（架構）

### 2.1 在五件套中的位置（grounded）

[`five-piece-integration.md`](./five-piece-integration.md) 的元件呼叫圖已宣告 R6 的設計意圖：

> `[CostGate Port] SpendGuard → 坐在 inference.local egress 內，只見 redacted header；reserve-before-effect、hard-cap`

亦即：**真實 egress 點是 OpenShell 的 `inference.local`**，CostGate 坐在那條 egress 上。R6 在 core 側
把「決定要不要放行、放行哪個 model、預留多少成本」做成 gate；OpenShell 側則是執行 egress 的 substrate。

OpenShell 的推論模型（**verified-from-code**）：

- `inference.local` 是 sandbox 內攔截推論流量的 route 名稱
  （`/tmp/openshell/crates/openshell-router/src/config.rs:41` 註解、`backend.rs:888,1002,1089,...`）。
  > `config.rs:41`：「Route name used for identification (e.g. "inference.local", "sandbox-system")」。
- `GetInferenceBundle` RPC 把 gateway 解析後的 route bundle 交給 sandbox-local 執行
  （`/tmp/openshell/proto/inference.proto:13-14`）；每條 `ResolvedRoute` 帶 `name / base_url /
  protocols / api_key / model_id / provider_type / ...`（`inference.proto:102-117`）。
  > **重要安全事實（verified-from-code）**：`GetInferenceBundleResponse` 內含 `api_key`
  > （`inference.proto:108` `string api_key = 4;`），所以該 RPC **要求 sandbox principal**
  > （`/tmp/openshell/crates/openshell-server/src/inference.rs:819-822`：「GetInferenceBundle requires
  > a sandbox principal / an authenticated sandbox principal」；`docs/reference/gateway-auth.mdx:130`：
  > 「returns route material that includes provider credentials, so it requires a sandbox principal」）。
  > → core 側的 gate **絕不**接收 `api_key`：gate 只在「決定放行」階段運作，憑證注入是 OpenShell
  > SecretResolver 的職責（credential-blind，對齊 five-piece 壟斷 #2）。
- **egress 是 deny-by-default 的**（verified-from-doc）：
  `/tmp/openshell/docs/security/best-practices.mdx:40-51`「Deny-by-Default Egress … If no
  `network_policies` entry matches the destination host, port, and calling binary, the proxy denies
  the connection.」並有 per-provider **header allowlist**（`docs/sandboxes/inference-routing.mdx:27`）。
  → 我們的 **egress allowlist（interim）** 與此一致：在 core 側先做一層 host allowlist，作為
  OpenShell network_policies 落地前的 interim guard（INDEX.md R6「egress allowlist(interim)」）。

### 2.2 資料流（intent 往下流，deny 任一關即止）

```
brain 發出 InferenceRequest { model, providerType, egressHost, estimatedTokens, AgentContext }
   │
   ▼  InferenceRoutingGate.authorize(req)   ← core，single chokepoint
   ├─(1) model allowlist：(model,providerType) ∉ allowlist → deny（deny-by-default）
   ├─(2) egress allowlist：egressHost ∉ allowlist → deny（deny-by-default）
   ├─(3) PDP：evaluatePolicy(toPolicyRequest(req)) → deny → deny（PDP 唯一權威）
   ├─(4) CostGate：reserve(ctx,{estimatedTokens:cost(model), resource}) → denied → deny（hard-cap）
   │     └─ 任一上游關卡 deny ⇒ 不呼叫 reserve（不留下孤兒預留）
   ▼
   allow ⇒ { decision:"allow", reservationId }   ← 呼叫方憑此才可向 OpenShell inference.local egress
```

**順序是設計決定**：cheap-and-local 的檢查（model、egress allowlist）先跑，PDP 次之，**CostGate
reserve 最後**——因為 reserve 會佔用預算（有副作用：hold），上游任一 deny 時不得呼叫 reserve，
避免留下永遠不會 commit 的孤兒預留（reserve-before-effect 的對偶：never-reserve-on-deny）。

### 2.3 模組落點（low coupling / high cohesion）

| 模組 | 唯一責任 | 依賴（僅 public surface） |
|---|---|---|
| `src/inference/types.ts` | 定義 vendor-neutral `InferenceRequest` Zod schema + `InferenceDecision` 型別 | `../iam/ids.js`（AgentContext/ids） |
| `src/inference/model-allowlist.ts` | per-model deny-by-default 判定（純函式） | `./types.js` |
| `src/inference/egress-allowlist.ts` | egress host deny-by-default 判定（純函式） | `./types.js` |
| `src/inference/cost-map.ts` | `model → estimatedTokens` 對映（fail-closed：未知 model→無估算） | `./types.js` |
| `src/inference/gate.ts` | 組合四關卡成單一 `InferenceRoutingGate.authorize`（any-deny-wins） | `./*.js`、`../policy/index.js`（PDP 型別，**barrel 由 S3 新建**）、`../cost/index.js`（CostGate，已存在）|
| `src/index.ts` | barrel re-export | — |

> 依賴方向（inward、acyclic）：`gate.ts → {model-allowlist, egress-allowlist, pdp-adapter, cost-map, types}`（同模組）
> ＋ `pdp-adapter.ts → policy/index.js`（PDP 型別）＋ `gate.ts → cost/index.js`（CostGate，既有 core port）。
> **無** vendor import；**無** deep import（只經 barrel）。
> ⚠️ **驗證得知（verified-from-code）**：`src/cost/index.ts` barrel **已存在**，但 `src/policy/` **尚無** `index.ts`
> （只有 `types.ts`/`evaluate.ts`/`dedup.ts`）。dependency-cruiser 的 `not-to-internal` 規則
> （`.dependency-cruiser.cjs:33-44`）只允許跨 module 經對方 `index.ts` barrel；既有 source（如 `orchestration/pipeline.ts`）
> 也只經 barrel 消費、不 deep-import policy。故 **S3 必須順手新建 `src/policy/index.ts`**（re-export `types`/`evaluate`/`dedup`），
> `inference → policy` 才能合規（不可 deep-import `../policy/types.js`）。
> `inference` 須加入 no-vendor-in-core 的 core from-list（`.dependency-cruiser.cjs:60` 的 path regex，與 `cost`/`policy`
> 同級；見 P2-G DoD「`cost` 在 core from-list」的前例）。

---

## 3. Reused vs New（重用既有 vs 新建）

### 3.1 重用（既有 port / kernel / fakes，verified-from-code）

- **PDP**：`src/policy/evaluate.ts` `evaluatePolicy(input, rules)`（`evaluate.ts:106` 起，overload 至 ~177）——
  deny-precedence、deny-by-default、fail-closed、reason 不回顯請求值（`evaluate.ts:1-9` 不變量註解）。
  gate 把 `InferenceRequest` 轉 `PolicyRequest`（`src/policy/types.ts:10-19`，action=`"inference:invoke"`），
  **不新增 PDP 邏輯**，只消費。
  > 注意（精確化，避免 over-claim）：採 §4.3 取捨 3 的注入式設計後，`inference` source **直接 import 的只有 PDP 型別**
  > （`PolicyRequest`/`PolicyDecision`，經 S3 新建的 `policy/index.js` barrel）；`evaluatePolicy` 這個**函式**由 composition
  > root 包成 `evaluate` 注入，`inference` 不直接 import 該函式（降低對 PDP 具體實作的硬耦合）。
- **CostGate**：`src/cost/port.ts` `interface CostGate.reserve(ctx, {estimatedTokens, resource})`
  （`port.ts:47-50`）——reserve-before-effect、hard-cap、credential-blind（`port.ts:1-12`）。
  gate 只呼叫 `reserve`；**`commit` 不在本 ITEM**（commit 屬 effect 完成後、orchestration/後續，見 §6）。
  測試用既有 `InMemoryCostGate`（`src/cost/in-memory.ts`）與 `NullCostGate`（`src/cost/null.ts`）當 fake。
- **identity 基元**：`src/iam/ids.js` `AgentContext` / `parseAgentContext`（被 `cost/port.ts:13` 與
  `policy/types.ts:8` 共用），gate 沿用同一身分契約。

### 3.2 新建（本 ITEM 的最小新增）

- `src/inference/` 模組（types / model-allowlist / egress-allowlist / cost-map / gate）。
- `inference` 加入 no-vendor-in-core core from-list（dependency-cruiser 設定的單行調整）。
- barrel `src/index.ts` 增 `export * from "./inference/index.js"`。

### 3.3 **不**新建（明確排除，避免 scope 蔓延）

- **不**寫 OpenShell `GetInferenceBundle` connect client（屬 R1 live substrate / 真實 adapter，落
  `src/runtime/<vendor>/`；本 ITEM 只定義 core 側的 vendor-neutral gate）。
- **不**接 WORM kernel ingest（推論決策餵 kernel 屬 R2 ingest client）。
- **不**做憑證注入 / SecretResolver（OpenShell 職責；gate credential-blind by construction）。
- **不**做 CostGate `commit` / `release`（commit 屬 effect 之後；`release(reservationId)` 是 R12 follow-up）。

---

## 4. Trade-offs（取捨）

1. **egress allowlist 在 core vs 在 OpenShell**：真正的 deny-by-default egress enforcement 在 OpenShell
   proxy（`best-practices.mdx:40-51`）。core 側再做一層 host allowlist 看似重複，但這是 **interim**
   （INDEX.md R6 明寫「egress allowlist(interim)」）：在 R1/R11 真實 adapter 把 OpenShell network_policies
   接上之前，core gate 提供 fail-closed 的第一道防線；且 core 側的 allowlist 可被單元測試直接驗證
   （不需起 sandbox）。取捨：接受短期「兩層」以換取**早期可驗的 deny-by-default**；R11 落地後此層降為
   defence-in-depth 而非唯一防線。
2. **model→cost 用 token 估算而非真實計價**：CostGate port 收 `estimatedTokens`（`port.ts:38-41`），
   不收貨幣。gate 的 cost-map 只做 `model → estimatedTokens` 對映；真實計價是 SpendGuard adapter 內部
   （SpendGuard 的 OVERRUN_DEBT，見 P2-G）。取捨：core 保持 credential-blind 且 vendor-neutral，
   不內嵌任何 vendor 的價目表。
3. **gate 不持有 PDP 規則集**：`evaluatePolicy` 需要 `rules` 參數。gate 的 `authorize` 簽章接收
   `(req, rules)` 或在建構時注入一個 `evaluate: (req)=>PolicyDecision` 函式——後者更鬆耦合
   （gate 不關心規則從哪來），採後者。取捨：多一個建構期注入點，換取 gate 與規則來源解耦。
4. **any-deny-wins 的順序**：見 §2.2，把有副作用的 reserve 放最後。取捨：四關卡不可平行（reserve 依賴
   上游全 allow），略增延遲，但避免孤兒預留——對齊 reserve-before-effect 的不變量方向。

---

## 5. Security invariants（安全不變量，gate 必守）

| 不變量 | 落點 | 對抗式 RED（在 slice §5） |
|---|---|---|
| **per-model deny-by-default** | model-allowlist | 未知 model / 未知 provider / model 在 allowlist 但 provider 不符 → deny |
| **egress deny-by-default** | egress-allowlist | 未知 host / 空 host / 大小寫/子網域繞過嘗試 → deny |
| **fail-closed** | 全模組 | malformed `InferenceRequest`（Zod parse fail）→ deny，never allow；任一步 throw → deny |
| **PDP 唯一權威** | gate | PDP deny 時，即使 model/egress allow、即使 reserve 會成功，整體 deny；gate 不翻轉 PDP |
| **reserve-before-effect / hard-cap** | gate→CostGate | reserve denied（budget 耗盡）→ 整體 deny；上游 deny 時**不呼叫 reserve**（no orphan hold） |
| **credential-blind** | types / gate | `InferenceRequest` schema **無** api_key / secret / token-bearing 欄位（結構斷言）；gate 不接收 `ResolvedRoute.api_key` |
| **reason 不洩值** | gate | deny reason 只含關卡名 / 靜態文字 / model id（非 secret），不回顯整個請求 |

---

## 6. Honest capability gates（誠實能力邊界）

- **verified-from-code**：`inference.proto` 的 RPC/欄位（含 `api_key`）、`inference.local` route 名稱、
  `GetInferenceBundle` 要求 sandbox principal、bundle→resolved routes 轉換（`inference_routes.rs:304-333`）。
- **verified-from-doc（非 code）**：deny-by-default egress 與 per-provider header allowlist 的語意
  （`best-practices.mdx`、`inference-routing.mdx`）——這些是 OpenShell 行為描述，core 側 interim allowlist
  與之**對齊**但不依賴其執行。
- **inferred（待 R1/R11 驗證）**：真實 egress host 從 `ResolvedRoute.base_url` 解析的精確規則、
  network_policies 與 core allowlist 的對映、timeout/protocol 對 gate 決策的影響——本 ITEM **不**鎖定，
  留給 R1 live substrate / R11 真實 vendor adapter。
- **本 ITEM 交付的是 core 側 vendor-neutral gate 的可驗骨架**，不是端到端的 live 推論路徑；live 路徑
  在 R1 + R11 + R2（ingest）合流後才完整。

---

## 7. Slice 分解（每片小、acyclic、RED 先行）

| Slice | 標題 | Depends-on | Size 預算 |
|---|---|---|---|
| **P2R-R6-S1** | per-model deny-by-default gate（+ InferenceRequest schema） | P2-E | net <~180、files <~5、modules 1 |
| **P2R-R6-S2** | egress allowlist（interim） | P2R-R6-S1 | net <~120、files <~3、modules 1 |
| **P2R-R6-S3** | PDP 整合（inference:invoke → evaluatePolicy） | P2R-R6-S1, P2-E | net <~150、files <~3、modules 1 |
| **P2R-R6-S4** | CostGate(model→cost) reserve hook + 組合 any-deny-wins | P2R-R6-S2, P2R-R6-S3, P2-G | net <~200、files <~4、modules ≤2 |

Slice DAG（無 cycle）：
```
P2-E ─▶ S1 ─▶ S2 ─┐
        └──▶ S3 ───┼─▶ S4 ◀─ P2-G
P2-E ──────────────┘
```
S1 立 schema + 第一關；S2/S3 各自加一關（皆只依賴 S1 的型別）；S4 收尾把 CostGate 接上並組合成單一
`authorize`（any-deny-wins）。每片皆 RED 先行、DoD 命令可驗（exit code）。

---

## 8. Grounded citations（真實 file:line）

- `/tmp/openshell/proto/inference.proto:13-14` — `GetInferenceBundle` RPC。
- `/tmp/openshell/proto/inference.proto:100-125` — `GetInferenceBundleRequest` / `ResolvedRoute`（含
  `api_key=4`、`model_id=5`、`provider_type=6`、`base_url=2`）/ `GetInferenceBundleResponse`。
- `/tmp/openshell/crates/openshell-server/src/inference.rs:819-822` — GetInferenceBundle 要求
  authenticated sandbox principal（因 bundle 含憑證）。
- `/tmp/openshell/docs/reference/gateway-auth.mdx:130` — bundle「returns route material that includes
  provider credentials, so it requires a sandbox principal」。
- `/tmp/openshell/crates/openshell-router/src/config.rs:41` — `inference.local` route 名稱語意。
- `/tmp/openshell/crates/openshell-supervisor-network/src/inference_routes.rs:304-333` —
  `bundle_to_resolved_routes`（bundle → router ResolvedRoute）。
- `/tmp/openshell/docs/security/best-practices.mdx:40-51` — Deny-by-Default Egress（host/port/binary
  不匹配即拒）。
- `/tmp/openshell/docs/sandboxes/inference-routing.mdx:27` — per-provider header allowlist。
- core 重用面：`src/policy/evaluate.ts:106-177`（PDP）、`src/policy/types.ts:10-19`（PolicyRequest）、
  `src/cost/port.ts:38-50`（ReserveRequest/CostGate）、`src/cost/in-memory.ts:21-52`（InMemoryCostGate
  reserve hard-cap）、`src/iam/ids`（AgentContext）。
</content>
</invoke>
