# SLICE-P2R-R11-S9: live SpendGuard 端到端（RequestDecision 路徑,真實 demo）

- **Phase**: P2（R11 SpendGuard live；裁決 (a) 的 live 證明,取代 BLOCKED 的 S7）
- **Branch**: slice/p2r-r11-s9-spendguard-live-e2e-decision
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day（不含 docker build）；net LOC <~190（`scripts/e2e-live-spendguard.sh` + `src/cost/adapters/spendguard/live-spendguard.e2e.test.ts` + package.json 一行）、新增依賴 = 0
- **狀態**: **PARTIAL-LIVE / 待設計裁決**（live 整合已**實際對真實 sidecar 跑過**並推進到下述 ground-truth;完整 CONTINUE 待一個設計決定，見「Live ground-truth」）

> ## ✅/⏸ Live ground-truth（2026-06-22,真實對跑著的 SpendGuard demo 驗證,非偽造）
> 真實 demo 已起(`docker compose up --build`,OrbStack:postgres+ledger+sidecar+endpoint-catalog+canonical-ingest+run-cost-projector 全 healthy,sidecar log「adapter UDS listener bound」)。在 sidecar-adjacent 容器(uid 65532、掛 UDS volume)用**我們編譯後的 `createDecisionLedgerTransport`+`SpendGuardCostGate`** 對**真實 UDS** 跑,**已證明**:
> - **連線 + 認證成立**:peercred 通過、gRPC 線格相容、`Handshake` 被接受(送對 `tenant_id_assertion`)、`RequestDecision` 被真實 sidecar 執行。
> - **fail-closed 對真貨成立**:transport error → `denied`(從不 allow)——多次觀測。
> - **live 抓出 3 個 fake 遮蔽的真 bug**:(1) 編碼器漏 `tenant_id_assertion`(field 5)、(2) 缺 `idempotency.key`(field 9)——**已修並 merge**(R11-S8 fix,獨立 Opus 4.8 review PASS,mutation 非 vacuous);(3) `inputs.projected_claims must be non-empty`——**未修,即下述裁決**。
>
> ### ⏸ 待人工裁決(完整 CONTINUE 的前置)
> 真實 sidecar 的 `RequestDecision` 要求**明確的 projected `BudgetClaim`**(budget_id / `UnitRef`.unit_id / amount / direction / window_instance_id),且 ledger 會對 demo seeded 預算(budget `44444444-…`、unit、window、fencing scope `33333333-…`)驗證。但我們**刻意極簡、credential-blind 的 `{route, amount}` CostGate port 不帶這些**。三選一(你定):
> - **(a)** transport 把 `route → budget_id/unit/window` 映射(更耦合 SpendGuard 預算模型、deployment-specific;需擴 encoder 編 repeated 巢狀 BudgetClaim+UnitRef)。
> - **(b)** 用 sidecar contract/manifest 能解析成預算的 **configured route**(讓 sidecar server-side 解析 budget;需確認 demo 是否支援空 claims + 路由解析)。
> - **(c)** 視「連線+認證+fail-closed 已證明」為 S9 的 live 里程碑,完整 budget-backed CONTINUE 歸後續(等路由/預算映射定案)。
> > 註(R11-S8 fix MINOR):目前每次 reserve 用 fresh `randomUUID` idempotency key,未利用 sidecar 的跨重試 replay;crash-retry 同一邏輯 reserve 會鑄新 decision。後續 resume 工作再處理。

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
