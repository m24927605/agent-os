# SLICE-P2R-R11-S7: live SpendGuard 端到端（docker-compose demo 起真實 sidecar+ledger+Postgres → 真實 reserve/commit）

- **Phase**: P2（R11 SpendGuard live；真實 runtime e2e,仿 R2-S8 的 harness 模式）
- **Branch**: slice/p2r-r11-s7-spendguard-live-e2e
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day（**不含** docker build 時間）；net LOC <~180（`scripts/e2e-live-spendguard.sh` + `src/cost/adapters/spendguard/live-spendguard.e2e.test.ts` + package.json 一行）、新增依賴 = 0
- **狀態**: **DRAFT**（**BUILD-GATED:需 Docker daemon 運行**;`make demo-up` 從源碼 build ~8 個 Rust 服務 + Postgres + sidecar,屬重 infra,故 e2e opt-in、絕不入 `verify`）

## (1) ID + Title
SLICE-P2R-R11-S7 — 用 SpendGuard 自帶的 demo topology([`deploy/demo/compose.yaml`](../../../):`docker compose up -d --build` 起 postgres:16 + ledger + sidecar + canonical_ingest + tokenizer + … ~8 Rust 服務),把 R11-S6 的真實 `createSidecarLedgerTransport` 注入 `SpendGuardCostGate`,對**真實跑著的 SpendGuard sidecar**(UDS)做 reserve/commit,證明成本閘在真實 vendor runtime 上 fail-closed + credential-blind + hard-cap。鏡像 R2-S8(kernel)的 build-spawn-run-teardown harness。

## (2) Goal（一句話）
兌現 SpendGuard 的真實 runtime 整合:`SpendGuardCostGate` 對**真貨**(真實 Rust ledger + Postgres,經 sidecar)reserve-before-effect、over-budget hard-cap deny、overrun 記錄並封住後續——不再是注入 double。

## (3) In-scope / Out-of-scope
- In-scope:
  - `scripts/e2e-live-spendguard.sh`:hermetic harness——(a) 前置檢查 `docker info`(daemon 未跑 → 明確 FAIL 訊息 + 非 0,不偽裝);(b) `docker compose -f deploy/demo/compose.yaml up -d --build` 起 base stack(有界等待 ledger+sidecar healthy);(c) 解決 **UDS 可達性**(見 §4 設計抉擇);(d) 跑 gated e2e;(e) **trap** `docker compose down -v` + 清理,**無論成敗**;(f) 退出碼 = e2e 碼。
  - `live-spendguard.e2e.test.ts`(gated on `AGENTOS_LIVE_SPENDGUARD_UDS`,未設→`describe.skip`,保持 `verify` hermetic):
    - reserve 在預算內 → `status:"ok"` + reservationId;commit(actual)→ committed。
    - reserve **over budget** → `denied`(hard-cap;runaway 不能 bankrupt 租戶,port.ts:7-9)。
    - commit **overrun** → `overrun:true` 記錄,且**之後**每個 reserve → denied(budgetBlown,adapter.ts:73-74/147)。
    - **fail-closed**:sidecar 關閉後 reserve → denied(transport error;adapter.ts:100-107)。
    - **credential-blind**:帶 secret canary 的 ctx/route → 真實 ledger/audit **不含**該明文(SpendGuard egress 只見 redacted;adapter.ts:23-25)。
  - `package.json`:`"e2e:live-spendguard": "bash scripts/e2e-live-spendguard.sh"`。
- Out-of-scope（明確不做）:
  - 把 e2e 併入 `verify`(verify 須 hermetic、不 build docker / 起 Postgres)。
  - mTLS/SPIFFE prod 路徑(demo 用 UDS,config.rs §「never this local-UDS path」指 prod);ReleaseSession(R12)。
  - SpendGuard 內部服務正確性(那是 vendor 的測試,非本刀)。

## (4) Design delta + 關鍵抉擇（UDS 可達性 + peercred）
- **Design delta**:純 e2e 測試 + harness;**不**改 runtime/核心(消費 S6 的 transport + 既有 adapter)。
- **關鍵抉擇(開工時對真實 demo config 定案)**:sidecar 的 UDS 在容器內、且 **SO_PEERCRED peer-uid 強制**([`config.rs:114-120`](../../../),fail-closed)。host 上的 TS 測試直接連該 UDS 多半被 peercred 拒。三選一,**主推 (a)**:
  - **(a) 在同 compose network 內以一個 sidecar-adjacent 容器跑 e2e**:bind-mount sidecar 的 UDS volume + 對齊 peer-uid(最忠於「in-pod adapter over UDS」模型;peercred 通過)。
  - (b) host 連:把 UDS bind-mount 到 host + demo 放寬/對齊 peercred uid(較簡單但偏離 prod 形狀)。
  - (c) 改用 sidecar 的 **HTTP companion listener**(axum+rustls,[`config.rs:196-198`](../../../))——但需 TLS cert,較重。
  > 開工第一步:讀 demo sidecar entrypoint + compose volume,確認哪條在 demo 可行,寫進實作前更新本節。
- **封閉**:e2e 檔屬 `*.test.ts`(depcruise 排除);harness 是 script;grpc-js/vendor 仍只在 `src/runtime/spendguard`(S6)。

## (5) Test-first plan（RED 先行）
- 先寫 e2e;`AGENTOS_LIVE_SPENDGUARD_UDS=<path> vitest run …` 對**未起**的 SpendGuard → 連線 refused → reserve reject/deny → 測試 **FAIL(exit≠0)**(RED:真打真實 sidecar)。
- `make demo-up` 起真實 SpendGuard 後 → 綠。
- 首次 RED 證據:UDS 設了但 sidecar 沒起 → transport error → denied/throw。

## (6) Definition of Done（待實測填）
- [ ] RED:UDS 指向未起 sidecar → e2e FAIL(exit≠0)。
- [ ] `pnpm run e2e:live-spendguard` exit 0:真實 `docker compose up --build` 起 SpendGuard → reserve/commit 真跑 → over-budget deny、overrun 封後續、fail-closed、credential canary 不在真實 ledger/audit → `docker compose down -v` 清理。
- [ ] `pnpm run verify` 仍 exit 0(gated e2e SKIP;verify 不 build docker)。
- [ ] secret-scan clean;depcruise exit 0。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:把 over-budget 當 allow → hard-cap 測試紅;sidecar-down 當成功 → fail-closed 測試紅;確認對真實 sidecar、非 fake)。
- [ ] **若 Docker 不可用或 build 失敗**:誠實標 `BLOCKED` + 具體 blocker(daemon down / Rust build error / peercred),**不偽造綠**、不弱化測試(fail-closed 升級,見 looping-engineering §4)。

## (7) Rollback
- `git revert <merge-sha>`(移除 e2e + harness + package.json 一行)。純測試/harness,可逆。

## (8) Depends-on / blocks
- Depends-on:R11-S6（真實 UDS transport）、R11-S3（`SpendGuardCostGate`,DONE）;**外部:Docker daemon + SpendGuard demo 可 build**。
- Blocks:無(收尾真實 vendor 成本閘的 live 證明)。
- DAG 無 cycle: ☑
- **誠實前提**:不同於 kernel(R2-S8,自有靜態 binary、秒建),SpendGuard 是第三方多服務 Rust+Postgres 系統,起它是重 infra;本刀只在 Docker 就緒時可綠,否則 fail-closed BLOCKED。
