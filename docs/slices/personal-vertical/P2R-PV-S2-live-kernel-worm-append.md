# SLICE-P2R-PV-S2: Personal vertical → live kernel WORM append（治理事件落進真實 attester）

- **Phase**: P2（Personal 垂直切片;把 S1 的記憶體 appender 換成對真實 Go kernel 的 live ingest)
- **Branch**: slice/p2r-pv-s2-live-kernel-worm-append
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day（不含 kernel build）；net LOC <~150（`bootstrap.ts` 加 wormSink 注入點 + `bootstrap.live-kernel.e2e.test.ts` + harness 接線 + 單元測試）、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-PV-S2 — 讓 `createPersonalShell` 的 WORM 寫入點**可注入**:把 S1 的「合成 AuditEvent → 寫共享 InMemoryAppendOnlyLog」中的**寫入 sink** 抽成 `opts.wormSink`(預設仍寫記憶體 log),並提供一條 **live sink** = `createIngestAppender({transport: createRpcAppendTransport({endpoint}), sourceId:'personal'})`(R2-S6/S8 已證明可對真 kernel append)。一條 **gated live e2e** 證明:核可後,Personal 的治理事件**確實 append 進真實 Go kernel 的 WORM WAL**,且注入的 secret canary **不在 WAL**(redact-before-send 跨真實線格成立)。

## (2) Goal（一句話）
把 S1 的可跑垂直接到**真實 attester**:commit-before-effect 的 appender 對跑著的 Go kernel append,讓 Personal 的每個治理動作落進真正的 WORM(不只是記憶體),並驗證憑證不外洩。

## (3) In-scope / Out-of-scope
- In-scope:
  - `bootstrap.ts`:`PersonalShellOpts` 加 `wormSink?: (event: AuditEvent) => Promise<AppendReceipt>`。**AuditEvent 的合成邏輯(structural event → createAuditEvent)留在 root 單一處不變**;只把最後的寫入從 `sharedLog.append(ae)` 改為 `await (opts.wormSink ?? defaultInMemorySink)(ae)`。預設 = 寫共享 InMemoryAppendOnlyLog(S1 行為、timeline 仍可讀)。
  - `bootstrap.live-kernel.e2e.test.ts`(**gated on `AGENTOS_LIVE_KERNEL_ENDPOINT`**,未設→`describe.skip`,保 verify hermetic):用 `createPersonalShell({ wormSink: (ae)=>ingestAppender.append(ae) })`(ingestAppender = createIngestAppender 對 endpoint)→ 走 receive→preview→submit→**approve**(注入含 canary 的 intent/target)→ 斷言:(a) DecideOutcome executed/denied 一致;(b) 讀 kernel chain WAL 檔(path 由 `AGENTOS_LIVE_KERNEL_CHAIN` 提供,沿用 live-kernel.e2e 模式)出現對應 hash-chain 條目;(c) WAL bytes **不含** canary 明文。
  - harness:擴充 `scripts/e2e-live-kernel.sh`(R2-S8 已會 build+spawn kernel + 設 env)使其 vitest 也跑 `src/personal/bootstrap.live-kernel.e2e.test.ts`(與 ingest live e2e 共用同一顆 spawn 的 kernel);或等價的 `e2e:live-personal` script。
  - 單元測試(無 kernel):`wormSink` 預設仍寫 in-memory(S1 的 6 e2e 不變、仍綠);注入一個記錄用 sink → 確認 root 真的用注入的 sink(且合成的 AuditEvent 正確)。
- Out-of-scope（明確不做）:
  - **live 讀回時間軸** → **P2R-PV-S3**(kernel 只有 AppendService、無 list/read RPC;本刀只證 append + WAL 斷言,不從 live kernel 重建 timeline)。
  - docker-compose 起整套 / 映像修正(部署)。
  - Task/AgentSession FSM 多步驟編排。

## (4) Design delta + 模組 + 介面 + 依賴方向
- **Design delta**:`bootstrap.ts` 抽出 `wormSink` 注入點(預設不變);新增 gated live e2e + harness 接線。**不改 R2 ingest/transport、不改 kernel。**
- **依賴方向**:bootstrap 仍只經 barrel;live e2e import `src/audit/ingest`(createIngestAppender)+ `src/runtime/ingest`(createRpcAppendTransport)barrel——這兩者本就把 grpc-js 封閉於 `src/runtime/ingest`,depcruise 不受影響(e2e 檔屬 *.test.ts 排除)。
- **PUBLIC interface**:`createPersonalShell({ wormSink? })`;預設行為與 S1 完全相容。

## (5) Test-first plan（RED 先行）
- 先寫 live e2e;`AGENTOS_LIVE_KERNEL_ENDPOINT=127.0.0.1:7799 vitest run …/bootstrap.live-kernel.e2e.test.ts` 對**未啟動** kernel → ingest append reject → approve denied / WAL 不存在 → 測試 FAIL(exit≠0)(RED:真打真 kernel)。
- 起真 kernel(harness)後 → 綠。
- 單元(無 kernel):注入 recording sink,reserve→approve→確認 sink 收到合成的 AuditEvent(且預設不注入時仍寫 in-memory、S1 e2e 綠)。

## (6) Definition of Done（待實測填）
- [ ] RED:endpoint 指向未起 kernel → live e2e FAIL(exit≠0)。
- [ ] `pnpm run e2e:live-kernel`(或 personal 變體)**exit 0**:真 kernel spawn → Personal approve → kernel WAL 出現 hash-chain 條目 → canary 不在 WAL → 清理。
- [ ] `pnpm run verify` 仍 **exit 0**(gated live e2e SKIP;S1 的 6 個 in-memory e2e 仍綠;wormSink 預設不變)。
- [ ] depcruise exit 0;secret-scan clean。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:wormSink 不被使用(仍寫 in-memory)→ live WAL 斷言紅;移除 redact → canary 出現在 WAL 紅)。

## (7) Rollback
- `git revert <merge-sha>`(移除 wormSink 注入點 + live e2e + harness 接線)。S1 in-memory 行為不受影響、可逆。

## (8) Depends-on / blocks
- Depends-on:P2R-PV-S1(composition root,DONE)、R2-S2/S6/S8(createIngestAppender + createRpcAppendTransport + live kernel harness,DONE)、P1 kernel(AppendService server)。
- Blocks:P2R-PV-S3(live 讀回時間軸)。
- 確認 slice DAG 無 cycle: ☑ 是
- **誠實前提**:live e2e 需 kernel 行程(harness build+spawn);verify 維持 hermetic(無 env 即 skip)。
