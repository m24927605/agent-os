# SLICE-P2R-R11-S6: 真實 SidecarAdapter LedgerTransport（grpc-js over UDS,fail-closed、vendor-confined）

- **Phase**: P2（R11 SpendGuard live；真實 transport 刀,仿 R2-S6）
- **Branch**: slice/p2r-r11-s6-spendguard-uds-transport
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~170、files <~4（`src/runtime/spendguard/{transport,index,transport.test}.ts` + barrel）、modules <~1、**新增依賴 = grpc-js（已於 R2-S6 在 repo → 0 新增）**
- **狀態**: **DRAFT**（build-gated:transport 單元測試可對 in-process fake gRPC server 跑,**不需** Docker;對真實 SpendGuard 的連線屬 S7）

## (1) ID + Title
SLICE-P2R-R11-S6 — 實作既有 `SpendGuardCostGate` 注入點 `LedgerTransport`([`src/cost/adapters/spendguard/adapter.ts:65-68`](../../../src/cost/adapters/spendguard/adapter.ts))的**真實**後端:一個 `createSidecarLedgerTransport({ udsPath })`,以 **grpc-js over Unix Domain Socket** 呼叫 SpendGuard sidecar 的 `SidecarAdapter` 服務(`ReserveSession`/`CommitSessionDelta`),把回應映成 adapter 期望的 `{reservationId}|{overBudget}` / `{overrun}`。

## (2) Goal（一句話）
把 adapter 的注入 seam 換成真貨:讓 `SpendGuardCostGate` 能對**真實 SpendGuard sidecar**(UDS)reserve/commit,且任何傳輸錯誤 / peercred 拒絕 / 非預期回應一律 **fail-closed → deny**(覆蓋 SpendGuard predictor 的 fail-open,呼應 adapter.ts:18-21 與 AGENTS.md deny-by-default)。

## (3) In-scope / Out-of-scope
- In-scope:
  - `createSidecarLedgerTransport({ udsPath, timeoutMs? }): LedgerTransport`——grpc-js channel 到 `unix://<udsPath>`(demo UDS = `/var/run/spendguard/adapter.sock`,見 [`services/sidecar/src/config.rs:243-244`](../../../) + compose env `SPENDGUARD_SIDECAR_UDS_PATH`)。
  - `reserve(LedgerReserveReq)` → `SidecarAdapter.ReserveSession`(adapter.proto:124);over-budget outcome → `{overBudget:true}`;成功 → `{reservationId}`。
  - `commit(LedgerCommitReq)` → `SidecarAdapter.CommitSessionDelta`(adapter.proto:129);回 `{overrun}`。
  - **fail-closed**:連線 refused / timeout(deadline)/ SO_PEERCRED 拒絕([`config.rs:114-120`](../../../))/ 空或非預期 oneof → **throw**(adapter 的 catch 會轉 denyReserve/denyCommit;絕不回 allow/falsy success)。
  - **credential-blind**:req 只帶 `tenant_id` + `estimated_amount_atomic`/`amount_atomic_delta` + `route`,**無** credential 欄(adapter.ts:46-58 已如此;transport 不得新增)。
  - 單元測試對 **in-process fake SidecarAdapter gRPC server**(grpc-js server bound to a temp UDS)跑:成功 reserve、over-budget、commit overrun、連線 refused fail-closed——**不需** Docker。
- Out-of-scope（明確不做）:
  - 起真實 SpendGuard / 對真實 sidecar 的 live e2e → S7。
  - `ReleaseSession`(adapter.proto:134)接線 → R12（CostGate release 已是 follow-up,adapter.ts:162-171）。
  - mTLS/SPIFFE prod 路徑、HTTP companion(axum+rustls,config.rs:196)→ 後續(demo 用 UDS)。

## (4) Design delta + 模組 + 介面 + 依賴方向
- **Design delta**:新增 `src/runtime/spendguard`(vendor adapter 模組);import S5 的 generated stub + grpc-js;實作 `LedgerTransport`(型別來自 `src/cost/adapters/spendguard/adapter.ts` 的 public interface)。
- **依賴方向 / 封閉**:grpc-js + SpendGuard generated stub **只**出現在 `src/runtime/spendguard/`;**無** core 模組 import 它(depcruise `not-to-internal` + `no-vendor-in-core` 必須綠——reviewer 須**實證**:往 core 注入此 import → depcruise exit≠0,鏡像 R1/R2 的封閉實證)。
- **PUBLIC interface**:`createSidecarLedgerTransport(opts): LedgerTransport`(滿足 adapter.ts:65-68 的 `LedgerTransport`)。

## (5) Test-first plan（RED 先行）
- `transport.test.ts`:先寫對 fake SidecarAdapter UDS server 的測試(transport 不存在 → import RED)。
- RED 清單:reserve 成功回 `{reservationId}`;over-budget outcome → `{overBudget:true}`;commit → `{overrun}`;**fail-closed**:server 未起 / 關閉 → reserve **reject**(throw);非預期/空 oneof → throw。
- 首次 RED 證據:import `./transport.js` 失敗。

## (6) Definition of Done（待實測填）
- [ ] RED:transport 不存在 → 測試 import 失敗 exit≠0。
- [ ] `pnpm run verify` exit 0;單元測試(對 in-process fake UDS server)全綠。
- [ ] depcruise exit 0 **且** reviewer 實證 grpc-js + generated stub 封閉於 `src/runtime/spendguard/`(core 注入 → exit≠0)。
- [ ] fail-closed 經 mutation 驗證:把「連線錯誤回 falsy success」→ 對應測試紅;空 oneof 當成功 → 紅。
- [ ] credential-blind:grep transport,無 credential 進 req/log/throw;secret-scan clean。
- [ ] Adversarial review = PASS(獨立 Opus 4.8)。

## (7) Rollback
- `git revert <merge-sha>`（移除 `src/runtime/spendguard` 模組）。adapter 退回注入 fake seam,無 runtime 影響。

## (8) Depends-on / blocks
- Depends-on:R11-S5（generated stub）、R11-S3（`SpendGuardCostGate` + `LedgerTransport` seam,已 DONE）、R2-S6（grpc-js 慣例 + dep）。
- Blocks:R11-S7（live e2e 需真實 transport）。
- DAG 無 cycle: ☑
