# SLICE-P2R-R11-S6: 真實 SidecarAdapter LedgerTransport（grpc-js over UDS,fail-closed、vendor-confined）

- **Phase**: P2（R11 SpendGuard live；真實 transport 刀,仿 R2-S6）
- **Branch**: slice/p2r-r11-s6-spendguard-uds-transport
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~170、files <~4（`src/runtime/spendguard/{transport,index,transport.test}.ts` + barrel）、modules <~1、**新增依賴 = grpc-js（已於 R2-S6 在 repo → 0 新增）**
- **狀態**: **DONE**（merged to main；transport 單元測試對 in-process fake gRPC server 跑,**不需** Docker;對真實 SpendGuard 的連線屬 S7）

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

## (6) Definition of Done（實測 exit code 如下）
- [x] RED:移除 `transport.ts` 後跑 `vitest run src/runtime/spendguard/transport.test.ts` → **exit 1**,`Error: Failed to load url ./transport.js ... Does the file exist?`(import RED 證據)。
- [x] `pnpm run verify` → **exit 0**(`All checks passed!`;`Test Files 71 passed | 2 skipped`,`Tests 718 passed | 4 skipped`);本刀單元測試 `vitest run src/runtime/spendguard/transport.test.ts` → **exit 0**,`Tests 9 passed (9)`(對 in-process fake UDS server)。
- [x] depcruise(`depcruise src`)→ **exit 0**(`no dependency violations found, 116 modules`)。**實證封閉**:把 `import "../runtime/spendguard/transport.js"` 注入 core `src/cost/in-memory.ts` → depcruise **exit 2**,同時觸發 `error not-to-internal` **和** `error no-vendor-in-core`(`src/cost/in-memory.ts → src/runtime/spendguard/transport.ts`);還原後 **exit 0**。`grep -rln "@grpc/grpc-js" src` 在 `/runtime/` 之外為 **NONE**。
- [x] fail-closed 經 mutation 驗證:把「空 oneof 的 reserve REJECT」改成 `return { reservationId: "" }`(falsy success)→ `vitest` **exit 1**,`Tests 1 failed | 8 passed`(對應的 empty-oneof fail-closed 測試轉紅);還原後 **exit 0**,`9 passed`。
- [x] credential-blind:`grep -niE "credential|secret|token|password|apikey|bearer" transport.ts` 僅命中 doc-comment 與 grpc-js 自身的 `ChannelCredentials`/`createInsecure`(傳輸層型別,非 wire 上的 secret);req 只帶 `tenant_id`+`amount`+`route`,無 credential 欄。`secret-scan` → `clean`(於 `pnpm run verify` 內)。
- [x] Adversarial review = PASS(獨立 Opus 4.8;R11-S6 通過獨立審查)。

## (7) Rollback
- `git revert <merge-sha>`（移除 `src/runtime/spendguard` 模組）。adapter 退回注入 fake seam,無 runtime 影響。

## (8) Depends-on / blocks
- Depends-on:R11-S5（generated stub）、R11-S3（`SpendGuardCostGate` + `LedgerTransport` seam,已 DONE）、R2-S6（grpc-js 慣例 + dep）。
- Blocks:R11-S7（live e2e 需真實 transport）。
- DAG 無 cycle: ☑
