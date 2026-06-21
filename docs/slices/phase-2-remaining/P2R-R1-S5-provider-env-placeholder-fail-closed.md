# SLICE-P2R-R1-S5: GetSandboxProviderEnvironment placeholder-only（fail-closed shape guard）

- **Phase**: P2（ITEM R1 — live OpenShell substrate adapter）
- **Branch**: slice/p2r-r1-s5-provider-env-placeholder-fail-closed
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: 估計 <= 1 day；預期 net LOC <~120、files <~3、modules = 1（`runtime/openshell`）；新增第三方依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R1-S5 — 新增 `getProviderEnvironment`：呼 `GetSandboxProviderEnvironment`（openshell.proto:153），**只**搬運 placeholder-bearing env（openshell.proto:1141-1152），以 **fail-closed shape guard** 拒絕任何看似 raw secret 的 value——credential 真值永遠由 OpenShell `SecretResolver` 在 egress 注入（secrets.rs:87/214），絕不經我方落地。

## (2) Goal（一句話）
讓 Agent OS 能取得 sandbox 的 provider-env **placeholder**（供注入點知道有哪些 credential slot），同時用 fail-closed shape guard 結構性保證**真值絕不被我方持有或落地**。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/runtime/openshell/provider-env.ts`：純函式 `assertPlaceholderOnly(env: Record<string,string>): Record<string,string>`——逐一檢查 value，**任一 value 不符 placeholder 形態（含偵測到 reserved credential marker 卻非合法 placeholder，對映 secrets.rs:30 `contains_reserved_credential_marker` 的意圖）即 throw**（fail-closed），合格才回傳。
  - adapter 方法 `getProviderEnvironment(ctx, sandboxId)`：壞 ctx / 未知 id → deny；呼 RPC → 取 `environment`（openshell.proto:1143）→ 過 `assertPlaceholderOnly` → 回 placeholder env + `providerEnvRevision`（openshell.proto:1145）。guard throw → deny（不回任何 env）。
  - `OpenShellTransport` 擴 `getSandboxProviderEnvironment(req)`。
  - placeholder 形態判定做成**保守 allowlist，錨在共同前綴 `openshell:resolve:env:`**（VERIFIED：secrets.rs:9 `PLACEHOLDER_PREFIX`；`placeholder_for_env_key_for_revision` secrets.rs:487-493 證實**兩種合法形**：revision==0→`openshell:resolve:env:<KEY>`、revision!=0→`openshell:resolve:env:v<rev>_<KEY>`，guard **兩形皆須接受**，不可只認 `v<rev>_` 否則誤拒 revision-0 placeholder）；不符前綴者一律當可疑 → fail-closed。
- Out-of-scope（明確不做）:
  - 解析 / 還原 placeholder 成真值（永遠是 SecretResolver 的事，design §2.3/§6）。
  - `dynamic_credentials`（openshell.proto:1151）/ `credential_expires_at_ms`（openshell.proto:1147）的消費 → 不做（只透傳 revision；動態憑證留後續 R4 CredentialLease）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: adapter 多一個 provider-env 取得能力，且以 shape guard 把「credentials never on disk」做成**結構性 fail-closed**，不信任後端。
- **Modules touched（唯一責任）**:
  - `src/runtime/openshell/provider-env.ts` — **唯一責任**：placeholder-only shape guard（純函式，無 I/O）。
  - `src/runtime/openshell/adapter.ts` — **唯一責任（延伸）**：把 RPC 結果過 guard 後回傳；不解析真值、不落地、不 append audit。
- **PUBLIC interface（新增/變更）**:
  - `function assertPlaceholderOnly(env: Readonly<Record<string,string>>): Record<string,string>`（throw on 可疑 value）。
  - `OpenShellSandboxAdapter.getProviderEnvironment(ctx: unknown, sandboxId: string): Promise<{ status:"ok"; env: Record<string,string>; revision: string; event: SandboxLifecycleEvent } | { status:"denied"; reason: string; event: SandboxLifecycleEvent }>`
  - `OpenShellTransport` 擴 `getSandboxProviderEnvironment`。
- **Dependency direction（low coupling 自證）**:
  - 箭頭圖:
    ```
    runtime/openshell/adapter.ts      ──▶ runtime/openshell/provider-env.ts (同模組)
    runtime/openshell/adapter.ts      ──▶ runtime/substrate (barrel: deny/ok/event)
    runtime/openshell/provider-env.ts ──▶ (無外部依賴；純函式)
    ```
  - 僅經 public surface 消費（無 deep import）: ☑ 是
  - 新依賴宣告: 無。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/runtime/openshell/provider-env.test.ts`（+ adapter 整合一條）
- RED 測試清單:
  - [ ] `assertPlaceholderOnly({A:"openshell:resolve:env:v3_TOKEN"})`（revision!=0 形）通過、原樣回傳。
  - [ ] `assertPlaceholderOnly({A:"openshell:resolve:env:TOKEN"})`（**revision==0 形，無 `v0_`**）通過、原樣回傳（防「只認 v<rev>_ 而誤拒 revision-0 placeholder」的回歸）。
  - [ ] 安全對抗式（核心）：`assertPlaceholderOnly({A:"sk-live-<runtime canary>"})` **throw**（看似 raw secret，fail-closed）。
  - [ ] 安全對抗式：value 含 reserved credential marker 但非合法 placeholder → throw。
  - [ ] adapter `getProviderEnvironment` 未知 id → denied，未呼 RPC。
  - [ ] adapter 收到帶 raw value 的 env（guard throw）→ `denied`，**回傳物件不含任何 env**（真值不外洩）。
  - [ ] adapter 收到全 placeholder env → `ok`，回 placeholder + revision（revision 為非 secret 數字字串）。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/runtime/openshell/provider-env.test.ts
  ... FAIL（assertPlaceholderOnly / getProviderEnvironment 未實作）...
  exit code: <填實測>
  ```
> 測試 raw-secret canary **在 runtime 組裝**（不入 fixture 檔字面值），符合 phase-2/INDEX §鐵律「測試 secret canary 為 runtime 組裝、無 source 字面值」。

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: <填實測>
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；`no-vendor-in-core` 仍綠）
- [ ] low coupling / high cohesion 遵守（provider-env.ts 純函式、無 I/O；無新跨 module / cyclic 依賴）
- [ ] secret-scan 乾淨（**關鍵**：guard 測試的 raw-secret canary 為 runtime 組裝，source/log/snapshot 無 secret-like 字面值）
- [ ] Docs 更新（design §2.3/§6 credential chokepoint 與實作一致）
- [ ] Adversarial code review = PASS（fresh-context）— 連結/摘要: <填>
- [ ] **Independent Verifier Pass（安全不變量類）**：adversarially probe「任何 raw-secret-shape value ⇒ guard throw ⇒ adapter deny 且回傳無 env；真值永不出現在 result / log / event」（credential non-leak）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 provider-env 能力與 guard）。
- 可逆性: 安全可逆——唯讀觀測、無 audit append；回退不會洩露任何已取得真值（本 slice 從不持有真值）。

## (8) Depends-on / blocks
- Depends-on: **P2R-R1-S1**（只需 client + transport；不需 create/對映，因 provider-env 以 sandbox_id 直接查）。
- Blocks: P2R-R1-S6（contract）；後續 R4 CredentialLease（消費 placeholder slot 資訊）。
- 確認 slice DAG 無 cycle: ☑ 是（S5 rank 1，僅依賴 S1；與 S2/S3/S4 互不相依）
