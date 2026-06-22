# SLICE-OS-S2b: WatchSandbox streaming readiness（完成 OpenShellReadinessTransport）

- **Phase**: OpenShell live（完整 transport 收尾;最後 1 個消費 RPC）
- **Branch**: slice/os-s2b-watchsandbox-streaming-readiness
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day（不含 gateway）；net LOC <~160（WatchSandbox codec + 串流 transport + 測試;生成碼不計)、新增依賴 = 0
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer = PASS,無 BLOCKER/MAJOR;真實 WatchSandbox 串流經 grpcurl + live e2e 驗證;**完成完整 OpenShell gRPC transport(6 RPC)**）

## (1) ID + Title
SLICE-OS-S2b — 在 `createOpenShellGrpcTransport` 實作真實的 **`WatchSandbox(WatchSandboxRequest) → stream SandboxStreamEvent`**(server-streaming),取代 OS-S2a 留下的 fail-closed watch stub。讓 `adapter.awaitReady` 的 `watchUntilReady` 路徑(adapter.ts:311/watchUntilReady)能對真實 gateway 串流等待 READY,**完成 `OpenShellReadinessTransport` 全部 4 個方法**(create/get/delete + watch)。

## (2) Goal（一句話）
讓 readiness robust:當 createSandbox 後 sandbox 仍 PROVISIONING,adapter 經真實 WatchSandbox 串流等到 READY(而非 OS-S2a 仰賴第一次 getSandbox 剛好 READY 的 timing-fragile fast-path,或踩到 throwing stub)。

## (3) In-scope / Out-of-scope
- In-scope:
  - **proto 子集 + codec**(`openshell.subset.proto` + `openshell.subset.codec.ts`,re-pin sha):新增 `WatchSandboxRequest{id=1, follow_status=2, stop_on_terminal=7}`(只 encode 我們用的 3 欄)、`SandboxStreamEvent{oneof payload { Sandbox sandbox=1; ... }}`(只 decode `sandbox=1`,**重用 OS-S2a 的 Sandbox/ObjectMeta/SandboxStatus decode**;其餘 oneof variant 與未知欄位 skip)。method id `/openshell.v1.OpenShell/WatchSandbox`。
  - **grpc-transport `watchSandbox`**(取代 stub):`watchSandbox(req: WatchSandboxRequest, signal?): AsyncIterable<SandboxStreamEvent>`——`makeServerStreamRequest(WATCH_SANDBOX_METHOD, encodeWatchSandboxRequest, decodeSandboxStreamEvent, req)`;`signal` abort → `call.cancel()`;yield 每個 event(只含 `sandbox` 的 snapshot)。**無累積**(adapter 的 `watchUntilReady` 消費+判斷 phase);credential-blind。預設送 `follow_status=true, stop_on_terminal=true`(gateway 在 READY/ERROR 終止串流)——由 adapter 的 WatchSandboxRequest 決定;transport 忠實 encode。
  - 單元測試(fake stream):watch yield snapshot 序列(PROVISIONING→READY)→ adapter `watchUntilReady` 解析到 READY → ok;abort → cancel;codec byte-fixture(encode req 3 欄、decode SandboxStreamEvent oneof sandbox=1 → phase);未知 oneof variant/欄位 skip。
  - **live e2e**:沿用 composition root 的 `awaitReady`;確保**走到 watch 路徑**(create 後立即 awaitReady,sandbox 仍 PROVISIONING → getSandbox fast-path 非 READY → `watchUntilReady` 串流到 READY)。create→watch-ready→host→reconcile→delete。
- Out-of-scope:
  - `follow_logs`/`follow_events`/log tail、其餘 oneof variant(log/event/warning/draft_policy)——只 decode `sandbox`,其餘 skip。
  - 其餘 30+ provider/service/policy RPC。

## (4) Design delta + 依賴方向
- 只補 watchSandbox(stub→真);readiness 邏輯(adapter.watchUntilReady)已存在、不改。grpc-js 仍限 `src/runtime/openshell`。depcruise 綠。
- **PUBLIC**:`createOpenShellGrpcTransport` 現回**完整** `OpenShellReadinessTransport`(create/get/delete/watch 全真)。

## (5) Test-first plan（RED 先行）
- codec watch byte-fixture(encode/decode 不存在 → RED)。
- transport watch 對 fake stream(stub 仍 throw → RED;實作後 yield)。
- adapter readiness 對 fake watch:getSandbox PROVISIONING → watchUntilReady 消費 PROVISIONING→READY → ok(逾時/ERROR → deny)。
- live:create→(PROVISIONING)→watchUntilReady 串流→READY→host→reconcile→delete。

## (6) Definition of Done（實測）
- [x] RED:codec/transport watch 測試在實作前紅(18 failed,`decodeSandboxStreamEvent is not a function` + 缺 WatchStreamHandle/openWatchStream)。
- [x] **完整 transport**:`watchSandbox` 不再是 stub(WATCH_NOT_IMPLEMENTED 已移除);`createOpenShellGrpcTransport` 滿足**完整** `OpenShellReadinessTransport`(create/get/delete/watch)+ `OpenShellExecTransport`(reviewer grep 確認無 production stub 殘留)。
- [x] `pnpm run verify` **exit 0**(836 passed + 8 skipped;codec/transport watch 單元 + adapter-readiness-via-watch 測試綠;`openshell:proto:check` re-pin 綠〔reviewer tweak→FAIL 證實〕;depcruise grpc-js confined〔core 注入→exit 2〕;secret-scan clean)。
- [x] **live(我對真實 gateway 跑)**:`pnpm run e2e:live-nemoclaw` 3/3;且 **grpcurl WatchSandbox 對 PROVISIONING sandbox 確證真實串流形狀** `SandboxStreamEvent{sandbox:{metadata{id},status:{phase:"SANDBOX_PHASE_PROVISIONING"}}}` 多筆快照 == codec decode 目標(oneof sandbox=1 → Sandbox{status.phase@6})。
- [x] credential-blind(watch deny reason 靜態、無 endpoint/cert;secret-scan clean);fail-closed(watch stream 錯/abort/逾時 → deny;絕不偽造 ready)。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8,無 BLOCKER/MAJOR;3 mutation 證實非 vacuous:decode oneof 讀錯欄位→codec 紅、swallow error→deny 測試紅、abort 不 cancel→紅;非-sandbox/unknown variant→`{sandbox:undefined}` 不 crash;signal deviation 合理〔additive〕)。
> 全 6 個消費 RPC(Health/Create/Get/Delete/Exec/Watch)over mTLS 完成 — **完整 OpenShell gRPC transport 達成**。

## (7) Rollback
- `git revert <merge-sha>`(watch 退回 stub)。lifecycle/exec/readiness-getSandbox 不受影響。

## (8) Depends-on / blocks
- Depends-on:OS-S2a(lifecycle + Sandbox codec + awaitReady/watchUntilReady)、OS-S1(channel + streaming codec 樣板)、運行 gateway。
- Blocks:無(完成「6 個消費 RPC」完整 OpenShell gRPC transport)。
- **誠實前提**:live 需運行 gateway(我跑);verify hermetic;為確走 watch 路徑,readiness 須在 PROVISIONING 時被呼叫。
