# SLICE-P2R-R1-S3: GetSandbox / WatchSandbox readiness（phase → ok/deny）

- **Phase**: P2（ITEM R1 — live OpenShell substrate adapter）
- **Branch**: slice/p2r-r1-s3-getsandbox-watch-readiness
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: 估計 <= 1 day；預期 net LOC <~140、files <~3、modules = 1（`runtime/openshell`）；新增第三方依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R1-S3 — 為 `OpenShellSandboxAdapter` 加一個 **readiness 探測**：用 `GetSandbox`（openshell.proto:28）一次性查 `SandboxStatus.phase`（openshell.proto:378/401-408），並用 `WatchSandbox`（openshell.proto:190，`stop_on_terminal`）等到 READY/ERROR 終態，把 phase 映成 fail-closed 的 ok/deny。

## (2) Goal（一句話）
讓上層能可靠判斷一個已建 sandbox 是否 **READY 可執行**，未知/非終態/ERROR/stream 斷皆 **fail-closed 視為未就緒**。

## (3) In-scope / Out-of-scope
- In-scope:
  - `awaitReady(ctx, sandboxId, opts)` 方法（adapter 上的 readiness helper，非 `SandboxAdapter` port 四方法之一——port 不變）。
  - `GetSandbox`：用對映的 OpenShell name 查 `SandboxResponse.sandbox.status.phase`；`READY(2)`→ok、`ERROR(3)`→deny、其餘→pending。
  - `WatchSandbox`（server-stream，`stop_on_terminal=true`）：消費 `SandboxStreamEvent.sandbox` 快照直到 READY/ERROR 或 deadline；deadline/stream error/非預期關閉 → **deny（未就緒）**。
  - `OpenShellTransport` 擴 `getSandbox(req)` + `watchSandbox(req): AsyncIterable<SandboxStreamEvent>`。
- Out-of-scope（明確不做）:
  - 把 readiness 變成 port 的公共方法（port 形狀凍結於 P2-A；readiness 是 adapter-internal helper，由 S6/上層消費）。
  - log/event 追蹤（`follow_logs`/`follow_events`，openshell.proto:768-772）→ 不做。
  - exec（S4）、provider-env（S5）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: adapter 多一個 readiness 能力；phase enum → ok/deny 映射規則固定且 deny-by-default（未知 enum 值 → pending/deny，永不當 READY）。
- **Modules touched（唯一責任）**:
  - `src/runtime/openshell/adapter.ts` — **唯一責任（延伸）**：把 OpenShell 的 phase 觀測翻譯成 fail-closed readiness；不新增 policy/credential/audit 責任。
- **PUBLIC interface（新增/變更）**:
  - `OpenShellSandboxAdapter.awaitReady(ctx: unknown, sandboxId: string, opts: { deadlineMs: number }): Promise<AdapterResult>`（用既有 `deny/ok`；lifecycle 標記 `"start"` 或新增一個 readiness lifecycle—與 P2-A `SandboxLifecycle` 對齊，不擴 enum 則複用 `"start"` 語義並於 reason 註明）。
  - `OpenShellTransport` 擴 `getSandbox`/`watchSandbox`。
- **Dependency direction（low coupling 自證）**:
  - 箭頭圖:
    ```
    runtime/openshell/adapter.ts ──▶ runtime/substrate (barrel)
    runtime/openshell/adapter.ts ──▶ runtime/openshell/client.ts (同模組)
    ```
  - 僅經 public surface 消費（無 deep import）: ☑ 是
  - 新依賴宣告: 無（沿用 S2 既有依賴邊）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/runtime/openshell/adapter.readiness.test.ts`
- RED 測試清單:
  - [ ] GetSandbox 回 `phase=READY(2)` → `awaitReady` `ok`。
  - [ ] GetSandbox 回 `phase=ERROR(3)` → `denied`（reason 註記 ERROR phase）。
  - [ ] GetSandbox 回 `phase=PROVISIONING(1)` 後 Watch 推 READY 快照（`stop_on_terminal`）→ `ok`。
  - [ ] Watch deadline 到仍未 READY → `denied`（未就緒，fail-closed）。
  - [x] 安全對抗式：未知 phase 值（如 99）/ stream 提前 error 關閉 / 未知 sandboxId（對映無）→ **一律 denied，永不誤判 READY**（deny-by-default）。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/runtime/openshell/adapter.readiness.test.ts
  ... FAIL（awaitReady 未實作）...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... verify:py: skip / secret-scan: clean / verify:go: ok
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；`no-vendor-in-core` 仍綠）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (54 modules, 109 dependencies cruised)
  exit code: 0
  ```
- [x] low coupling / high cohesion 遵守（無新跨 module / cyclic 依賴；變更僅限 runtime/openshell）
- [x] secret-scan 乾淨（`secret-scan: clean`，含於 verify exit 0）
- [x] Docs 更新（design §3.4 readiness/timeout 預算與實作一致）
- [x] Adversarial code review = PASS（fresh-context）— 摘要: S3 通過獨立評審，readiness 全失敗路徑 fail-closed。
- [x] Independent Verifier Pass：probe「未知 phase / stream error / deadline / 未知 id ⇒ 一律 deny，never-READY 反例驗證」（adapter.readiness.test.ts 13 tests passed）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 readiness helper 與兩個 transport 原語）。
- 可逆性: 安全可逆——readiness 是**唯讀**觀測，無外部副作用、無 audit append。

## (8) Depends-on / blocks
- Depends-on: **P2R-R1-S2**（需 adapter + name↔Id 對映）。
- Blocks: P2R-R1-S6（contract / 上層常在 exec 前 awaitReady）。
- 確認 slice DAG 無 cycle: ☑ 是（S3 rank 2，僅依賴 S2；與 S4/S5 互不相依）
