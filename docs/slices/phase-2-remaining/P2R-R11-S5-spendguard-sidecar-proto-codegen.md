# SLICE-P2R-R11-S5: SpendGuard SidecarAdapter proto TS-stub codegen + drift gate（契約,無消費者）

- **Phase**: P2（R11 SpendGuard live；真實 vendor transport 的契約刀,仿 R2-S5）
- **Branch**: slice/p2r-r11-s5-spendguard-proto-codegen
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 0.5 day；net LOC <~80（codegen/drift script 擴充;生成的 TS stub 為 **generated**,不計）、files <~4、**新增依賴 = TS proto codegen devDependency（已於 R2-S5 在 repo;若沿用則 0 新增）**
- **狀態**: **DRAFT**（build-gated:不需 Docker;只需 SpendGuard proto 來源）

## (1) ID + Title
SLICE-P2R-R11-S5 — 把 SpendGuard 的 **client-facing** `SidecarAdapter` gRPC 契約([`proto/spendguard/sidecar_adapter/v1/adapter.proto:34`](../../../) 的 `service SidecarAdapter`,含 `ReserveSession` :124 / `CommitSessionDelta` :129 / `ReleaseSession` :134 / `ReleaseReservation` :116 + `common/v1/common.proto`)生成 **types-only TS stub**,並加 `proto:check`-式 drift gate,作為 R11-S6 真實 transport 的唯一線格契約來源。

## (2) Goal（一句話）
在引入任何 RPC client 前,先把 TS↔SpendGuard 的型別契約固定 + drift-gated,使 S6 的真實 transport 只依賴生成碼、且 proto 漂移會被 `verify` 擋下(鏡像 R2-S5 對 kernel ingest.proto 的做法)。

## (3) In-scope / Out-of-scope
- In-scope:
  - 從 SpendGuard repo 的 `proto/spendguard/sidecar_adapter/v1/adapter.proto` + `proto/spendguard/common/v1/common.proto`(pinned vendored 子集 + sha256 manifest,鏡像 R1 OpenShell proto pin / R2 ingest pin)生成 types-only TS stub 至 `src/runtime/spendguard/_generated/`。
  - `spendguard:proto:check`(或併入既有 proto-check.sh 的 cascade)：重生成後 diff-clean 才綠;漂移→紅。
  - vendored proto 子集 + pin manifest(只取 SidecarAdapter + 依賴的 message,不取整棵 SpendGuard proto)。
- Out-of-scope（明確不做）:
  - 實際 RPC client / UDS 連線 → S6。
  - 起 SpendGuard runtime / e2e → S7。
  - Ledger 內部服務 proto(`ledger/v1/ledger.proto` 的 `Ledger` service :29)——客戶端只看 SidecarAdapter,ledger 在 sidecar 之後。

## (4) Design delta + 模組 + 介面 + 依賴方向
- **Design delta**:新增 `src/runtime/spendguard/_generated/`(generated)+ pin manifest;codegen/check script。**不**改 core、不引 runtime RPC client(types-only)。
- **依賴方向**:generated stub 自足(types-only);無 core import;`no-vendor-in-core` 不受影響(generated 在 runtime/、非 core)。
- **跨 plane 規則**:TS 與 SpendGuard 只透過 `sidecar_adapter` proto 互動(slice-spec §2)。

## (5) Test-first plan（RED 先行）
- `spendguard:proto:check` 在 stub 尚未生成 / 與 vendored proto 不一致時 → **exit≠0**(RED:drift gate 真的在比對)。
- 生成 + pin 後 → 綠。
- 首次 RED 證據(貼 exit≠0):check 在無生成碼時報缺檔 / drift。

## (6) Definition of Done（待實測填）
- [ ] RED:`pnpm run spendguard:proto:check` 在無/漂移 stub 時 exit≠0。
- [ ] 生成 types-only stub + pin manifest;`spendguard:proto:check` exit 0;併入 `verify` cascade。
- [ ] `pnpm run verify` exit 0;depcruise exit 0(generated 不在 core、無 vendor 進 core)。
- [ ] secret-scan clean。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:改一個 proto 欄位 → drift gate 轉紅)。

## (7) Rollback
- `git revert <merge-sha>`(移除 generated 目錄 + script + pin)。純契約,無 runtime 影響。

## (8) Depends-on / blocks
- Depends-on:R2-S5（codegen 工具/慣例已建）;SpendGuard repo 的 `sidecar_adapter` proto 為來源。
- Blocks:R11-S6（真實 transport import 生成碼）。
- DAG 無 cycle: ☑
