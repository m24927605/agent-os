# 設計：TS→Go 真實 ingest client（sync-commit）— R2

> Item **R2**（見 [`../slices/phase-2-remaining/INDEX.md`](../slices/phase-2-remaining/INDEX.md) 第 20 行）。
> 方法論：[`../standards/looping-engineering.md`](../standards/looping-engineering.md)（doc-first、小 slice、RED 先行、
> Independent Verifier Pass = 獨立 Opus 4.8 reviewer、5 回合上限 → Staff+ 升級）。
> slice 範本：[`../standards/slice-spec.md`](../standards/slice-spec.md) §6+§10。**AGENTS.md 勝出。only command output is truth。**
> **狀態：DRAFT（規劃骨架；尚未開工）。**

---

## 1. What / Why（要做什麼、為什麼）

P2-C 接上了 TS 端 `commitBeforeEffect` 時序保證，P2-I 把整條治理管線串成一條流——**但兩者都用一個
in-memory appender**（P2-I §16「in-memory commit appender」；guard.ts §11「composition root injects the real
append client」）。也就是說：今天 TS 控制平面**還沒有真的把 evidence append 進 Go evidence kernel**。護城河
（attester≠actor 的 WORM kernel）在 TS 側仍是空接線。

本 ITEM 補上**真實的 appender**：一個 TS client，對 Go kernel 的 `AppendService.Append` RPC 發出**同步 commit**
（canonicalize→redact→Append→**await durable Receipt**），其回傳的 receipt 物件即可直接餵進
`commitBeforeEffect` 的 `CommitAppender<E,R>` 注入點。這把 P2-I 的 in-memory appender 換成 production appender，
讓「外部 effect 只在 evidence 落進 WORM kernel 之後才發生」這條時序保證**跨 plane（TS→Go）真的成立**。

**為什麼是「sync-commit」**：commitgate 的契約是 append **resolve 才放行 effect**（guard.ts §18-20「a RESOLVED
promise … counts as a durable commit … Signal failure by REJECTING」）。因此 ingest client 必須：
- **append 成功 = kernel 已 durably commit（fsync）並回 Receipt**——對齊 Go server 的 commit-before-effect
  （[`kernel/internal/server/append.go:1-5`](../../kernel/internal/server/append.go) 套件註解「durably commits (fsync …) BEFORE
  returning a Receipt」、`:91-93` durable commit 失敗→不回 Receipt→Internal error）。
- **任何拒絕 / 連線錯誤 / 逾時 = reject**（deny-by-default、fail-closed），讓 commitgate 短路成 `aborted`，effect 絕不執行。

---

## 2. 架構（如何接）

```
   runGovernedToolCall (P2-I orchestration)
        │  appender: CommitAppender<AuditEvent, AppendReceipt>   ← P2-I 注入點（換掉 in-memory）
        ▼
   commitBeforeEffect (P2-C commitgate)  ── append → await receipt → 才 effect
        │  appender.append(event)
        ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  IngestClient (本 ITEM, src/audit/ingest/)                          │
 │  append(event):                                                     │
 │   1. canonicalizeAuditEvent(event)  ← src/audit/canonical.ts        │ ← redact 已內含於 canonical
 │   2. contentAddress(event)          ← src/audit/canonical.ts        │
 │   3. dedup check (sourceId, sequence)                               │
 │   4. transport.append({sourceId, sequence, canonicalEvent})  (RPC)  │
 │   5. 解析 AppendResponse.oneof: receipt → AppendReceipt;             │
 │      error/empty/連線錯誤/逾時 → throw (fail-closed)                  │
 └───────────────────────────────┬─────────────────────────────────────┘
                                 │ proto AppendService.Append（型別化契約，唯一跨 plane 接縫）
                                 ▼
   Go kernel IngestServer.Append  ← kernel/internal/server/append.go
   （append-only、monotonic per-source sequence、fsync-before-Receipt、typed AppendError）
```

**跨 plane 規則**：TS 與 Go **只透過 `proto/ingest.proto` 互動**（slice-spec §2）。proto 目前只生成 Go
（[`scripts/proto-gen.sh`](../../scripts/proto-gen.sh) 只有 `--go_out`/`--go-grpc_out`）；TS 端尚無生成 stub，也**無任何
RPC transport 依賴**（package.json `dependencies` 僅 `zod`）。因此架構分層為：

| 層 | 責任 | 接縫 |
|---|---|---|
| **transport（vendor-neutral port）** | 一個 `AppendTransport` interface：`append(req)→AppendResponse`-形狀。**不**綁定具體 RPC 客戶端。 | core 只依賴此 port |
| **transport adapter（具體 RPC）** | 用具體 RPC client（connect-es / grpc-js）實作 `AppendTransport`。**單一 chokepoint**。 | 放 `src/runtime/`（與 substrate/hosting adapter 同層；不算 core） |
| **IngestClient（core 邏輯）** | canonicalize→redact→dedup→透過 `AppendTransport` 送、解析 oneof、fail-closed。 | 注入 `AppendTransport`，零 vendor import |

> 這樣分層的理由：`no-vendor-in-core`（[`.dependency-cruiser.cjs:49-67`](../../.dependency-cruiser.cjs)）禁止 core 模組
> （含 `audit`）import 具體 vendor；而一個 RPC client（connect/grpc）本質上是「執行基質的傳輸 adapter」。把
> 純邏輯（canonicalize/dedup/解析 oneof）留在 `src/audit/ingest/`（core，可單測、零網路），把**具體 RPC 連線**
> 推到注入的 `AppendTransport` adapter（`src/runtime/`）。IngestClient 對 transport 只看見一個 port interface。

---

## 3. 重用 vs 新增（誠實清單）

### 重用（已存在，不重寫）
- `canonicalizeAuditEvent(event)`、`contentAddress(event)` — [`src/audit/canonical.ts:65-78`](../../src/audit/canonical.ts)。
  **redact 已內含**：`canonicalizeAuditEvent` 內部先 `redactSecrets` 再 canonicalize（`:65-68`），且 redact 是
  by-key + by-value 兩道（[`src/audit/redact.ts:14-24`](../../src/audit/redact.ts)）。→ client **不**自己 redact，直接呼叫
  canonical 即得「已 redact 的 canonical bytes」，正好對應 proto `canonical_event` 欄位語意
  （[`proto/ingest.proto:18`](../../proto/ingest.proto)「ALREADY-redacted … canonical bytes」）。
- `AppendReceipt`（`{sequence,contentHash,prevHash,entryHash}`）— [`src/audit/kernel/log.ts:23-28`](../../src/audit/kernel/log.ts)。
  本 ITEM 的 client `append()` **回傳同一個 `AppendReceipt` 型別**，與 in-memory `AppendOnlyLog.append` 同形，
  使 P2-I 替換 appender 時**零型別改動**。
- `commitBeforeEffect` / `CommitAppender<E,R>` — [`src/commitgate/guard.ts:21-23,57-74`](../../src/commitgate/guard.ts)。本 ITEM 不改 guard；
  只提供一個滿足 `CommitAppender<AuditEvent, AppendReceipt>` 的真實實作。
- `AuditEvent` Zod 契約 — [`src/audit/event.ts:32-46`](../../src/audit/event.ts)。
- Go 端**全部已存在**：`AppendService`（[`proto/ingest.proto:11-13`](../../proto/ingest.proto)）、
  `IngestServer.Append`（[`kernel/internal/server/append.go:64-99`](../../kernel/internal/server/append.go)）、Go 參考 client
  surface（[`kernel/internal/client/client.go:24-49`](../../kernel/internal/client/client.go)，append-only、解析 oneof、empty→fail-closed
  — TS client 鏡像其形狀）、outbox 的 capped/dedup 語意（[`kernel/internal/outbox/outbox.go`](../../kernel/internal/outbox/outbox.go)）。

### 新增（本 ITEM）
- `src/audit/ingest/`（core）：`AppendTransport` port、`IngestClient`（canonicalize→dedup→send→解析 oneof→fail-closed）、
  `(sourceId,sequence)` dedup、capped client-side outbox。**無 vendor import、無網路**。
- `proto:gen`/`proto:check` 擴充：生成並校驗 TS stub（若採 connect-es / ts-proto）——**單獨的契約 slice**（S5），
  **契約先於消費者**（slice-spec §9），**不**引入 runtime RPC 依賴、**無**消費者。
- `src/runtime/<transport-adapter>/`（非 core）：用具體 RPC client 實作 `AppendTransport`——**單獨的新依賴 slice**（S6），
  新增第三方 RPC 依賴依 slice-spec §3「新增第三方依賴 = 0；若必要則單獨成一個 slice」，且**依賴變更不與行為變更同 slice**。
- composition-root 接線（取代 in-memory appender）——**單獨的行為 slice**（S7），零新依賴，純 wiring 切換。
  **（S7 已落地）**：`createIngestAppender({transport, sourceId, dedup?, outboxCapacity?})`
  （[`src/audit/ingest/wire.ts`](../../src/audit/ingest/wire.ts)）把 S2 `createIngestClient`（含 S3 dedup）與 S4 capped
  outbox 組成單一 `CommitAppender<E, AppendReceipt>`，與 in-memory `AppendOnlyLog.append` 同形（同 receipt 型別、
  同單參數 `append(event)`），故 P2-I 的 `CommitAppender<unknown,R>` 注入點**零型別改動**即可由 in-memory 換成真實 ingest。
  composition-root e2e（[`src/audit/ingest/wire.e2e.test.ts`](../../src/audit/ingest/wire.e2e.test.ts)）以 S6
  `createRpcAppendTransport` + in-process fake `AppendService` 驅動 `runGovernedToolCall`：happy → `executed`、append
  恰 1 次且**先於** effect、effect 恰 1 次；transport reject / server-error oneof → `denied@commit`、effect **零次**
  （`FakeSandboxAdapter` 無 sandbox）；並有「替換完整性」靜態斷言——wire.ts 與 orchestration pipeline 皆**不** import
  in-memory `AppendOnlyLog` 作 appender（5 RED→GREEN，`pnpm run verify` exit 0）。

### 誠實能力閘（capability gates — 哪些是 verified-from-code，哪些是 inferred）
- **verified-from-code**：Go server 的 fsync-before-Receipt、typed AppendError、append-only/monotonic 語意
  （append.go、proto 已讀）；TS canonical/redact/receipt/commitgate 形狀（已讀）。
- **verified-from-code（S6 已落地）**：具體 RPC transport 選型 = **`@grpc/grpc-js`**（對齊 Go 端
  `google.golang.org/grpc` 的 `grpc.ClientConnInterface` 注入式 seam）。adapter 落在 `src/runtime/ingest/`
  （`createRpcAppendTransport({endpoint, timeoutMs?, client?})` 實作 vendor-neutral `AppendTransport`；
  `transport.ts` 做 fail-closed 映射，`grpc-client.ts` 是唯一 import `@grpc/grpc-js` 的 chokepoint，含
  hand-written proto3 wire codec，因 S5 stub 為 `onlyTypes=true` 無 codec）。所有傳輸層失敗（RPC error /
  連線拒絕 / `timeoutMs` 逾時 / 同步 throw）一律 **reject**；oneof 照實回 `AppendResponseShape`，由 S1
  `parseAppendResponse` 作唯一 fail-closed 判定。注入式 `client` 讓測試用 in-process `AppendService` stub
  零網路過測（7 RED→GREEN，`pnpm run verify` exit 0；`deps:check` 證實 vendor 僅在 runtime、core 零 vendor、無 cycle）。
- **inferred**：Go kernel 是否已有可由 TS 連到的 listening server（[`kernel/cmd/`](../../kernel/cmd) 存在但本 ITEM 未逐行讀）——
  端到端（真連線）整合留給 adapter slice S6 / wiring slice S7，core slice 用 fake transport 不需要它。

---

## 4. 設計取捨（trade-offs）

1. **port 注入 transport vs 直接 import RPC client**：選 port 注入。代價是多一層 interface；收益是 core 可零網路
   單測、不違反 `no-vendor-in-core`、選型可延後、與既有 commitgate/brain-guard/pipeline 的 DI 風格一致。
2. **client 端 dedup（(sourceId,sequence)）vs 全交給 kernel**：kernel 已會以 `SEQUENCE_REPLAY` 拒絕重投
   （[`kernel/internal/server/append.go:76-78`](../../kernel/internal/server/append.go)）。但 client 端先做 dedup 有兩個價值：
   (a) crash-resume 時不必把已 settled 的 append 再打到 kernel（省一次 RTT 與一次 denial-audit）；(b) 把「同一
   (sourceId,sequence) 以**不同** contentHash 重投」視為 fail-closed conflict（鏡像 outbox `ErrContentConflict`，
   [`kernel/internal/outbox/outbox.go:30-31,238-248`](../../kernel/internal/outbox/outbox.go)）。**權威仍在 kernel**；client dedup 只是
   不變量一致的前置短路，絕不放寬 kernel 的拒絕。
3. **capped outbox vs 無界**：無界記憶體 buffer 在 kernel 不可達時會 OOM（fail-open 風險）。採**有界**（cap），
   滿載時 fail-closed（拒收新 enqueue 並讓 caller 看見錯誤 → commitgate abort → effect 不發生），對齊「unknown /
   error ⇒ deny」。Go outbox 是 durable 檔案；TS 這層先做**有界記憶體** outbox（durable 化是後續，超出 size budget）。
4. **sequence 由誰配**：Go outbox 由 outbox 配 per-source monotonic（`outbox.go:185-200`）。TS 這層的 `append(event)`
   需要 `(sourceId, sequence)`。取捨：由**caller（composition root / P2-I）提供 sourceId，client 維護 per-source
   monotonic counter** 配 sequence（與 Go outbox 對齊），dedup 表以此為 key。這讓 `CommitAppender<E,R>` 的
   `append(event)` 簽章維持單參數（與 in-memory log 同形），sourceId 在建構 client 時綁定。

---

## 5. slice 分解（小、acyclic、RED 先行）

> 每個 slice 受 slice-spec §3 size budget（net LOC <~300、files <~6、modules <~2）。新增第三方依賴 = 單獨 slice。

| slice | 標題 | 主要產物 | 新依賴 | Depends-on |
|---|---|---|---|---|
| **S1** | AppendTransport port + AppendResponse 解析（fail-closed） | `src/audit/ingest/{transport.ts,parse.ts,index.ts}` | 0 | P2-C |
| **S2** | canonicalize→redact→Append→await Receipt wrapper（IngestClient core） | `src/audit/ingest/client.ts` | 0 | S1 |
| **S3** | (sourceId,sequence) dedup + content-hash conflict fail-closed | `src/audit/ingest/dedup.ts` | 0 | S2 |
| **S4** | capped client-side outbox（滿載 fail-closed） | `src/audit/ingest/outbox.ts` | 0 | S2 |
| **S5** | proto TS-stub codegen + `proto:check` TS drift gate（契約，無消費者） | `scripts/proto-gen.sh`/`proto-check.sh` 擴充 + 生成 TS stub（generated） | **TS proto codegen 工具（dev）** | P1 kernel proto |
| **S6** | 具體 RPC transport adapter 實作 `AppendTransport`（引入 RPC client；in-process fake server 過測） | `src/runtime/<adapter>/{transport.ts,index.ts,transport.test.ts}` | **RPC client（runtime）** | S1, S5 |
| **S7** | composition-root 接線：以 `createIngestClient`(+S3 dedup+S4 outbox) 取代 P2-I in-memory appender + e2e | composition root 接線 + e2e test | 0 | S2, S3, S4, S6, P2-I |

> S1-S4 全在 `src/audit/ingest/`（core，零網路、零 vendor），可獨立 RED→GREEN→verify。
> **後段三刀依 slice-spec §3／§9 拆開**：S5 = 契約（proto TS stub，先於消費者，無 runtime 依賴、無消費者）；
> S6 = 新依賴（RPC client；依賴變更隔離在它唯一的消費者/chokepoint，用 in-process fake server 過測，不改 pipeline 行為）；
> S7 = 行為（零新依賴的 composition-root wiring 切換 + e2e）。這把「依賴變更」「契約變更」「行為變更」三者各自成 slice。

### slice DAG（無 cycle）
```
P1-proto ─▶ S5 ──────────────┐
                             ▼
P2-C ─▶ S1 ──────────────▶ S6 ──┐
         └▶ S2 ─┬─▶ S3 ──────────┼─▶ S7 ◀─ P2-I
               └─▶ S4 ───────────┘
```
> 邊（edges，無 cycle）：`P1-proto → S5`；`P2-C → S1`；`S1 → S2`；`S2 → S3`；`S2 → S4`；
> `{S1, S5} → S6`；`{S2, S3, S4, S6, P2-I} → S7`。所有箭頭單向、無回邊。

---

## 6. 安全不變量（每個 slice 的對抗式 RED 取用）
- **deny-by-default / fail-closed**：AppendResponse 是 `error`、是空 oneof、transport throw、逾時 → **一律 reject**
  （絕不回一個 falsy receipt，否則 commitgate 會誤放 effect — guard.ts §18-20）。`CODE_UNSPECIFIED`（proto zero）
  也視為 deny（[`proto/ingest.proto:31`](../../proto/ingest.proto)、[`kernel/internal/ingestpb/ingest.pb.go:26`](../../kernel/internal/ingestpb/ingest.pb.go)）。
- **credentials never on disk**：client **不**自己持有/序列化 secret；送出的是 `canonicalizeAuditEvent` 的**已 redact**
  bytes。對抗式 RED：在事件塞 runtime 組裝的 secret canary，斷言送到 transport 的 bytes 與任何 outbox 落地內容
  **不含** canary（canary 於 runtime 組裝，不入 source/fixture/snapshot）。
- **append-only**：client surface **只暴露 append**（鏡像 Go client.go §3-4「no Update/Delete/Overwrite」）。
- **low coupling**：只經 barrel 消費（`../canonical.js`、`../kernel/log.js` 同模組內；`../../commitgate/index.js` 經
  barrel）；transport 為注入 port，無 vendor import；無 cycle。

---

## 7. Rollback / 演進
- 每個 slice 可 `git revert <merge>` 獨立回退（core slice 無外部副作用）。
- S7 含真實接線：回退 = 把 P2-I 的 appender 換回 in-memory（feature wiring 切換，非資料遷移）。WORM 已 append 的
  evidence **不回寫**（append-only；靠 forward-correcting event）。
- 演進：TS 有界記憶體 outbox → 後續可升 durable（鏡像 Go outbox 的 framed-append+fsync+replay），但屬獨立 ITEM。
