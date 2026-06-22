# SLICE-P2R-R11-S8: RequestDecision-based LedgerTransport（接 demo 已實作的閘,credential-blind、fail-closed）

- **Phase**: P2（R11 SpendGuard live；裁決 (a) 的真實 transport 刀,接「真正被服務」的 RPC）
- **Branch**: slice/p2r-r11-s8-spendguard-decision-transport
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~200、files <~5（`src/runtime/spendguard/{decision-transport,decision-transport.test}.ts` + barrel + 擴充 vendored proto subset/regen stub）、新增依賴 = 0
- **狀態**: **DONE**（不需 Docker;單元測試對 in-process fake sidecar 跑;live 屬 S9。獨立 Opus 4.8 adversarial review = PASS）

## (1) ID + Title
SLICE-P2R-R11-S8 — 因 R11-S7 ground-truth 證實 `SidecarAdapter` 的 session RPC(ReserveSession/CommitSessionDelta)在真實 demo 是 `unimplemented`([`services/sidecar/src/server/adapter_uds.rs:142-173`](../../../)),改實作一個 `createDecisionLedgerTransport({ udsPath })`:走 demo **真正實作**的 RPC——`handshake`(adapter_uds.rs:73)→ `RequestDecision`(:82,`request_decision_inner:312`→`run_through_reserve:370`)→ `ConfirmPublishOutcome`(:91)→ `ReleaseReservation`(:196)——並映成既有 `SpendGuardCostGate` 的 `LedgerTransport` seam([`src/cost/adapters/spendguard/adapter.ts:65-68`](../../../src/cost/adapters/spendguard/adapter.ts))。

## (2) Goal（一句話）
提供一個**對真實 demo 真的能跑**的 `LedgerTransport`:reserve→RequestDecision、commit→ConfirmPublishOutcome,使 `SpendGuardCostGate` 在 S9 能對真實 SpendGuard 拿到 live 證明,且維持 credential-blind + fail-closed。

## (3) In-scope / Out-of-scope
- In-scope:
  - 擴充 R11-S5 的 vendored proto subset:加入 `DecisionRequest`(proto:309)/`DecisionResponse`(:422)/`ConfirmPublishOutcome*`/`Handshake*`/`ReleaseReservation*` 及其 common 依賴(`BudgetClaim`/`TraceContext`/`SpendGuardIds`/`UnitRef`),regen types-only stub;`spendguard:proto:check` 仍綠。
  - `createDecisionLedgerTransport({ udsPath, timeoutMs? }): LedgerTransport`:
    - 啟動時 `Handshake` 建立 session(取得 session_id;adapter_uds.rs:73)。
    - `reserve(LedgerReserveReq)` → `RequestDecision`(trigger=`LLM_CALL_PRE`,route=req.route,projected cost 由 req.estimated_amount_atomic 映成 `Inputs.projected_claims`/`projected_p*_atomic`);依 `DecisionResponse.decision`:
      - `CONTINUE`(:429)→ `{reservationId: decision_id}`。
      - `STOP`/`STOP_RUN_PROJECTION`(:432/452,預算/run 超限)→ `{overBudget:true}`(hard-cap)。
      - **其餘**(DEGRADE/SKIP/REQUIRE_APPROVAL/UNSPECIFIED/未知 enum)→ **throw**(deny-by-default;proto:448 明定未知 enum 必 fail-closed)。
    - `commit(LedgerCommitReq)` → `ConfirmPublishOutcome`(decision_id=reservation_id,actual);映 `{overrun}`。
  - **fail-closed**:連線 refused / timeout / peercred 拒 / 非預期回應 / 非 CONTINUE 非 STOP → throw(adapter catch → denyReserve/denyCommit)。
  - **credential-blind**:只送 cost 投影 + route + session/trace ID(DecisionRequest 無 credential 欄;runtime_metadata 不放 secret)。
  - 單元測試對 **in-process fake sidecar**(grpc-js server,UDS,實作 handshake+request_decision+confirm_publish_outcome):CONTINUE→reserve ok、STOP→overBudget、commit→overrun、未知 decision→throw、server down→fail-closed。**不需 Docker**。
- Out-of-scope:
  - live demo / 對真實 sidecar → S9。
  - `ReleaseReservation` 接到 CostGate.release → R12。
  - mTLS/SPIFFE prod、HTTP companion。
  - S6 的 `createSidecarLedgerTransport`(session-RPC 版)保留不刪——待 vendor 實作 session bridge 後仍有效。

## (4) Design delta + 模組 + 介面 + 依賴方向
- **Design delta**:在 `src/runtime/spendguard` 新增 `decision-transport.ts`(與 S6 的 session transport 並存,兩種 `LedgerTransport` 實作);擴充 vendored proto subset + regen stub。
- **依賴方向 / 封閉**:grpc-js + stub **只**在 `src/runtime/spendguard/`;core 無 import(depcruise `not-to-internal`+`no-vendor-in-core` 綠,reviewer 實證 core 注入→exit≠0)。
- **PUBLIC interface**:`createDecisionLedgerTransport(opts): LedgerTransport`(滿足 adapter.ts:65-68)。

## (5) Test-first plan（RED 先行）
- 先寫 `decision-transport.test.ts`(transport 不存在→import RED)。
- RED 清單:CONTINUE→`{reservationId}`;STOP→`{overBudget}`;commit→`{overrun}`;未知 decision/空回應→throw;server down→reserve reject。

## (6) Definition of Done（實測結果）
- [x] RED:transport 不存在→測試 import 失敗 exit≠0（先行驗證;後 GREEN 見下）。
- [x] `pnpm run verify` **exit 0**（全閘綠;`VERIFY_EXIT=0`）;單元測試(對 in-process fake UDS sidecar)`12 passed (12)`、`VITEST_EXIT=0`;`spendguard:proto:check` **exit 0**（`pin ok` / `stub ok` / `ok` — subset 擴充後 regen 一致）。
- [x] `pnpm run deps:check` **exit 0**（`✔ no dependency violations found (117 modules, 275 dependencies cruised)`;`DEPS_EXIT=0`） + reviewer 實證封閉(core 注入 grpc-js/stub → depcruise `no-vendor-in-core`/`not-to-internal` exit≠0;由 `proto/spendguard-proto-check.test.ts` 之 `no-vendor-in-core` 測試守住)。
- [x] fail-closed mutation:非 CONTINUE(DEGRADE / UNSPECIFIED / 未知 enum / CONTINUE 空 decision_id)當成功 → 測試紅；server down 當成功 → 測試紅（對應測試 `rejects.toThrow()`,皆綠）。
- [x] credential-blind:`reserve: carries ONLY cost projection + route + session id` 測試斷言 DecisionRequest 僅含 cost 投影 + route + session id;transport 不放 secret 進 wire/log/throw;`secret-scan` **exit 0**（`secret-scan: clean`;`SECRET_EXIT=0`）。
- [x] Adversarial review = PASS(獨立 Opus 4.8;fresh-context、非作者)。

## (7) Rollback
- `git revert <merge-sha>`(移除 decision-transport + subset 擴充)。S6 session transport 不受影響。

## (8) Depends-on / blocks
- Depends-on:R11-S5（proto codegen 慣例 + vendored subset）、R11-S3（SpendGuardCostGate + seam,DONE）、R11-S7（裁決 (a) 的 ground-truth）。
- Blocks:R11-S9（live e2e 用此 transport 對真實 demo）。
- DAG 無 cycle: ☑
