# SLICE-P2R-PV-S3b: TS ListEntries client + timeline live-read 注入 + live e2e

- **Phase**: P2（Personal 垂直 S3 的 TS 側;讀回真實 kernel WORM 重建 timeline）
- **Branch**: slice/p2r-pv-s3b-ts-readback-timeline
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day（不含 kernel build）；net LOC <~220（grpc-client ListEntries codec ~90 + reader+wiring ~70 + tests ~60;**若 >300 再拆 S3b-codec / S3b-wire**)、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-PV-S3b — 在 `grpc-client.ts` 手寫 `ListEntries` codec(encode request / decode repeated Entry),加一個 reader port 回 `Promise<readonly LogEntry[]>`(canonical_event JSON.parse→AuditEvent,包成 LogEntry),並在 `createPersonalShell` 加 `readEntries?` 注入點(比照 `wormSink`),使 `timeline()` 能從**真實 kernel** 重建。live e2e 證明:Personal approve 後,`shell.timeline(taskId)` 經 ListEntries 讀回真實 WORM、折出該事件(headline「已完成」、sequence 正確、canary 不在)。

## (2) Goal（一句話）
讓「寫的 WORM == 讀的 WORM」在 **live** 也成立:Personal 的治理事件不只 append 進真 kernel(S2),timeline 也從**同一顆真 kernel** 讀回重建——取代 S2 直讀 WAL 檔的 hack。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/runtime/ingest/grpc-client.ts`:加 `ListEntries` method(沿用既有手寫 proto3 unary codec 模式)：`encodeListEntriesRequest({fromSequence})` + `decodeListEntriesResponse`(decode `repeated Entry{sequence,canonical_event,prev_hash,entry_hash}`,重用 readLenDelim/readVarint)。
  - `src/runtime/ingest/`(transport.ts 擴充或新 read-transport.ts):一個 `createEntriesReader({endpoint, fromSequence?}): () => Promise<readonly LogEntry[]>`——呼叫 ListEntries → 每筆 `JSON.parse(canonical_event)` → AuditEvent → 組 `LogEntry{sequence, event, prevHash, entryHash}`;**fail-closed**:RPC/parse 錯 → reject(絕不回部分);grpc-js + stub 仍封閉於 `src/runtime/ingest`。
  - `src/personal/bootstrap.ts`:`PersonalShellOpts` 加 `readEntries?: () => Promise<readonly LogEntry[]>`(比照 `wormSink`);default = `() => Promise.resolve(sharedLog.entries() as LogEntry[])`(與 S1/S2 byte-identical);`timeline(taskId?)` 改 **async** → `await (opts.readEntries ?? defaultReader)()` 餵 `buildTaskTimeline`。更新 `PersonalShell.timeline` 型別 + 所有 caller/測試(grep)。
  - live e2e(gated on `AGENTOS_LIVE_KERNEL_ENDPOINT`):`createPersonalShell({wormSink: live ingest, readEntries: createEntriesReader({endpoint})})` → approve → `await shell.timeline(taskId)` 折出該治理事件(sequence 與 append 一致、headline「已完成」、**canary 不在 timeline 文字**)。沿用 e2e-live-kernel.sh harness(同顆 kernel)。
  - 單元測試:ListEntries decoder 對已知 Entry[] byte fixture(RED 先);reader fail-closed(RPC reject → reject);bootstrap 注入 recording reader → timeline 折出注入的 entries。
- Out-of-scope（明確不做）:
  - 簽章驗證讀回(S3a 已說明 unsigned;client 只驗鏈結+entryHash,不驗 Ed25519 anchor)。
  - streaming/range read(S3a unary 全量)。
  - 把 in-memory 主幹改掉(default reader 仍讀 sharedLog;S1/S2 行為不變)。

## (4) Design delta + 依賴方向
- **Design delta**:`grpc-client.ts` 加 ListEntries codec;新 reader;bootstrap 加 `readEntries` 注入點 + `timeline` 改 async。grpc-js/stub 仍只在 `src/runtime/ingest`(depcruise 綠)。
- **timeline async 漣漪**:`PersonalShell.timeline` 改 `Promise<TimelineEvent[]>` → 更新 caller/測試(S1/S2 的 timeline 斷言改 `await`)。`buildTaskTimeline` **不動**(純 fold)。
- **PUBLIC interface**:`createPersonalShell({ readEntries? })`;`createEntriesReader(opts)`。

## (5) Test-first plan（RED 先行）
- ListEntries decoder 單元測試對 byte fixture(decoder 不存在 → RED)。
- reader fail-closed:對未起 kernel → reject。
- live e2e:`AGENTOS_LIVE_KERNEL_ENDPOINT` 設、kernel 未起 → ListEntries reject → timeline reject/空 → 測試 FAIL(RED:真打真 kernel);起 kernel 後綠。

## (6) Definition of Done（待實測填）
- [ ] RED:decoder 單元測試 / live e2e 對未起 kernel 失敗。
- [ ] `pnpm run e2e:live-kernel` **exit 0**:真 kernel → Personal approve → `shell.timeline(taskId)` 經 **ListEntries 讀回真實 WORM** 折出該事件(sequence 正確、headline「已完成」、canary 不在)。
- [ ] `pnpm run verify` 仍 **exit 0**(gated live e2e SKIP;S1/S2 的 in-memory e2e 改 async 後仍綠;default reader byte-identical)。
- [ ] depcruise exit 0(ListEntries codec/grpc-js 封閉於 runtime/ingest);secret-scan clean。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:reader 不被使用(仍讀 in-memory)→ live timeline 斷言紅;decoder 漏欄位 → fixture 測試紅;reader 吞錯回部分 → fail-closed 測試紅)。

## (7) Rollback
- `git revert <merge-sha>`(移除 ListEntries codec + reader + readEntries 注入 + 還原 timeline 同步)。S1/S2 default 行為可逆。

## (8) Depends-on / blocks
- Depends-on:**P2R-PV-S3a**(kernel ListEntries RPC + 生成的 TS stub)、P2R-PV-S1/S2(bootstrap + wormSink)、R2-S6(grpc-client codec 慣例)。
- Blocks:無(收尾 Personal 垂直的 live 讀回時間軸)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:timeline 完整性可驗(鏈結+entryHash),但**未經簽章背書**(S3a unsigned;線上 kernel 無金鑰)——後續簽章讀回切片再補。
