# R11 — 真實 vendor adapter（腦 / hosting / 成本 / policy）設計

> 2026-06-21，doc-first（純設計、無 code）。把 P2 已建的 4 個 vendor-neutral port 各接上**一個真實 vendor
> adapter**，落在 `src/<slot>/adapters/<vendor>/`，**不污染 core**（`no-vendor-in-core` 持綠）。
> 權威約束見 [`AGENTS.md`](../../AGENTS.md)（5 槽位 + 三大不可插拔壟斷）、整合骨架見
> [`five-piece-integration.md`](./five-piece-integration.md)、三 surface 定位見
> [`three-surface-architecture.md`](./three-surface-architecture.md)。
> 方法論見 [`looping-engineering.md`](../standards/looping-engineering.md)；slice 範本見
> [`slice-spec.md`](../standards/slice-spec.md)。**AGENTS.md 在任何衝突上勝出。only command output is truth。**

---

## 0. What / Why（一段話）

P2 已把 5 個槽位變成 vendor-neutral port + ≥2 in-tree impl + contract test（見
[`phase-2/INDEX.md`](../slices/phase-2/INDEX.md)）。R11 不新增 port、不改 core、不碰 contract test 的既有
斷言，只在每個 port 後面**新增一個真實 vendor adapter**，證明「承諾 v1 棧」（Hermes 腦、NemoClaw hosting、
SpendGuard 成本、AGT policy）能在**不違反三大壟斷**的前提下插進來。每個 adapter 是 ONE module，落
`src/<slot>/adapters/<vendor>/`，**對 core 零新增耦合**，並且**重用既有 port + contract harness 過測**。

**為何此刻做、為何拆成 4 個獨立小 slice：** 這 4 個 adapter 彼此**無依賴**（各自只 implement 自己 port 的
interface），是天然的 4 條獨立小 slice，可並行、可獨立 revert，且每個都遠在 size budget（net LOC <~300、
files <~6、modules <~2）內。把它們綁成一個大 slice 會讓 adversarial reviewer 在單次 fresh-context 讀不完，
違反 [`slice-spec.md` §3](../standards/slice-spec.md)。

**誠實的範圍邊界（capability gates）：** R11 的 adapter 是**契約層 shim**，不是 live wire。真實的進程啟動
（NemoClaw `nohup+gosu` 真的 exec）、真實 OpenShell sandbox 連線、真實 SpendGuard ledger gRPC、真實 AGT
`GovernedCallable` runtime，**都依賴 R1（live OpenShell substrate adapter）尚未完成的傳輸層**，故 R11 的每個
adapter 都以**注入式 transport/port 邊界**對待真實 vendor：adapter 把 vendor 的**呼叫形狀（call shape）與
語義（semantics）**忠實對映到我們的 port，但 transport 本身是可注入的 seam（contract test 用 in-process fake
transport 過測，live transport 留給 R1 之後的整合 slice）。**這條 gate 在每個 slice 的 §3 Out-of-scope 明寫，
不靜默略過。**

---

## 1. 架構：adapter 落點與依賴方向

```
src/
  runtime/brain/
    port.ts  credential-guard.ts  fakes.ts  index.ts        # P2-D，core（已建，不改）
    adapters/hermes/                                          # R11-S2（新）
  hosting/
    port.ts  null.ts  in-memory.ts  index.ts                 # P2-H，core（已建，不改）
    adapters/nemoclaw/                                        # R11-S1（新）
  cost/
    port.ts  null.ts  in-memory.ts  index.ts                 # P2-G，core（已建，不改）
    adapters/spendguard/                                      # R11-S3（新）
  policy/
    types.ts  evaluate.ts  dedup.ts ...                       # P2-E，core（已建，不改）
    adapters/agt/                                             # R11-S4（新）
```

依賴方向（向內、無 cycle；每個 adapter → 自己 port 的 public surface，NEVER 反向、NEVER 跨 vendor）：

```
adapters/<vendor>  ──▶  <slot>/port.ts (或 dedup.ts/types.ts)  ──▶  iam/ids + zod
       │                  （同 slot 內 import，barrel 經 src/index.ts 之外的 module-internal path）
       └─▶ (injected) Transport seam  ── 由 composition root 在 R1 之後 wire；core 不 import vendor SDK
```

**`no-vendor-in-core` 如何持綠（精確對齊規則實況，不誇大）：** [`phase-2/INDEX.md`](../slices/phase-2/INDEX.md)
的 P2-B 已把「core 禁 import vendor 名（hermes|nemoclaw|openshell|agt|spendguard）」變 `pnpm run deps:check`
可驗。`.dependency-cruiser.cjs` 的 `no-vendor-in-core` 規則（`.dependency-cruiser.cjs:49-70`）有兩個**已驗證
的實況邊界**，R11 必須照實對待、不可誤述：
1. 規則的 `from.path` **只涵蓋** `src/(iam|policy|audit|commitgate|orchestration|credential|approval|tools|cost|hosting|build)/`
   ——**`runtime/` 刻意不在內**（規則註解 `:58-59` 明言：substrate/hosting/brain 的 adapter 住在 `runtime/`，
   故整個 `runtime/` 子樹被排除在「core」之外）。
2. `pathNot: "(^|/)src/[^/]+/adapters/"`（`:61`）只匹配 **`src/<單一段>/adapters/`**（exactly one segment）。
   故 `src/cost/adapters/spendguard/`、`src/hosting/adapters/nemoclaw/`、`src/policy/adapters/agt/` 三者被
   carve-out 命中；**但 `src/runtime/brain/adapters/hermes/` 是兩段（`runtime/brain`），不被此 `pathNot` 命中**
   ——所幸 brain 那一支本就因 (1) 整個落在規則 `from` 之外，仍不會被誤判。

**對 R11 的後果（誠實揭露）：** S1/S3/S4（cost/hosting/policy，皆住在規則涵蓋的 core module、且為單段 adapter）
可直接用「對自己的 core module 檔案植入 vendor import → `deps:check` exit≠0」當回歸護欄。**S2（Hermes brain，
住在規則不涵蓋的 `runtime/`）不能用此手法守自己的 core 檔案**——往 `runtime/brain/port.ts` 植入 `hermes` import
**不會**讓 `deps:check` 跳非零（該路徑不在規則 `from`）。S2 的回歸護欄改為**對一個規則涵蓋、且實際 consume brain
的 core 檔案**（`src/orchestration/pipeline.ts`，已驗證 consume brain port，見 `orchestration/pipeline.e2e.test.ts:19`）
植入 `hermes` import → `deps:check` exit≠0；以此**命令可驗**地證明 governance-core 命名 vendor 會被攔。R11 的
每個 adapter 仍只新增**自己 vendor 名目錄**下的檔案、**不在任何 core 檔案新增 vendor import**，故規則持綠。

---

## 2. 四個 adapter — grounded 在真實 clone（verified-from-code vs inferred）

### 2.1 NemoClaw hosting adapter（over P2-H `AgentHosting` port）— R11-S1

- **重用：** `src/hosting/port.ts`（`AgentHosting` interface、`HostSpec`、`AgentLifecycleEvent`、
  `contextOrError`/`denyEvent` helper）+ `src/test-contracts/agent-hosting-adapter.test.ts` 的 factory
  contract（adapter 作為第 3 個 impl 餵進同一參數化 suite）。
- **真實對映（verified-from-code）：** NemoClaw 以 **`nohup` 啟動 + 可選 `gosu <user>` 降權**長駐 gateway
  進程——`gatewayLaunchCommand`（`/tmp/nemoclaw/src/lib/agent/runtime.ts:141-148`，`nohup ... &` 在 :143、
  `gosu` 降權在 :147）。health probe 是對 `/health` 的 `curl -w '%{http_code}'`，把 `200|401` 視為
  ALREADY_RUNNING——recovery script 內出現兩次此 probe（`runtime.ts:203` 用 literal `http://127.0.0.1:<port>/health`、
  `runtime.ts:272` 用 `shellQuote(probeUrl)`；皆 `200|401) echo ALREADY_RUNNING`，verified）。recovery script 由
  `buildRecoveryScript`（`runtime.ts:220-284`）組裝：含 stale-process `pkill -TERM/-KILL`、guard 檢查、
  launch、`kill -0 "$GPID"` 存活確認。per-sandbox agent 解析（多 sandbox 共存）在 `getSessionAgent`
  （`runtime.ts:27-45`），讀 per-sandbox registry。
- **對映到 port 的語義：** `hostAgent` → 「組裝並（經注入 transport）下發 launch command」並回
  `agentProcessId`（對映 NemoClaw 的 `GATEWAY_PID`——該值由 launch/recovery 腳本以 `echo "GATEWAY_PID=$GPID"`
  在存活確認後輸出，`runtime.ts:211`/`:279`，adapter 從 CommandSink 的 stdout 解析）；`getAgentStatus` → health-probe → `running`
  （200|401）/ `stopped` / `unknown`；`reconcileAgentProcess("health-probe")` → 探活、`("restart")` →
  recovery script。**adapter 加上 P2-H port 已要求、但 NemoClaw 明確不做的 tenant scoping**（NemoClaw
  是 single-operator、`runtime.ts:27-45` 的 registry 無 tenant 維度——見 port.ts:7-10 的設計註解）。
- **credential-blind（verified）：** launch command 只含 `HERMES_HOME=/sandbox/.hermes` 之類**非密路徑
  env**（`hermesGatewayEnvPrefix`，`runtime.ts:150-152`），**不含 API key**；HostSpec 本就無 credential 欄位。
  adapter 對「組裝出的 command 字串含 secret-shape」做結構斷言（contract 已有 credential-blind 斷言）。
- **inferred（明標）：** NemoClaw 無單一 `ConnectSupervisor` class（grep 無結果）；其「生命週期監管」是
  recovery script + onboard machine（`/tmp/nemoclaw/src/lib/onboard/machine/runtime.ts`）的組合行為。adapter
  只取**啟動/探活/重啟三個動作的 command 形狀**，不複製其 onboard 狀態機（留給 R1 整合）。
- **capability gate：** 真實下發 command 到 sandbox 需 OpenShell `ExecSandbox`（R1）。R11-S1 用**注入式
  CommandSink**（in-process fake 記錄下發的 command 字串），contract test 斷言 command 形狀 + tenant scoping +
  credential-blind；live exec 留 R1 後整合 slice。

### 2.2 Hermes brain shim（over P2-D `BrainAdapter` port，credential-blind）— R11-S2

- **重用：** `src/runtime/brain/port.ts`（`BrainAdapter`、`BrainEvent` discriminated union：PlanStep /
  ToolCall / MemoryMutation / SkillMutation）+ `credential-guard.ts`（`governBrainStream` 注入式 detector）
  + `src/test-contracts/brain-adapter.test.ts`（factory contract）。
- **真實對映（verified-from-code）：** Hermes 是一個 conversation-loop agent（`/tmp/hermes-agent-probe/run_agent.py`），
  其 LLM 回合產出 **assistant message + `tool_calls`**（`run_agent.py:1635-1647` 蒐集 `msg.tool_calls`：
  `{"name": tc.function.name, "arguments": tc.function.arguments}`，verified；`:1368` 為另一處讀
  `assistant_message.tool_calls` 的存在性檢查，非蒐集點），這正對映我們的 `ToolCall` event。Hermes 自管
  `api_key`（`run_agent.py:346` 簽章預設、`:421` 傳遞、`:669`/`:682`/`:1031` 讀取，
  傳遞於 `:421`、讀於 `:669/:682/:1031`）——這是我們**明確拒絕**的 client-held credential 反模式
  （見 five-piece-integration §「三個重疊消解 / CREDENTIAL」）。
- **對映到 port 的語義：** shim 把 Hermes 的 `tool_calls` → `ToolCall`（`tool`=name、`args`=arguments，
  **arg 內的 credential 必須是 bundleRef、非 literal**）；assistant 的 plan 敘述 → `PlanStep`；Hermes 對自身
  `~/.hermes` memory/skill 的寫入意圖 → `MemoryMutation`/`SkillMutation`（**改為 emit event、由 governed
  pipeline 先 Append-to-WORM 才生效**，反轉 Hermes 的 fire-and-forget 自我改進，見 five-piece §風險最後一條）。
- **credential-blind shim（核心安全價值）：** shim **strip 掉 Hermes 的 `api_key` 通道**——adapter 不接受、
  不轉發 `api_key`；它只把 Hermes 的「想呼叫什麼工具」對映成 credential-blind 的 `ToolCall`，真實 key 由
  OpenShell SecretResolver 在 egress 注入。任何 Hermes 經 arg 夾帶 literal secret → 經既有
  `screenBrainEvent`（`credential-guard.ts:32-40`）**fail-closed deny 並停流**（`governBrainStream`，:48-57）。
- **fail-closed（verified port 不變量）：** 壞 `AgentContext` → `execute` yield 空（port.ts:67-74 註解要求）；
  每個 emit event 必帶 valid AgentContext。
- **capability gate：** 真實驅動 Hermes LLM 回合需其 Python runtime（R9 Developer SDK 的 credential-blind
  Python shim）+ live model egress。R11-S2 用**注入式 HermesTurnSource**（in-process fake 餵入「Hermes 風格的
  turn 物件」），shim 把它對映成 `BrainEvent` 流；live Hermes 進程留後續整合。

### 2.3 SpendGuard cost adapter（over P2-G `CostGate` port）— R11-S3

- **重用：** `src/cost/port.ts`（`CostGate`、`ReserveRequest`/`CommitSettle`、`ReserveResult`/`CommitResult`、
  `isValidTokenCount`、`denyReserve`/`denyCommit` helper）+ `src/test-contracts/cost-gate-adapter.test.ts`。
- **真實對映（verified-from-code）：** SpendGuard 的 ledger 是 **reserve → commit-delta → release/expire** 的
  session reservation 模型（`/tmp/agentic-spendguard/services/ledger/src/session_reservations.rs`）：
  `ReserveSessionLedgerRequest`（:32-49，含 `tenant_id`、`estimated_amount_atomic`、`ttl_seconds`、
  `idempotency_key`）→ `reserve_session`（:97-112，校驗 positive amount + ttl>0 + 非空 idempotency_key）；
  `CommitSessionDeltaLedgerRequest`（:51-77，`amount_atomic_delta` + `outcome`）→ `commit_session_delta`
  （:114-127）。egress 決策在 `build_request_decision`（`services/envoy_extproc/src/decision.rs:148`），
  缺 ClaimEstimate → **fail-closed**（`BuildError::MissingClaimEstimate` 宣告於 decision.rs:64、docstring
  `:55-63` 明言「NOT silently inject a fake estimate」、`build_request_decision` 在 :155/:159 `.ok_or(...)?`、
  test `missing_estimate_fails_closed` :386-408、assert 在 :409，verified）。
- **對映到 port 的語義：** `reserve(ctx,{estimatedTokens,resource})` → SpendGuard `reserve_session`
  （tokens → `estimated_amount_atomic`、`resource` → `route`、回的 reservation id → 我們的 `reservationId`）；
  `commit(ctx,reservationId,{actualTokens})` → `commit_session_delta`（actualTokens → `amount_atomic_delta`）。
- **hard-cap / over-budget（對映 P2-G 不變量）：** over-budget reserve → DENIED（hard-cap），
  in-flight overrun commit → `committed{overrun:true}` 且後續 reserve 全 deny（P2-G port.ts:30-36 已固化此語義）。
- **credential-blind（verified）：** SpendGuard 坐在 egress 只見 redacted header（five-piece §元件圖），
  reserve/commit 只收 token count + resource id、**無 credential**（port.ts:5-11 已固化、contract 已斷言）。
- **inferred / 明標的不對齊（不靜默略過）：** SpendGuard 的 estimation predictor-down 時**fail-OPEN**
  （five-piece §風險），與我們 fail-closed 律衝突——adapter 在 transport seam **強制 fail-closed**：
  estimate 缺失 / transport error → `denyReserve`（deny-by-default），不沿用 SpendGuard 的 fail-open config。
  又：SpendGuard 的 `release_session`（session_reservations.rs:129）對映我們 R12 的 `release(reservationId)`
  follow-up，**不在 R11 範圍**（R11-S3 §3 Out-of-scope 明寫）。
- **capability gate：** 真實 ledger 是 Postgres stored-proc over gRPC（session_reservations.rs:3 註解）。
  R11-S3 用**注入式 LedgerTransport**（in-process fake，可被腳本化回 ok/over-budget/error），contract test
  斷言 reserve/commit 語義 + hard-cap + 壞 ctx fail-closed；live ledger 留後續整合。

### 2.4 AGT policy secondary adapter（over P2-E `SecondaryPolicyAdapter`）— R11-S4

- **重用：** `src/policy/dedup.ts`（`SecondaryPolicyAdapter` interface、`combineDecisions` any-deny-wins、
  `evaluateSecondaries` fail-closed wrap、`AllowAll/DenyAll` 第二實作 double）+ `src/policy/types.ts`
  （`PolicyRequest`/`PolicyDecision`）+ `src/policy/dedup.test.ts`。
- **真實對映（verified-from-code）：** AGT 的 `GovernedCallable.__call__`
  （`/tmp/agent-governance-toolkit/agent-governance-python/agent-mesh/src/agentmesh/governance/govern.py:239-301`）
  evaluate → `decision`（:255），其 `PolicyDecision`（`.../governance/policy.py:435-455`）帶
  `allowed: bool`（:451）、`action: Literal["allow","deny","warn","require_approval","log"]`（:452）、
  `matched_rule`（:455）、`reason`（:443）。default action = `deny`（policy.py:238，default-deny ✓）。
  conflict strategy 預設 `deny_overrides`（govern.py:122）。
- **對映到 port 的語義（demotion to advisory）：** AGT adapter implement `SecondaryPolicyAdapter.evaluate(req)`：
  把我們的 `PolicyRequest` 對映成 AGT 的 evaluation context（action/resource/actor），呼叫 AGT engine.evaluate
  （經注入 seam），把 AGT 的 `PolicyDecision.allowed/action` 對映回我們的 `PolicyDecision`
  （`allowed==true && action=="allow"` → `effect:"allow"`；**其餘一律 `effect:"deny"`**，含 `warn`/`log`/
  `require_approval`/malformed → fail-closed）。`matched_rule`/`reason` 帶進我們的 reason 供 audit。
- **PDP 唯一 deny 權威（對映 P2-E 不變量）：** adapter 永遠是 **advisory input**——`combineDecisions`
  （dedup.ts:51-82）保證 AGT-allow **絕不**翻轉 PDP-deny，AGT-deny 只會「deny 更多」。adapter throw →
  `evaluateSecondaries`（dedup.ts:25-41）合成 deny（deny-by-default）。**dedup.test.ts 已證 AGT-allow 輸給
  PDP-deny；R11-S4 把真實 AGT adapter 餵進同一斷言。**
- **inferred（明標）：** AGT 的 `require_approval`（govern.py:259、policy.py:452）在 AGT 是 routed-to-coordinator
  的非終態；在我們的 advisory 語境**沒有 approval 通道**（approval 是 PDP/maker-checker 的事，P4），故 adapter
  把 `require_approval` 保守對映成 `deny`（fail-closed；不誤當 allow）。AGT 的 advisory/shadow 層
  （govern.py:283-296、`_shadow_impl.py`）**不對映**——那是 AGT 內部 advisory，與我們把整個 AGT 降為 advisory
  的層級不同，混用會雙重語義（R11-S4 §3 Out-of-scope 明寫）。
- **capability gate：** 真實 AGT engine 是 Python（agent-governance-python）。R11-S4 用**注入式
  AgtEvaluateFn**（in-process fake，可回 allow/deny/warn/require_approval/throw），adapter 對映 + fail-closed
  收斂；live Python engine 經 R9 SDK seam 留後續整合。

---

## 3. 重用 vs 新增（清單）

| 項目 | 重用既有（不改） | 新增（本 ITEM） |
|---|---|---|
| Brain | `runtime/brain/{port,credential-guard,fakes,index}.ts`、brain contract | `runtime/brain/adapters/hermes/`（1 module）+ 注入式 turn source seam |
| Hosting | `hosting/{port,null,in-memory,index}.ts`、hosting contract | `hosting/adapters/nemoclaw/`（1 module）+ 注入式 command sink seam |
| Cost | `cost/{port,null,in-memory,index}.ts`、cost contract | `cost/adapters/spendguard/`（1 module）+ 注入式 ledger transport seam |
| Policy | `policy/{types,dedup}.ts`、`dedup.test.ts` | `policy/adapters/agt/`（1 module）+ 注入式 AGT evaluate seam |
| Kernel / 三大壟斷 | Go WORM kernel、PDP、SecretResolver（全不動） | 無 |
| `no-vendor-in-core` gate | P2-B `.dependency-cruiser.cjs` 規則 | 無（adapter 落 `adapters/` 已被 pathNot 排除；每 slice 加回歸護欄） |

---

## 4. Trade-offs / 設計決策

1. **注入式 transport seam（adapter ↔ 真實 vendor 之間）vs 直接 wire vendor SDK：** 選 seam。理由：（a）R1 未
   完成、live transport 不存在；（b）seam 讓 adapter 可被 contract test 在純 in-process 過測（無網路、無 Postgres、
   無 Python runtime）；（c）core 仍**零 vendor SDK import**，`no-vendor-in-core` 持綠。代價：R11 不證 live
   wire（誠實揭露為 capability gate），留 R1 後整合 slice。
2. **每 vendor 一條獨立小 slice vs 一條大 adapter slice：** 選獨立。4 個 adapter 無互相依賴（ITEM DAG
   `R11 -> {P2-D,G,H,E; R1}` 是對 port 的依賴、非彼此），拆開後每條都遠在 size budget 內、可獨立 review/revert。
3. **adapter 把 vendor 的 fail-OPEN 改寫成 fail-CLOSED（SpendGuard / AGT require_approval）：** 選 fail-closed。
   AGENTS.md deny-by-default 律勝過「忠實複製 vendor 行為」；不一致處在 §2 逐條明標，避免靜默偏離。
4. **NemoClaw 加 tenant scoping（vendor 本身沒有）：** P2-H port 已把 tenant 隔離設為 port 級不變量；adapter
   作為 port 的 impl 必須遵守，故在 adapter 層補上 NemoClaw 缺的 tenant 維度（這正是 Enterprise 差異化）。

---

## 5. Slice 分解與 DAG（無 cycle）

| Slice | 檔案數（估） | Net LOC（估） | Depends-on |
|---|---|---|---|
| **R11-S1** NemoClaw hosting adapter | ~4（adapter.ts + types + index + test） | ~220 | P2-H |
| **R11-S2** Hermes brain shim | ~4 | ~200 | P2-D |
| **R11-S3** SpendGuard cost adapter | ~4 | ~210 | P2-G |
| **R11-S4** AGT policy secondary adapter | ~3 | ~160 | P2-E |

```
R11-S1 -> { P2-H }      # 各自只依賴自己的 port slice（皆 DONE）
R11-S2 -> { P2-D }
R11-S3 -> { P2-G }
R11-S4 -> { P2-E }
```
> 無 cycle 證明：4 條 slice 互不依賴，各自指向一個 rank-0 的 DONE port slice；rank 嚴格遞減 ⇒ DAG。
> live wire（真實 exec / ledger / Hermes 進程 / AGT engine）統一 depends-on **R1**，屬 R11 之後的整合 slice，
> **不在這 4 條 DRAFT slice 範圍**（每條 §3 Out-of-scope 明寫，§8 Blocks 指向 R1 後整合）。

---

## 6. Grounded citations（real file:line）

- NemoClaw hosting：`/tmp/nemoclaw/src/lib/agent/runtime.ts:143`（nohup launch）、`:147`（gosu 降權）、
  `:203` / `:272`（health-probe 200|401）、`:220-284`（recovery script 組裝）、`:211` / `:279`
  （`echo "GATEWAY_PID=$GPID"` 存活後輸出 → 對映 `agentProcessId`）、`:27-45`（per-sandbox agent 解析）、
  `:150-152`（HERMES_HOME 非密 env，credential-blind）。`gatewayLaunchCommand` 自身在 `:141-148`（helper，被
  `buildRecoveryScript` 在 `:220-284` 內呼叫；NemoClaw 無獨立 `hostAgent` 入口，launch 與 recovery 共用此腳本路徑）。
- Hermes brain：`/tmp/hermes-agent-probe/run_agent.py:1635-1647`（tool_calls 蒐集，`tc.function.name`/`arguments`，
  verified）、`:1368`（另一處 `assistant_message.tool_calls` 存在性檢查，非蒐集點）、`:346`/`:421`/`:669`/`:682`/`:1031`
  （client-held api_key 反模式，被 shim strip）。
- SpendGuard cost：`/tmp/agentic-spendguard/services/ledger/src/session_reservations.rs:32-49`
  （ReserveSessionLedgerRequest）、`:97-112`（reserve_session 校驗）、`:51-77`/`:114-127`（commit-delta）、
  `:129`（release，→ R12）；`/tmp/agentic-spendguard/services/envoy_extproc/src/decision.rs:148`
  （build_request_decision）、`:59-63`/`:386-408`（缺 estimate fail-closed）。
- AGT policy：`/tmp/agent-governance-toolkit/agent-governance-python/agent-mesh/src/agentmesh/governance/govern.py:239-301`
  （GovernedCallable.__call__）、`:255`（engine.evaluate）、`:122`（deny_overrides）、`:259`（require_approval）；
  `.../governance/policy.py:435-455`（PolicyDecision: allowed/action/matched_rule/reason）、`:238`（default-deny）。
