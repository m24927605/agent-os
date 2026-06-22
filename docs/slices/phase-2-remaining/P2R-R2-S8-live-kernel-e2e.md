# SLICE-P2R-R2-S8: live Go-kernel 端到端（跨進程 gRPC append + 鏈 + 離線驗證）

- **Phase**: P2（R2 composition；S7 明列「真實 round-trip 延到組合期」——本刀補上）
- **Branch**: slice/p2r-r2-s8-live-kernel-e2e
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~160（`src/audit/ingest/live-kernel.e2e.test.ts` + `scripts/e2e-live-kernel.sh` + package.json 一個 script + barrel 不動）、新增依賴 = 0
- **狀態**: **DONE**（merge；writer=main-loop Opus4.8;reviewer=獨立 Opus4.8 Code Reviewer = PASS,零 BLOCKER/MAJOR,3 mutation probe 皆非 vacuous）

## (1) ID + Title
SLICE-P2R-R2-S8 — 用**真實的** `@grpc/grpc-js` transport，讓 R2 的 `createIngestAppender` 對一個**真的跑著的 Go kernel 進程**（`kernel/cmd/kernel` 的 `AppendService` gRPC server,`127.0.0.1:<port>`）端到端 append 真實 `AuditEvent`,取得真實 `AppendReceipt`,證明跨進程、跨語言（TS↔Go）的 commit 路徑成立、雜湊鏈正確、且 kernel 的 durable WAL 通過**離線 verifier** 驗證。

## (2) Goal（一句話）
把 S7 標註「延到組合期」的真實 round-trip 兌現:證明 commit-before-effect 的 appender 接到**真實 attester kernel**（非注入 double）時,雜湊鏈、fail-closed、credential-blind 全部在進程邊界上成立——「attester≠actor」變成可執行的事實。

## (3) In-scope / Out-of-scope
- In-scope:
  - `scripts/e2e-live-kernel.sh`:hermetic harness——(a) `go build -o <tmp>/agentos-kernel ./cmd/kernel`(用 `env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local`,與 verify:go 同契約);(b) 在**臨時 port**(預設 `127.0.0.1:7799`,可由 `$PORT` 覆寫)+ 臨時 WAL 路徑啟動 kernel;(c) 等待 listening;(d) 以 `AGENTOS_LIVE_KERNEL_ENDPOINT` 跑該 e2e vitest;(e) **無論成敗都 trap 清理**(kill kernel、刪臨時 WAL)。退出碼 = vitest 退出碼。
  - `src/audit/ingest/live-kernel.e2e.test.ts`:**gated** on `process.env.AGENTOS_LIVE_KERNEL_ENDPOINT`(未設 → `describe.skip`,使 `pnpm run verify` 保持 hermetic、不需 spawn/build)。內容:
    - happy chain:`createIngestAppender({transport: createRpcAppendTransport({endpoint}), sourceId})` append ≥2 個真實 `createAuditEvent(...)` → Receipt seq 0 then 1;`receipt1.prevHash === receipt0.entryHash`;contentHash/entryHash 皆 `sha256:`+64hex 非空。
    - fail-closed replay:對同一 source 重送一個已落定的 sequence(或同 (source,seq) 不同內容)→ kernel deny → appender **throw**(SEQUENCE_REPLAY,訊息含 code,不含 event 內容)。
    - credential-blind:event 內含 runtime 組裝的 secret canary → append 後該明文 **不出現**在 kernel 寫出的 WAL bytes(讀檔 grep)。
  - 離線驗證:append 後對 kernel WAL 跑既有 offline verifier(`kernel/cmd/verifier`)→ exit 0(鏈有效);harness 或測試擇一執行並斷言。
  - `package.json` 加 `"e2e:live-kernel": "bash scripts/e2e-live-kernel.sh"`。
- Out-of-scope（明確不做）:
  - 把本 e2e 併入預設 `pnpm run verify`(verify 須 hermetic;本刀 opt-in,鏡像 OpenShell e2e 的 gated 模式)。
  - TLS(insecure channel;S7 已記為後續)、auth、多租 partition routing。
  - R1 OpenShell / R11 vendor 的 live runtime(需外部 runtime,另案 + 環境-gated)。

## (4) Design delta + 模組 + 介面 + 依賴方向
- **Design delta**:純測試 + harness;**不改任何 runtime/核心程式碼**(只消費既有 public API:`createIngestAppender`、`createRpcAppendTransport`、`createAuditEvent`)。
- **依賴方向**:測試 import `src/audit/ingest`(barrel)+ `src/runtime/ingest`(barrel)+ `src/audit/event`;harness 純 shell(go build + spawn)。無新跨 module 依賴、無 vendor 進 core(測試檔本就在 depcruise 排除)。
- **真實 vs double**:transport **不注入 client** → `createRpcAppendTransport` 走真實 grpc-js 網路 → 對真實 kernel。

## (5) Test-first plan（RED 先行）
- 首先寫 `live-kernel.e2e.test.ts`;在 harness/endpoint 尚未就緒時,直接 `AGENTOS_LIVE_KERNEL_ENDPOINT=127.0.0.1:7799 vitest run …` 對**未啟動**的 kernel → 連線 refused → append reject → 測試 **FAIL(exit≠0)**(RED:證明它真的在打網路、不是 always-green)。
- 啟動真實 kernel 後同測試 → GREEN。
- 首次 RED 證據(貼 exit≠0):endpoint 設了但 kernel 沒起 → grpc UNAVAILABLE/ECONNREFUSED → reject。

## (6) Definition of Done（實測）
- [x] **RED**:`AGENTOS_LIVE_KERNEL_ENDPOINT=127.0.0.1:7799 vitest run …` 對未啟動 kernel → 3 tests FAIL、`14 UNAVAILABLE: ECONNREFUSED`(exit 1)——證明真打網路、非 always-green。
- [x] `pnpm run e2e:live-kernel` **exit 0**:真實 build+spawn kernel(log「listening」)→ 3 tests pass → append 2 事件鏈正確(prevHash 串接、seq 0/1)→ **TS 端 `computeEntryHash`/`contentAddress` 逐位元重算 == Go kernel 回傳的 receipt**(跨語言一致)→ replay 被 deny 且 appender throw(SEQUENCE_REPLAY)→ credential canary 不在 WAL(WAL 內為 `reason:"[REDACTED]"`)→ trap 清理(無殘留進程/temp)。
- [x] `pnpm run verify` **仍 exit 0**(gated e2e 在 verify 下 SKIP:`live-kernel.e2e.test.ts (3 skipped)`,gate 保持 hermetic、不 build/spawn)。
- [x] secret-scan clean(canary runtime 組裝);depcruise exit 0(無新違規;e2e 檔屬 *.test.ts 排除,vendor 仍封閉於 `src/runtime/ingest/grpc-client.ts`)。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8 Code Reviewer;3 mutation probe 皆精準轉紅且非 vacuous:(a) neuter redact→canary 進 WAL→credential 測試紅、(b) 改期望 entryHash→happy 測試紅(重算非 tautology)、(c) replay 改用 fresh source→fail-closed 測試紅;trap 清理在強制失敗下仍生效)。
> **誠實取代(MINOR,已記)**:離線 verifier binary（`kernel/cmd/verifier`）刻意**不**用於本刀——它吃的是 `SignedChain JSON + --pubkey`,**非** kernel 的 append WAL,且 checkpoint/signed-export 路徑未接(R10-S3)。鏈完整性改由**更強的 in-test 跨語言逐位元重算**證明(reviewer probe b 確認非 tautology)。WAL↔SignedChain export 的真實 verifier 驗證留待 **R10-S3**。

## (7) Rollback
- `git revert <merge-sha>`(移除 e2e 測試 + harness + package.json 一行)。純測試/harness,無 runtime 影響、可逆。

## (8) Depends-on / blocks
- Depends-on:R2-S2(createIngestAppender)、S6(createRpcAppendTransport + grpc-js client)、S7(pipeline 接線);P1 kernel(`kernel/cmd/kernel` AppendService server + `kernel/cmd/verifier` offline verifier)。
- Blocks:R8 Enterprise per-tenant kernel 的 live 部署 conformance、R10 時光旅行的 live snapshot/restore e2e(同 harness 模式)。
- 確認 slice DAG 無 cycle: ☑ 是
