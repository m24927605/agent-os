# SLICE-P2R-R1-S4: ExecSandbox server-stream（stdout/stderr/exit → result）

- **Phase**: P2（ITEM R1 — live OpenShell substrate adapter）
- **Branch**: slice/p2r-r1-s4-execsandbox-stream
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: 估計 <= 1 day；預期 net LOC <~150、files <~3、modules = 1（`runtime/openshell`）；新增第三方依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R1-S4 — 為 `OpenShellSandboxAdapter` 加 `execSandbox`：呼 `ExecSandbox`（server-stream，openshell.proto:67），消費 `ExecSandboxEvent` oneof（stdout/stderr/exit，openshell.proto:690-696），收斂成一個帶 exit code 的結果，fail-closed。

## (2) Goal（一句話）
讓 Agent OS 能在一個 READY 的 OpenShell sandbox 內**執行命令並取回 stdout/stderr/exit code**，stream 中斷/逾時/未知 sandbox 皆 fail-closed。

## (3) In-scope / Out-of-scope
- In-scope:
  - `execSandbox(ctx, sandboxId, cmd, opts)`：壞 ctx / 未知 id（對映無）→ deny；組 `ExecSandboxRequest{sandbox_id, command, workdir?, environment?, timeout_seconds?}`（openshell.proto:645-672）→ 消費 server-stream，累積 stdout/stderr bytes，取 `ExecSandboxExit.exit_code`（openshell.proto:685-687）。
  - 結果型別 `ExecResult { exitCode: number; stdout: Uint8Array; stderr: Uint8Array }`；**未見 exit 事件就 stream 關閉 → fail-closed**（視為失敗，回 deny 或 exitCode 缺失明示，不臆測成功）。
  - deadline / `AbortController` 收斂；stream error → fail-closed。
  - `OpenShellTransport` 擴 `execSandbox(req): AsyncIterable<ExecSandboxEvent>`。
- Out-of-scope（明確不做）:
  - interactive/tty（`ExecSandboxInteractive`、`tty/cols/rows`，openshell.proto:75/665-671）→ 不做（design §6）。
  - stdin 串流（先支援 request 內 `stdin` bytes 即可，互動 stdin 不做）。
  - command/env 注入真值 credential（永遠走 SecretResolver，S5/egress；exec env 只接受 placeholder 形態值，見 §安全對抗式）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: adapter 多一個 exec 能力；server-stream 消費與收斂規則固定且 fail-closed（無 exit ⇒ 非成功）。
- **Modules touched（唯一責任）**:
  - `src/runtime/openshell/adapter.ts` — **唯一責任（延伸）**：把 sandbox 內命令執行翻譯成 ExecSandbox stream 並收斂結果；不解析/注入 credential、不 append audit。
- **PUBLIC interface（新增/變更）**:
  - `OpenShellSandboxAdapter.execSandbox(ctx: unknown, sandboxId: string, cmd: readonly string[], opts?: { workdir?: string; env?: Record<string,string>; timeoutSeconds?: number; stdin?: Uint8Array }): Promise<{ status:"ok"; result: ExecResult; event: SandboxLifecycleEvent } | { status:"denied"; reason: string; event: SandboxLifecycleEvent }>`
  - `OpenShellTransport` 擴 `execSandbox`。
- **Dependency direction（low coupling 自證）**:
  - 箭頭圖:
    ```
    runtime/openshell/adapter.ts ──▶ runtime/substrate (barrel: deny/ok/event)
    runtime/openshell/adapter.ts ──▶ runtime/openshell/client.ts (同模組)
    ```
  - 僅經 public surface 消費（無 deep import）: ☑ 是
  - 新依賴宣告: 無。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/runtime/openshell/adapter.exec.test.ts`
- RED 測試清單:
  - [ ] exec 壞 ctx → denied，未呼 ExecSandbox（fail-closed）。
  - [ ] exec 未知 id（對映無）→ denied，未呼 RPC。
  - [ ] exec 正常 stream（stdout 兩塊 + exit 0）→ `ok`、`result.exitCode===0`、stdout 拼接正確。
  - [ ] exec stream 給 exit≠0 → `ok`（adapter 不把非零 exit 當 transport 失敗；exitCode 如實回報）。
  - [ ] 安全對抗式：stream 提前 error / 無 exit 事件即關閉 / deadline 逾時 → **denied（不臆測成功）**；env 含 reserved credential marker 字面值（非 placeholder）→ denied（credential 不得以明文進 exec env）。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/runtime/openshell/adapter.exec.test.ts
  ... FAIL（execSandbox 未實作）...
  exit code: <填實測>
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: <填實測>
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；`no-vendor-in-core` 仍綠）
- [ ] low coupling / high cohesion 遵守（無新跨 module / cyclic 依賴）
- [ ] secret-scan 乾淨（exec env 測試用 runtime 組裝的 canary，無 source 字面 secret）
- [ ] Docs 更新（design §3.4 stream 收斂/fail-closed 與實作一致）
- [ ] Adversarial code review = PASS（fresh-context）— 連結/摘要: <填>
- [ ] Independent Verifier Pass：probe「無 exit / stream error / deadline ⇒ denied；明文 credential env ⇒ denied」

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 execSandbox 與 transport 原語）。
- 可逆性: exec 有**外部副作用**（在 sandbox 內跑了命令），但無 audit append、無歷史改寫；回退僅移除呼叫能力，已執行的命令效果由上層 forward-fix（R1 不負責 effect 回滾）。

## (8) Depends-on / blocks
- Depends-on: **P2R-R1-S2**（需 adapter + name↔Id 對映）。
- Blocks: P2R-R1-S6。
- 確認 slice DAG 無 cycle: ☑ 是（S4 rank 2，僅依賴 S2；與 S3/S5 互不相依）
