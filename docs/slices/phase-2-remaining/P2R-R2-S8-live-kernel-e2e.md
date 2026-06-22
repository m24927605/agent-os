# SLICE-P2R-R2-S8: live Go-kernel 端到端（跨進程 gRPC append + 鏈 + 離線驗證）

- **Phase**: P2（R2 composition；S7 明列「真實 round-trip 延到組合期」——本刀補上）
- **Branch**: slice/p2r-r2-s8-live-kernel-e2e
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~160（`src/audit/ingest/live-kernel.e2e.test.ts` + `scripts/e2e-live-kernel.sh` + package.json 一個 script + barrel 不動）、新增依賴 = 0
- **狀態**: **DRAFT**

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

## (6) Definition of Done（每條附指令證據）
- [ ] RED:endpoint 指向未啟動 kernel → e2e FAIL(exit≠0,連線 refused)。
- [ ] `pnpm run e2e:live-kernel` **exit 0**:真實 spawn kernel → append 2 事件 → 鏈正確(prevHash 串接)→ replay 被 deny 且 appender throw → credential canary 不在 WAL → 離線 verifier exit 0 → 清理。
- [ ] `pnpm run verify` **仍 exit 0**(gated e2e 在 verify 下 skip,gate 保持 hermetic)。
- [ ] secret-scan clean(canary runtime 組裝)。
- [ ] depcruise exit 0(無新違規)。
- [ ] Adversarial review = PASS(fresh-context 獨立 Opus 4.8;mutation:把 redact 拿掉 → canary 出現在 WAL 測試紅;把 replay 當成功 → fail-closed 測試紅;確認測試真的對真 kernel、非注入 double)。

## (7) Rollback
- `git revert <merge-sha>`(移除 e2e 測試 + harness + package.json 一行)。純測試/harness,無 runtime 影響、可逆。

## (8) Depends-on / blocks
- Depends-on:R2-S2(createIngestAppender)、S6(createRpcAppendTransport + grpc-js client)、S7(pipeline 接線);P1 kernel(`kernel/cmd/kernel` AppendService server + `kernel/cmd/verifier` offline verifier)。
- Blocks:R8 Enterprise per-tenant kernel 的 live 部署 conformance、R10 時光旅行的 live snapshot/restore e2e(同 harness 模式)。
- 確認 slice DAG 無 cycle: ☑ 是
