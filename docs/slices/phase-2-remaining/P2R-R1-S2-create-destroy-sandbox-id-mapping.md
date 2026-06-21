# SLICE-P2R-R1-S2: createSandbox（+ destroySandbox via DeleteSandbox）+ name↔SandboxId 對映

- **Phase**: P2（ITEM R1 — live OpenShell substrate adapter）
- **Branch**: slice/p2r-r1-s2-create-destroy-sandbox-id-mapping
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: 估計 <= 1 day；預期 net LOC <~160、files <~3、modules = 1（`runtime/openshell`）；新增第三方依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R1-S2 — 新增 `OpenShellSandboxAdapter`（implements `SandboxAdapter`），實作 `createSandbox`（呼 `CreateSandbox`，openshell.proto:25）與 `destroySandbox`（呼 `DeleteSandbox`，openshell.proto:46），並維護 **OpenShell name ↔ 我方 `SandboxId` in-memory 對映**。

## (2) Goal（一句話）
讓 Agent OS 能透過 OpenShell 真實**建立**一個 pinned-image sandbox 並拿到我方 `SandboxId`，且能依對映**銷毀**它，全程 fail-closed、永不 throw 跨 port 邊界。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/runtime/openshell/adapter.ts`：`class OpenShellSandboxAdapter implements SandboxAdapter`（首次出現）。
  - `createSandbox(ctx, spec)`：壞 ctx → `deny`（fail-closed）；image 非 pinned digest（`assertPinnedImageDigest`）→ `deny`；組 `CreateSandboxRequest{spec.template.image=PINNED, name, labels}`（openshell.proto:427-433/333-335）→ 收 `SandboxResponse.sandbox.metadata`（openshell.proto:488-490/296-306）→ 產生我方 `SandboxId`、存入 `Map<SandboxId, openshellName>` → `ok`。
  - `destroySandbox(ctx, sandboxId)`：壞 ctx / 未知 id（對映遺失）→ `deny`；否則用對映的 OpenShell name 呼 `DeleteSandbox`（openshell.proto:46）→ `ok` 並移除對映。
  - 把 `OpenShellTransport`（S1）擴出 `createSandbox`/`deleteSandbox` 兩個 unary 原語（含 deadline）。
- Out-of-scope（明確不做）:
  - `start/stop` shim → S6（與接 contract 一起）。
  - readiness（GetSandbox/Watch）→ S3；exec → S4；provider-env → S5。
  - 持久化對映、逾時後 reconciliation → 留給 R8（見 design §6/§7）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 出現第一個 implements `SandboxAdapter` 的真實 adapter；新增 in-memory 對映狀態；create/destroy 兩個 RPC 接上。
- **Modules touched（唯一責任）**:
  - `src/runtime/openshell/adapter.ts` — **唯一責任**：把 `SandboxAdapter` create/destroy 語義翻譯成 OpenShell RPC + 維護 id 對映；不含 policy 決策（policy 在 PDP）、不注入 credential、不 append audit。
- **PUBLIC interface（新增/變更）**:
  - `class OpenShellSandboxAdapter implements SandboxAdapter`（建構子注入 `OpenShellTransport`）— 本 slice 只填 `createSandbox`/`destroySandbox`，其餘方法 S3/S4/S6 補。
  - `OpenShellTransport` 擴：`createSandbox(req): Promise<SandboxResponse>`、`deleteSandbox(req): Promise<DeleteSandboxResponse>`（皆帶 deadline，失敗 reject 由 adapter 轉 deny）。
- **Dependency direction（low coupling 自證）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    runtime/openshell/adapter.ts ──▶ runtime/substrate (barrel: SandboxAdapter/AdapterResult/deny/ok)
    runtime/openshell/adapter.ts ──▶ runtime/openshell/client.ts (同模組: transport, PINNED image)
    runtime/openshell/adapter.ts ──▶ iam/ids (SandboxId, AgentContext)  [interim allowlist]
    ```
  - 僅經 public surface 消費（無 deep import）: ☑ 是（substrate 經 barrel `index.js`；不 deep-import `substrate/port.ts` 以外內部）
  - 新依賴宣告: 無第三方新依賴；新增 module→module 依賴 `runtime/openshell → runtime/substrate`：方向=adapter→adapter-port（inward）、cycle=無（substrate 不 import openshell）、理由=adapter 必須 implements port。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/runtime/openshell/adapter.create.test.ts`（用 S1 的 transport double 注入）
- RED 測試清單:
  - [ ] create 壞 ctx（非法 AgentContext）→ `status:"denied"`、event `contextError` set，**未呼 CreateSandbox**（fail-closed）。
  - [ ] create image 非 `sha256:` digest → `denied`，未呼 RPC（pinned-only）。
  - [ ] create 成功（double 回帶 metadata.name 的 SandboxResponse）→ `status:"ok"`、回 schema-valid `SandboxId`、event.result==="ok"。
  - [ ] destroy 未知 id（對映無）→ `denied`，**未呼 DeleteSandbox**（deny-by-default）。
  - [ ] destroy 已建 id → 呼 `DeleteSandbox(name=對映值)`、`ok`、對映移除（再 destroy 同 id → denied）。
  - [ ] 安全對抗式：transport `createSandbox` reject（逾時/連線錯）→ adapter 回 `denied`、**不 throw**、reason 不含 baseUrl/credential。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/runtime/openshell/adapter.create.test.ts
  ... FAIL（OpenShellSandboxAdapter 不存在 / createSandbox 未實作）...
  exit code: 1
  ```
  （GREEN 後同檔 `pnpm test src/runtime/openshell/adapter.create.test.ts` → 10 passed，exit 0。）

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5；adapter.create.test.ts 10 tests）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... Test Files  26 passed (26) / Tests  189 passed (189) ...
  ... no dependency violations found / secret-scan: clean ...
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；54 modules / 109 deps，no violations；substrate 僅經 barrel 消費；`no-vendor-in-core` 仍綠 — verify 內 6 tests passed）
- [x] low coupling / high cohesion 遵守（無新第三方依賴；adapter 不含 policy/credential/audit 邏輯）
- [x] secret-scan 乾淨（`secret-scan: clean`，exit 0；adapter / 測試替身無 secret-like 值；對映只存 name 字串）
- [x] Docs 更新（design §3.3 name↔Id 對映與實作一致 — 見 adapter-openshell-substrate.md「S2 實作對齊（DONE）」）
- [x] Adversarial code review = PASS（fresh-context、非作者、獨立 Opus 4.8；findings 已解 — slice S2 通過 independent review）
- [x] Independent Verifier Pass：probe「壞 ctx / 非 digest image / 未知 id / transport reject ⇒ 一律 deny 且不呼對應寫 RPC、不 throw、不洩密」（adapter.create.test.ts 對抗式案例綠）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`。
- 可逆性: 含**外部副作用**（CreateSandbox / DeleteSandbox 會在真實 gateway 留資源）。回退僅移除 client 程式碼，**不會**自動清理已建 sandbox；forward-fix 策略：以 `destroySandbox`/手動 `DeleteSandbox` 清理孤兒（對映遺失場景見 design §7 風險 1）。R1 內**無 audit append**，故無歷史改寫問題。

## (8) Depends-on / blocks
- Depends-on: **P2R-R1-S1**（需 client + transport + PINNED image + `assertPinnedImageDigest`）。
- Blocks: P2R-R1-S3、P2R-R1-S4（皆需先有 sandbox 與對映）、P2R-R1-S6（contract 需 create/destroy）。
- 確認 slice DAG 無 cycle: ☑ 是（S2 rank 1，僅依賴 S1）
