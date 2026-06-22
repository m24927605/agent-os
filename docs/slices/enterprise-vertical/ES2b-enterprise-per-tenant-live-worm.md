# SLICE-ES2b: Enterprise per-tenant live WORM partition（TS appender + 注入 + gated live e2e）

- **Phase**: P3（Enterprise 垂直;ES2 的消費者刀,把 Enterprise fleet 接到真實 kernel per-tenant partition）
- **Branch**: slice/es2b-enterprise-per-tenant-live-worm
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；TS（appender + 注入 + gated e2e）；新增依賴 = 0
- **狀態**: **DONE**（merged + LIVE 1/1;writer=Backend Architect/Opus4.8 + 2 live-fix=main-loop/Opus4.8;獨立 Opus4.8 reviewer = PASS;Enterprise 寫面接真實 kernel per-tenant partition + kernel 層跨租戶隔離 live 驗證）

## (0) 動機 + 現況（grounded）
ES2a 交付了 proto `partition_id` + kernel server 依 partition 路由到 `PartitionedIngest`。ES2b 把 **Enterprise fleet 的 per-tenant WORM 從 in-memory(ES1 的 `Map<partitionId, InMemoryAppendOnlyLog>`)升到真實 kernel per-tenant partition**——完全照 Personal S2 的 `opts.wormSink` 注入樣板(`src/personal/bootstrap.ts:88,186`:injectable,default in-memory,live=真 grpc-js ingest appender;`bootstrap.live-kernel.e2e.test.ts`)。TS 端 `createRpcAppendTransport`(src/runtime/ingest/transport.ts:52)目前送 `{sourceId, sequence, canonicalEvent}`,需加 `partitionId`。

## (1) ID + Title
SLICE-ES2b — (a) TS ingest transport 送 `partition_id`(`AppendRequest` shape + `createRpcAppendTransport` 加 partitionId);(b) per-tenant live wormSink 工廠(給 binding → 回一個 append 到 kernel 且 `partition_id=binding.partitionId`、per-tenant sourceId 的 sink);(c) `EnterpriseFleetOpts` 加 `wormSinkFor?(binding): (event)=>Promise<AppendReceipt>`(injectable;**default = ES1 in-memory,缺省時 byte-identical**);(d) **gated live e2e**:對真實 kernel(啟 ≥2 partition)證明 tenant-A 的 governed/operator action append 進**自己的**真實 partition、tenant-B partition 獨立、**跨租戶 kernel 層隔離**(A 的事件絕不入 B 的鏈)。

## (2) Goal（一句話）
Enterprise fleet 的每租戶治理事件落進**真實 Go kernel 的每租戶獨立 WORM 鏈**(獨立 head + 獨立 Ed25519 key),且跨租戶隔離在 **kernel 層**(非僅 in-memory)被 live 證明——Enterprise 版的 Personal S2。

## (3) In-scope / Out-of-scope
- In-scope:
  - **⚠️ 第一任務(ES2a reviewer 揭露的硬前置)**:`src/runtime/ingest/grpc-client.ts` 的 `encodeAppendRequest` **加 field-4(partitionId)encode 分支**(`if (partitionId.length > 0) <wire-encode field 4>`)。ES2a 只送空值故無此分支也 wire-correct,但 ES2b 一旦送非空 partitionId,**沒這分支會被靜默丟棄 → kernel 收到空 → fail-closed denied**。先加 + 單元證明 wire bytes 含 field 4。
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

## (6) Definition of Done（實測）
- [x] RED:encode field-4 wire test + `wormSinkFor` 注入 test 在實作前紅。
- [x] `pnpm run verify` **exit 0**(866 passed + 11 skipped;verify:go ok;proto:check go+ts ok〔ES2b 未改 proto〕;verify:cross-tenant 綠;depcruise 129 modules clean;ES1〔4〕/ES3〔5〕既有 e2e **byte-identical 不變**;live e2e gated skip)。
- [x] **field-4 encode 非 vacuous**:wire test 獨立解碼證非空 partitionId 出 tag 0x22、空則省略(Personal wire-identical;fields 1/2/3 不動);reviewer mutation 刪分支 → 非空 test 紅、空 test 仍綠。
- [x] **注入非 vacuous**:spy 證注入 sink 收 `partitionId=binding.partitionId` + per-tenant sourceId(2 租戶不交叉);reviewer mutation 固定 partitionId → 注入 test 紅。
- [x] **LIVE(我對真實 partitioned kernel 跑)`pnpm run e2e:live-enterprise` 1/1**:tenant-A submit→approve executed,receipt 來自 A 的**真實** partition 鏈(seq 0);tenant-B partition 獨立(亦 seq 0,共用鏈會前進);**A 的 marker 在 `partition-tenant-a.wal` 但不在 `partition-tenant-b.wal`**(kernel 層跨租戶隔離);canary 不在任一 WAL。
- [x] 缺省 byte-identical(無 wormSinkFor → 每 binding 獨立 in-memory log,console.timeline 讀 repo 不變);credential-blind(canonical 已 redact;sourceId `enterprise:<tenantId>`/partitionId 非 secret)。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8;field-4 + wormSinkFor 兩 mutation 翻紅;兩 live-fix sound;8 攻擊面 HELD/N/A)。
> **2 個 live 抓到的 bug(unit/fake 沒抓到,live 整合才現形)**:① kernel `main.go` 未 `os.MkdirAll(partitionDir)` → partitioned kernel 啟動崩(修:MkdirAll,scoped 在 partitioned 分支);② partition-ID 不匹配(`binding.partitionId`=`partition-${tenantId}` vs harness `tenant-a`)→ kernel **正確 fail-closed denied**(修:harness/e2e 對齊 `partition-tenant-a/-b`,非 bug-mask)。
> **誠實前提**:per-tenant key = ES2a 記憶體生(**attester==operator,P4 KMS**);per-partition live 讀回(無 ListEntries-per-partition,e2e 直讀 WAL)= 後續。

## (7) Rollback
- `git revert <merge-sha>`(TS sink + opts + transport partitionId + e2e)。缺省路徑可逆,Personal/ES1 不受影響。

## (8) Depends-on / blocks
- Depends-on:**ES2a**(proto partition_id + kernel 路由)、ES1(Enterprise fleet + per-tenant WORM seam)、Personal S2 wormSink 樣板、`createRpcAppendTransport`。
- Blocks:無(Enterprise live WORM 完成;ES4 onboarding 後續)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:ES2b 證 Enterprise 寫面接真實 kernel per-tenant partition + kernel 層跨租戶隔離;per-tenant key root-trust、live 讀回投影 = P4/後續。
