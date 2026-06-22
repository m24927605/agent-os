# SLICE-P2R-R11-S9: live SpendGuard 端到端（RequestDecision 路徑,真實 demo）

- **Phase**: P2（R11 SpendGuard live；裁決 (a) 的 live 證明,取代 BLOCKED 的 S7）
- **Branch**: slice/p2r-r11-s9-spendguard-live-e2e-decision
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day（不含 docker build）；net LOC <~190（`scripts/e2e-live-spendguard.sh` + `src/cost/adapters/spendguard/live-spendguard.e2e.test.ts` + package.json 一行）、新增依賴 = 0
- **狀態**: **DRAFT**（**需 Docker — 已確認 OrbStack `unix:///var/run/docker.sock` 活著**;`make demo-up` 從源碼 build ~8 Rust 服務,opt-in、不入 `verify`）

## (1) ID + Title
SLICE-P2R-R11-S9 — 用 SpendGuard demo topology([`deploy/demo/compose.yaml`](../../../))起真實 sidecar+ledger+Postgres,把 R11-S8 的 `createDecisionLedgerTransport` 注入 `SpendGuardCostGate`,對**真實跑著的 SpendGuard sidecar**(經已實作的 `RequestDecision`/`ConfirmPublishOutcome`)做 reserve/commit,證明成本閘在真實 vendor runtime 上 CONTINUE→放行、STOP→hard-cap deny、fail-closed、credential-blind。鏡像 R2-S8(kernel live e2e)。

## (2) Goal（一句話）
兌現 SpendGuard 真實 runtime 整合(走 demo 實際實作的閘):`SpendGuardCostGate` 對真貨 reserve-before-effect、超預算 hard-cap deny、commit settle——不再是注入 double,也不是對著 vendor 未實作的 RPC。

## (3) In-scope / Out-of-scope
- In-scope:
  - `scripts/e2e-live-spendguard.sh`:hermetic harness——(a) **docker 前置**:`docker info`(若需,設 `DOCKER_HOST=unix:///var/run/docker.sock` 指向 OrbStack;daemon 不可達 → 明確 FAIL+非 0);(b) `docker compose -f deploy/demo/compose.yaml up -d --build`(有界等待 sidecar+ledger healthy);(c) **UDS 可達性**(見 §4);(d) 跑 gated e2e;(e) **trap** `docker compose down -v` + 清理,無論成敗;(f) 退出碼 = e2e。
  - `live-spendguard.e2e.test.ts`(gated on `AGENTOS_LIVE_SPENDGUARD_UDS`,未設→skip,保持 `verify` hermetic),用 `SpendGuardCostGate(createDecisionLedgerTransport({udsPath}))`:
    - 預算內 reserve(小 estimate)→ decision CONTINUE → `status:"ok"`+reservationId;commit → committed。
    - **超預算** reserve(大 estimate / 連續耗盡)→ decision STOP/STOP_RUN_PROJECTION → `denied`(hard-cap;runaway 不能 bankrupt 租戶)。
    - **fail-closed**:sidecar 關閉後 reserve → denied(transport error)。
    - **credential-blind**:帶 secret canary 的 route/ctx → 真實 sidecar 不回該明文、e2e 斷言 DecisionRequest 不含 credential。
  - `package.json`:`"e2e:live-spendguard": "bash scripts/e2e-live-spendguard.sh"`。
- Out-of-scope:
  - 併入 `verify`(verify 須 hermetic、不 build docker)。
  - mTLS/SPIFFE prod 路徑;ReleaseReservation→CostGate.release(R12)。
  - SpendGuard 內部服務正確性(vendor 自有測試)。

## (4) Design delta + 關鍵抉擇（UDS 可達性 + handshake + demo 設定）
- **Design delta**:純 e2e + harness;不改 runtime/核心(消費 S8 transport + 既有 adapter)。
- **UDS 可達性(同 S7 §4,主推 (a))**:sidecar UDS 在容器內 + SO_PEERCRED peer-uid([`config.rs:114-120`](../../../))。**(a)** 在同 compose network 內以 sidecar-adjacent 容器跑 e2e(bind-mount UDS volume + 對齊 peer-uid);(b) bind-mount 到 host;(c) HTTP companion。開工第一步對真實 demo 定案。
- **handshake/session 前置**:`RequestDecision` 需先 `Handshake` 建 session_id(adapter_uds.rs:73);transport(S8)已處理,e2e 確認真實 handshake 通過。
- **demo 啟動依賴**:sidecar 需 bundles/manifest verify key/endpoint-catalog(init 容器 pki/pricing/bundles/manifest 提供);harness 依 compose 既有 wiring,不另造 cert。

## (5) Test-first plan（RED 先行）
- 先寫 e2e;`AGENTOS_LIVE_SPENDGUARD_UDS=<path> vitest run …` 對**未起**的 sidecar → 連線 refused → reserve deny/throw → 測試 FAIL(exit≠0)(RED:真打真實 sidecar)。
- `make demo-up` 起真實 SpendGuard 後 → 綠。

## (6) Definition of Done（待實測填）
- [ ] RED:UDS 指向未起 sidecar → e2e FAIL(exit≠0)。
- [ ] `pnpm run e2e:live-spendguard` exit 0:真實 `docker compose up --build` → handshake → reserve(CONTINUE)ok、超預算 STOP deny、commit、fail-closed、canary 不在真實回應/audit → `docker compose down -v` 清理。
- [ ] `pnpm run verify` 仍 exit 0(gated e2e SKIP)。
- [ ] secret-scan clean;depcruise exit 0。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:STOP 當 allow→hard-cap 測試紅;sidecar-down 當成功→fail-closed 測試紅;確認對真實 sidecar、非 fake)。
- [ ] **若 docker build 失敗 / sidecar 起不來 / UDS 不可達**:誠實標 BLOCKED + 具體 blocker,不偽造綠、不弱化測試(looping-engineering §4)。

## (7) Rollback
- `git revert <merge-sha>`(移除 e2e + harness + package.json 一行)。可逆。

## (8) Depends-on / blocks
- Depends-on:R11-S8（decision transport）;**外部:Docker(OrbStack,已確認活)+ SpendGuard demo 可 build**。
- Blocks:無(收尾 SpendGuard 真實成本閘 live 證明)。
- DAG 無 cycle: ☑
- **誠實前提**:SpendGuard 是第三方多服務 Rust+Postgres 系統,起它是重 infra;本刀只在 demo 成功 build+起時可綠,否則 fail-closed BLOCKED。
