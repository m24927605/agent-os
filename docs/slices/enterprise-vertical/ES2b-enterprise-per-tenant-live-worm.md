# SLICE-ES2b: Enterprise per-tenant live WORM partition（TS appender + 注入 + gated live e2e）

- **Phase**: P3（Enterprise 垂直;ES2 的消費者刀,把 Enterprise fleet 接到真實 kernel per-tenant partition）
- **Branch**: slice/es2b-enterprise-per-tenant-live-worm
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；TS（appender + 注入 + gated e2e）；新增依賴 = 0
- **狀態**: **DRAFT**

## (0) 動機 + 現況（grounded）
ES2a 交付了 proto `partition_id` + kernel server 依 partition 路由到 `PartitionedIngest`。ES2b 把 **Enterprise fleet 的 per-tenant WORM 從 in-memory(ES1 的 `Map<partitionId, InMemoryAppendOnlyLog>`)升到真實 kernel per-tenant partition**——完全照 Personal S2 的 `opts.wormSink` 注入樣板(`src/personal/bootstrap.ts:88,186`:injectable,default in-memory,live=真 grpc-js ingest appender;`bootstrap.live-kernel.e2e.test.ts`)。TS 端 `createRpcAppendTransport`(src/runtime/ingest/transport.ts:52)目前送 `{sourceId, sequence, canonicalEvent}`,需加 `partitionId`。

## (1) ID + Title
SLICE-ES2b — (a) TS ingest transport 送 `partition_id`(`AppendRequest` shape + `createRpcAppendTransport` 加 partitionId);(b) per-tenant live wormSink 工廠(給 binding → 回一個 append 到 kernel 且 `partition_id=binding.partitionId`、per-tenant sourceId 的 sink);(c) `EnterpriseFleetOpts` 加 `wormSinkFor?(binding): (event)=>Promise<AppendReceipt>`(injectable;**default = ES1 in-memory,缺省時 byte-identical**);(d) **gated live e2e**:對真實 kernel(啟 ≥2 partition)證明 tenant-A 的 governed/operator action append 進**自己的**真實 partition、tenant-B partition 獨立、**跨租戶 kernel 層隔離**(A 的事件絕不入 B 的鏈)。

## (2) Goal（一句話）
Enterprise fleet 的每租戶治理事件落進**真實 Go kernel 的每租戶獨立 WORM 鏈**(獨立 head + 獨立 Ed25519 key),且跨租戶隔離在 **kernel 層**(非僅 in-memory)被 live 證明——Enterprise 版的 Personal S2。

## (3) In-scope / Out-of-scope
- In-scope:
  - **TS transport**:`AppendRequestShape` + `createRpcAppendTransport`(transport.ts)加 `partitionId`,RPC req 帶 `partitionId`(對齊 ES2a proto 欄位 4)。向後相容:Personal 的單租戶 append 可省略(空 partition_id),不破壞 Personal live(P2R-PV-S2)。
  - **per-tenant live wormSink 工廠**:`createPartitionedIngestSink(transport, binding)` → `(event: AuditEvent)=>Promise<AppendReceipt>`,設 `partitionId=binding.partitionId`、`sourceId` per-tenant(canonical event 為已 redact 的 S0.2 bytes,kernel 不持原始 secret)。
  - **Enterprise 注入**:`EnterpriseFleetOpts.wormSinkFor?(binding)`;ES1 的 per-tenant WORM 改為「`opts.wormSinkFor?.(binding) ?? 該租戶的 in-memory log sink`」。**缺省時 ES1 行為 byte-identical**(既有 ES1/ES3 e2e 全綠不變)。
  - **gated live e2e**(`AGENTOS_LIVE_KERNEL`,鏡像 Personal live-kernel e2e + harness):啟 kernel(≥2 partition:tenant-a/tenant-b,各自 Store+Signer)→ 建 fleet 注入 partitioned live sink → tenant-A submit/approve(或 operatorAction)→ receipt 來自 A 的鏈 → tenant-B 的 partition 獨立(checkpoint/sequence 不受 A 影響)→ **跨租戶:A 的 canonical event 絕不出現在 B 的鏈**。gated 時 skip。
  - `pnpm run verify` exit 0(含 `verify:cross-tenant` 綠;live e2e gated skip);新增 `e2e:live-enterprise`(或併入既有 live harness)。
- Out-of-scope:
  - per-tenant Ed25519 key 真實 provision/KMS(ES2a 已標 attester==operator 上限,root-trust externalization = P4)。
  - per-tenant 讀回投影對齊 live(若 console.timeline 要從 kernel 讀回 = ListEntries per-partition,可後續;ES2b 聚焦 write 面 + kernel 隔離,沿用 Personal S3a UNSIGNED-readback 已知缺口)。
  - 動態 onboarding(ES4)。

## (4) Design delta + 依賴方向
- 純加 TS sink + opts 欄位;ES1/ES3 缺省路徑不變。transport 加 partitionId(向後相容)。依賴經 barrel(runtime/ingest)。
- **PUBLIC**:`EnterpriseFleetOpts.wormSinkFor`;`createPartitionedIngestSink`;transport 的 partitionId。

## (5) Test-first plan（RED 先行）
- 單元(in-memory,非 gated):`wormSinkFor` 注入時,per-tenant 事件走注入 sink(spy 證 partitionId=binding.partitionId、per-tenant sourceId);缺省時 byte-identical ES1(既有 e2e 綠)。
- transport 單元:partitionId 進 RPC req(對齊 ES2a 欄位)。
- **gated live e2e**(我跑):tenant-A append → 真實 A 鏈 receipt;tenant-B partition 獨立;A 事件不入 B 鏈;cross-tenant kernel 層證明。RED = sink/opts/transport 未改前型別/import 錯。

## (6) Definition of Done（待實測填）
- [ ] RED:`wormSinkFor`/`createPartitionedIngestSink`/transport partitionId 在實作前紅。
- [ ] `pnpm run verify` exit 0(含 verify:cross-tenant 綠;ES1/ES3 既有 e2e **byte-identical** 不變;live e2e gated skip)。
- [ ] **注入非 vacuous**:spy 證注入 sink 收到 `partitionId=binding.partitionId` + per-tenant sourceId;mutation(sink 用固定/別租 partitionId)→ test 紅。
- [ ] **live(我對真實 kernel 跑)**:tenant-A action → A 鏈 receipt;tenant-B partition 獨立;**A 的 canonical event 絕不入 B 的鏈**(kernel 層跨租戶隔離);mutation(兩租戶共用 partition_id)→ 隔離 live 斷言紅。
- [ ] 缺省 byte-identical(無 wormSinkFor → ES1 in-memory);credential-blind(canonical 已 redact,kernel 不持 secret;sourceId/partitionId 非 secret)。
- [ ] **誠實標記**:per-tenant key = ES2a 記憶體生(attester==operator,P4 KMS);console 讀回對齊 live = 後續。
- [ ] Adversarial review = PASS(獨立 Opus 4.8)。

## (7) Rollback
- `git revert <merge-sha>`(TS sink + opts + transport partitionId + e2e)。缺省路徑可逆,Personal/ES1 不受影響。

## (8) Depends-on / blocks
- Depends-on:**ES2a**(proto partition_id + kernel 路由)、ES1(Enterprise fleet + per-tenant WORM seam)、Personal S2 wormSink 樣板、`createRpcAppendTransport`。
- Blocks:無(Enterprise live WORM 完成;ES4 onboarding 後續)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:ES2b 證 Enterprise 寫面接真實 kernel per-tenant partition + kernel 層跨租戶隔離;per-tenant key root-trust、live 讀回投影 = P4/後續。
