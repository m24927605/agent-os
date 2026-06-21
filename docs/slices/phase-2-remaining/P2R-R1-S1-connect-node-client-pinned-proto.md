# SLICE-P2R-R1-S1: connect-node OpenShell client + pinned proto/image-digest

- **Phase**: P2（ITEM R1 — live OpenShell substrate adapter，第一刀：連線契約）
- **Branch**: slice/p2r-r1-s1-connect-node-client-pinned-proto
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: 估計 <= 1 day；預期 net LOC <~180（**不含 proto 生成碼**，slice-spec §3）、files <~5、modules = 1（`runtime/openshell`）；**新增第三方依賴 = connect-node（本 slice 唯一目的之一，依 slice-spec §3「依賴變更單獨成 slice」）**
  > **拆分閘（size guard）**：本 slice 的單一意圖＝「釘住連線契約（pinned proto + image digest）並立一個 fail-closed client」。若 proto codegen 工具鏈接線（buf/protoc-gen-es config + `package.json` codegen script）本身手寫超過 ~60 LOC 或讓 files 逾 6 / 估時逾 1 天，**必須把「proto 子集 vendoring + codegen 接線 + `openshell:proto:check`」獨立成 S1a，client.ts + Health + image-digest 留 S1b**（slice-spec §3 硬上限）。
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R1-S1 — 在 `src/runtime/openshell/` 建立 connect-node gRPC client 與 **pinned proto 子集 + pinned image digest**，提供一個 `Health` 健檢與一個可被後續 slice 注入的 transport 介面。**不**實作任何 sandbox 生命週期操作。

## (2) Goal（一句話）
讓 Agent OS 能對著一個 **pinned 契約（proto 子集 + image digest）** 建立一個 fail-closed、可注入測試替身的 OpenShell client，並用 `Health` 證明連線層可用。

## (3) In-scope / Out-of-scope
- In-scope:
  - 新增 connect-node 依賴（`package.json`），**只**被 `runtime/openshell/` import。
  - `src/runtime/openshell/proto/`：vendored **openshell.proto 子集**（本 ITEM 用到的 message/service 定義 + 必要 import）+ 來源 pin 註記（upstream path + revision）。
  - `src/runtime/openshell/client.ts`：connect-node client 工廠 `createOpenShellClient(opts)`；定義一個 **transport 介面** `OpenShellTransport`（後續 slice 與測試替身共用）；`health()` 包 `Health`（openshell.proto:22）；**pinned image digest 常數**（`sha256:` 形態）。
  - `openshell:proto:check`（一支 script）守護 vendored proto 子集 hash drift，mirror `scripts/proto-check.sh:7-22` 的 skip/diff 哲學。
- Out-of-scope（明確不做）:
  - Create/Get/Exec/Watch/Delete/ProviderEnv 任一生命週期 RPC → 留給 S2–S5。
  - `OpenShellSandboxAdapter`（implements SandboxAdapter）→ 留給 S2（首次出現）/ S6（接 contract）。
  - 真實網路 e2e → 留給 S6 的 opt-in skip 測試。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 新模組 `runtime/openshell` 出現；新增一個 vendor 依賴；無任何行為接到 `SandboxAdapter` port（port 不變）。
- **Modules touched（唯一責任）**:
  - `src/runtime/openshell/client.ts` — **唯一責任**：建立並持有 OpenShell gRPC 連線、暴露 transport 介面 + Health；不含任何 sandbox 語義。
  - `src/runtime/openshell/proto/*` — **唯一責任**：pinned 契約定義（型別來源），無邏輯。
- **PUBLIC interface（新增）**:
  - `interface OpenShellTransport { health(): Promise<{ ok: boolean }>; /* unary/stream call 原語，後續 slice 擴 */ }`
  - `function createOpenShellClient(opts: { baseUrl: string; deadlineMs: number }): OpenShellTransport`
  - `const PINNED_SANDBOX_IMAGE: string`（`sha256:`-prefixed digest 常數）
  - `function assertPinnedImageDigest(image: string): void`（非 `sha256:` digest → throw，供 S2 fail-closed 用）
- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    runtime/openshell/client.ts ──▶ runtime/openshell/proto/  (同模組)
    runtime/openshell/client.ts ──▶ connect-node             (npm, 僅此模組)
    ```
  - 僅經 public surface 消費（無 deep import 跨 core module）: ☑ 是（本 slice 不 import 任何其他 src 模組）
  - 新依賴宣告:
    - `connect-node`（@connectrpc/connect 系）: 方向=adapter→npm（不指向任何 core 模組）、cycle=無、理由=Strategy B 要用 gRPC 連 OpenShell；**只**在 `runtime/openshell/` import，`no-vendor-in-core` 與 inward 規則皆不違反（`runtime/openshell` 非 core 模組）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/runtime/openshell/client.test.ts`
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] `createOpenShellClient` 回一個含 `health()` 的物件（型別 + 存在性）。
  - [ ] 注入一個「Health 回 SERVING」的 transport double → `health()` resolves `{ok:true}`。
  - [ ] 注入一個「Health throw / 逾時」的 double → `health()` resolves `{ok:false}`（**fail-closed，不 throw 跨邊界**）。
  - [ ] `assertPinnedImageDigest("alpine:latest")` throw；`assertPinnedImageDigest("sha256:abc…")` 不 throw。
  - [ ] 安全對抗式：`PINNED_SANDBOX_IMAGE` 是 `sha256:` digest 形態（deny-by-default：非 digest 不被接受）。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/runtime/openshell/client.test.ts
  ... FAIL（模組 src/runtime/openshell/client 不存在，import 失敗）...
  exit code: <填實測>
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5；git history 證 doc→red→impl 順序）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: <填實測>
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；`no-vendor-in-core` 仍綠：`openshell` token 只出現在 `src/runtime/openshell/`）
- [ ] `openshell:proto:check` 綠（vendored proto 子集無 drift；toolchain 缺則 clean skip）。**並接進 `pnpm run verify`**（與既有 `proto:check` 並列，見 `package.json:28`），使 drift 由統一 gate 的 exit code 把關，而非僅靠人記得單跑——否則「綠」非 command-verifiable。RED 證據：對 vendored 子集植入一字元 drift → `pnpm run openshell:proto:check` exit≠0；還原 → exit 0。
- [ ] low coupling / high cohesion 遵守（connect-node 僅 `runtime/openshell/` import；無新跨 core module / cyclic 依賴）
- [ ] secret-scan 乾淨（client / proto / 測試替身**無** secret-like 值；baseUrl/digest 非 secret）
- [ ] Docs 更新（design/adapter-openshell-substrate.md §5 pin 說明與實作一致）
- [ ] Adversarial code review = PASS（fresh-context；findings 已解）— 連結/摘要: <填>
- [ ] （安全不變量類）Independent Verifier Pass：probe「Health 逾時/壞回應 ⇒ fail-closed `{ok:false}`，且不 throw、不洩 baseUrl 到 log」

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `runtime/openshell/` 與 connect-node 依賴）。
- 可逆性: 安全可逆——無外部副作用、無 audit append、無資料遷移；僅新增隔離模組與一個 devDependency。

## (8) Depends-on / blocks
- Depends-on: **P2-A**（SandboxAdapter port 已 DONE；本 slice 尚不 implements 它，但 ITEM 以它為前置）。
- Blocks: P2R-R1-S2（建立操作需 client）、P2R-R1-S5（provider-env 需 client）。
- 確認 slice DAG 無 cycle: ☑ 是（S1 為 rank 0，僅依賴已 merge 的 P2-A）
