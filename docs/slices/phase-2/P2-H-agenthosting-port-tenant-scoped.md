# SLICE-P2-H: vendor-neutral AgentHosting port + tenant-scoped lifecycle（≥2 impls）

- **Phase**: P2（five-piece — AgentHosting 槽位；完成 5 個可插拔槽位的最後一個）
- **Branch**: slice/p2-h-agenthosting-port
- **Author**: <id>    **Adversarial reviewer**: <fresh-context、非作者>
- **Size budget**: <= 1 day；net LOC <~300、files <~6（`src/hosting/{port.ts,null.ts,in-memory.ts,index.ts}` + `src/test-contracts/agent-hosting-adapter.test.ts` + `src/index.ts` barrel）、新增依賴 = 0
- **狀態**: **DONE**（merge；fresh-context IV = PASS、零 correctness defect）

## (1) ID + Title
SLICE-P2-H — 新增 vendor-neutral **AgentHosting port**（把腦以長駐進程代管於 sandbox 內：`hostAgent`/`getAgentStatus`/`reconcileAgentProcess`）+ **≥2 impl**（`NullAgentHosting` 失敗封閉 deny-all；`InMemoryAgentHosting` 帶 **tenant-scoped** registry）+ contract harness。NemoClaw 為日後真實 adapter（落 `src/hosting/adapters/nemoclaw/`）。

## (2) Goal（一句話）
讓「agent 代管」成為**可驗的可插拔槽位**，並把 NemoClaw 明確不做、卻是 Enterprise 差異化的 **tenant 隔離**變成 PDP 級可驗不變量：**租戶 A 代管的 agent，租戶 B 不能 status/reconcile/重複代管**（cross-tenant → deny，fail-closed）；port **credential-blind**（spec 不收憑證——憑證走 OpenShell SecretResolver）。

## (3) In-scope / Out-of-scope
- In-scope：`AgentHosting` 介面（`hostAgent(ctx, spec)`→ ok+agentProcessId | denied；`getAgentStatus(ctx, sandboxId)`→ ok+phase | denied；`reconcileAgentProcess(ctx, sandboxId, action:"health-probe"|"restart")`→ ok | denied，**回 result 非 void**，以利稽核/deny）；可稽核 `AgentLifecycleEvent`；`NullAgentHosting`（deny-all）；`InMemoryAgentHosting`（registry：sandboxId → {tenantId, agentName, phase}；tenant-scoped 所有操作；unknown sandbox → deny）；contract test（factory over 2 impl + tenant 隔離 + credential-blind 結構斷言）。
- Out-of-scope：真實 NemoClaw adapter（nohup+gosu 啟動、recovery script、health-probe loop、ConnectSupervisor 生命週期 — 落 adapters/nemoclaw/）；真實 OpenShell sandbox 連線（待 live substrate adapter）；gateway-per-tenant 進程/namespace 隔離（後續 slice；本 slice 只在 hosting 層做 tenant-scoped 記憶體隔離）。

## (4) Design + 模組 + 介面 + 依賴方向
- **Design delta**：純 port + 2 impl + 共享 contract，模式同 P2-A/P2-D/P2-G。
- **PUBLIC interface（src/hosting/port.ts）**：
  - `HostSpec = { sandboxId:string; agentName:string; gatewayCommand?:string; inferenceProvider?:string }`（**無憑證欄位**）；
  - `HostResult = {status:"ok", agentProcessId:string, event} | {status:"denied", reason, event}`；
  - `StatusResult = {status:"ok", phase:"running"|"stopped"|"unknown", event} | {status:"denied", reason, event}`；
  - `ReconcileResult = {status:"ok", event} | {status:"denied", reason, event}`；
  - `interface AgentHosting { hostAgent(ctx, spec): Promise<HostResult>; getAgentStatus(ctx, sandboxId): Promise<StatusResult>; reconcileAgentProcess(ctx, sandboxId, action): Promise<ReconcileResult>; }`；
  - 共享 `deny()`（fail-closed on 壞 ctx）。
- **不變量**：壞 ctx → denied（fail-closed）；**tenant 隔離**：對 sandboxId 的任何操作，若該 sandbox 的 recorded tenantId ≠ ctx.tenantId → `cross-tenant` denied（不洩漏存在與否之外的資訊）；unknown sandbox（status/reconcile）→ denied；重複 host 同 sandboxId 給不同租戶 → cross-tenant denied；**spec 不含任何 credential 欄位**（credential-blind by construction）。
- **依賴方向**：`null.ts`/`in-memory.ts` → `port.ts`（同模組 hosting）；port → `iam/ids`（AgentContext，allowlisted）。barrel 經 `src/index.ts`。`hosting` 已在 no-vendor-in-core 的 core from-list；NemoClaw adapter 將落 `src/hosting/adapters/nemoclaw/`（pathNot 排除）。

## (5) Test-first plan（RED 先行）
`src/test-contracts/agent-hosting-adapter.test.ts`（hosting 模組不存在 → RED：import 失敗）：
- factory over [Null, InMemory]：每操作回 schema-valid event、`status===event.result`、壞 ctx → denied+contextError、永不 throw。
- Null 專屬：hostAgent 一律 denied（deny-all reason）。
- InMemory 專屬：(a) host → ok + agentProcessId；(b) **tenant 隔離**：tenant-A host 後，tenant-B 對同 sandboxId 的 getAgentStatus/reconcile/重複 host → `cross-tenant` denied；同租戶 → ok；(c) unknown sandbox 的 status/reconcile → denied；(d) reconcile health-probe/restart 同租戶 → ok。
- credential-blind 結構斷言：strip 註解後，`port.ts` code 不含 credential/secret/authorization 等欄位名。
> 預期首次 RED：import `../hosting/index.js` 失敗。

## (6) Definition of Done（實測）
- [x] **first RED**（hosting 模組不存在）：`vitest run agent-hosting-adapter.test.ts` → import 失敗、no tests（exit≠0）。
- [x] `pnpm run verify` **exit 0**（129 tests、deps 31 modules 0 violations、secret-scan clean）。
- [x] `deps:check` 綠（IV 確認 hosting/* 只 import `./port.js` + `iam/ids`、無 vendor；no-vendor-in-core 綠；helper 留模組內、未洩漏到 package barrel）。
- [x] secret-scan clean；credential-blind 結構斷言（strip 註解，IV 確認 HostSpec 無 secret 欄位）。
- [x] **Adversarial review = PASS**（fresh-context IV，零 correctness defect；tenant-B 無法 status/reconcile/restart/重複 host tenant-A 的 agent；unknown sandbox → deny；壞 ctx（{}/null/空/缺 tenantId）兩側 fail-closed 且不污染 victim；same-tenant 不被誤鎖；3 種 mutation 皆被抓）。

## (7) Rollback
revert commit（移除 hosting 模組 + barrel 一行）。

## (8) Depends-on / blocks
- Depends-on：既有 `iam/ids`（AgentContext）。
- Blocks：真實 NemoClaw hosting adapter；live OpenShell substrate 整合；gateway-per-tenant（把 tenant 隔離從 hosting 層推到連線/進程邊界）。

### Tracked follow-up（IV INFO，本 slice 範圍外、不靜默略過）
- **sandbox 存在性 oracle**：目前 cross-tenant deny 的 reason（`cross-tenant: …`）與 unknown-sandbox deny 的 reason（`unknown sandbox …`）不同，租戶 B 可藉此分辨「sandbox 存在但非我的」vs「不存在」，可枚舉他租 sandboxId 的存在性。本 slice §2 當初**明確允許**洩漏存在性，故為 spec-conformant、headline 隔離（B 碰不到 A 的 agent）仍成立。**未來 hardening slice**：對**呼叫端**統一回「unknown sandbox」（消除 oracle），真正的 cross-tenant 理由只寫進**audit event**（給 operator/WORM，不回給呼叫端）——分離「呼叫端學到什麼」與「稽核記錄什麼」。
