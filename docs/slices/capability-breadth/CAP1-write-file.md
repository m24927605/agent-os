# SLICE-CAP1: `exec.write_file` — in-sandbox 檔案寫(capability breadth 第 1 刀)

- **Phase**: capability breadth — Slice 1（最便宜的真能力先出;住在 seal 內,零 seal-punch primitive）
- **Branch**: slice/cap1-write-file
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機 + 設計關鍵
能力面只有 8 個 exec.* 工具。第 1 刀加 **in-sandbox 檔案寫**(最便宜的真能力,brainstorm 推薦先出)。**設計關鍵**:OpenShell substrate exec(streaming `adapter.execSandbox`)**支援 stdin**(`ExecSandboxRequest.stdin: Uint8Array`,`ExecOptsSchema` >8 MiB fail-closed 拒),但 `ExecToolBinding` **沒有 stdin 縫**,且 **buffered-port wrapper `optsFromSpec` 原本只映 env+timeoutMs、不轉 `spec.stdin`**。乾淨寫檔 = **`tee -- <path>` + content 走 stdin**(content **絕不進 argv、絕不進 shell**;`--` 守 path)。需加一個 **`toStdin?` 縫**(inside-seal 的 binding-model 小擴充,**非 seal-punch primitive**——content 走 stdin 仍受 screen + 留在 ephemeral sandbox),並把 stdin **一路串到 real adapter**(toStdin → bindingWrappedExecEffect → makeExecEffect → **`exec-buffered.optsFromSpec`** → real adapter → RPC),否則 real path 會丟 stdin、`tee` 寫出**空檔**。

> 誠實:brainstorm 說 Slice 1「零新 primitive」略樂觀——write_file 需 `toStdin?` 縫。但這是 **inside-seal 的 binding 機制擴充**,不打穿 seal、保所有不變量,與「住在 seal 內先出」精神一致。`apply_patch` 延後(待 `toStdin?` 縫證實後,另一個 binding 即可)。

## (1) 範圍(精確)
1. **`ExecToolBinding` + `toStdin?`**(exec-closed-loop.ts):`readonly toStdin?: (validatedArgs: unknown) => Uint8Array | undefined`(鏡像 `toEnv?`,pure)。
2. **`bindingWrappedExecEffect` 串 stdin**(:137-149):`const stdin = binding.toStdin?.(validated)`(同 try/catch fail-closed);傳 `execEffect({context, args:{argv, env?, stdin?}})`。
3. **`makeExecEffect` 收 `args.stdin`**(exec-effect.ts):傳給 `substrate.execSandbox` 的 `stdin`;**credential-blind INPUT guard 也篩 stdin**(defense-in-depth;screen 已先篩 declared content,這層再保)。**port `ExecCommandSpec` + schema 加 `stdin?: Uint8Array`**(fail-closed `z.instanceof(Uint8Array)`)。
4. **real-functional 縫:`exec-buffered.optsFromSpec` 轉 `spec.stdin`**(openshell/exec-buffered.ts):一行加 `...(spec.stdin !== undefined ? { stdin: spec.stdin } : {})`——否則 production buffered 路徑丟 stdin,`tee` 寫空檔。real adapter 的 `ExecOptsSchema`(已含 stdin,8 MiB 上限)+ `adapter.execSandbox`(已轉 `req.stdin`)不需改。
5. **`exec.write_file`**:manifest(`name:"exec.write_file"`、`sideEffect:"write"`、`idempotent:false`、`requiresApproval:false`〔理由:限 ephemeral sandbox,同 exec.run 姿態〕)+ binding(`argvPrefix:["tee","--"]`、`argSchema: z.object({path:z.string().min(1), content:z.string()}).strict()`、`toArgv:(a)=>[a.path]`、`toStdin:(a)=>new TextEncoder().encode(a.content)`、`governanceProjector: 包 buildExecRunProjection`)+ 註冊進 `seedRegistry()`/`seedBindings()`。
6. **apply_patch 不在本刀**(延後)。

## (2) 不變量
- **content 絕不進 argv/shell**:argv = `["tee","--",path]`(純字串向量,無 `sh -c`);content 走 stdin(bytes)。`; rm -rf /` 當位元組寫入,不被執行。
- **deny-by-default / strict**:unknown/extra/missing key → deny,effect 不達(沿用 bindingWrappedExecEffect (b))。
- **credential-blind**:secret-shaped content → screen 先拒(declared arg);makeExecEffect input guard 也篩 stdin。content **不進 projection**(projection 只蓋 argv=tee/path → AGT 看寫入「目標」非內容;內容由 screen 管)。
- **commit-before-effect**:write_file 騎不變的 pipeline → AuditEvent 先 append 再寫(write 是 effectful)。
- **sandbox boundary**:寫落在 ephemeral sandbox fs,隨 sandbox finally 銷毀(無 host 寫、無 write-target allowlist——本刀**只**因限在 seal 內才可;host-persistent 是 Slice 9)。
- **缺省 byte-identical**:`toStdin?` optional;沒宣告的工具(既有 8 個)行為不變(EXEC4c/既有測續綠)。
- requiresApproval:false → **不觸發 Slice 4 的 approval gate**(維持自主迴圈)。

## (3) Test-first plan（RED 先行;Fake substrate)
- **(a) strict deny**:`exec.write_file` 帶 unknown key / 缺 path → deny,substrate 未呼叫。
- **(b) content 當 literal bytes(核心)**:content = `"; rm -rf /\n<script>"` → Fake substrate 收到的 **argv == ["tee","--",path]**(content 不在 argv)、**stdin == content bytes**;**非 vacuity**:若把 content 塞進 argv → 翻紅。
- **(c) advertise + deny**:tools/list 含 exec.write_file 的 derived schema(path/content);未註冊名 deny。
- **(d) credential-blind**:secret-shaped content(runtime-built sk- canary)→ screen 拒(substrate 0 呼叫);mutation:移除 stdin 篩 → 視 screen 是否已擋(確認 canary 不達 substrate)。
- **(e) effectful pipeline**:write_file 經 runGovernedToolCall → commit-before-effect 先 append AuditEvent 再 substrate write(沿用既有 commit-before-effect 測樣式)。
- byte-identical:既有 8 工具 + EXEC4c-a/b + 既有 exec 測不變綠。
- (選)live:對真 sandbox `exec.write_file` 寫 + `exec.cat` 讀回 == content(可併入既有 live-hermes/desktop e2e 或留觀察)。

## (4) Definition of Done
- [x] RED → verify exit 0(`toStdin?` 縫 + write_file binding/manifest/registration;content-via-stdin 非 argv〔mutation 證〕;strict deny;credential-blind〔含 stdin guard mutation 證〕;commit-before-effect;**缺省 byte-identical**;depcruise/secret-scan clean;無新依賴)。
- [x] **real-functional**:stdin 一路串到 real adapter(toStdin → bindingWrappedExecEffect → makeExecEffect → `optsFromSpec` → real adapter → `ExecSandboxRequest.stdin`),buffered-path test 證 `optsFromSpec` 轉 `spec.stdin`〔drop-the-line mutation 翻紅〕。write_file 不再只 fake-proven,real path 真寫入 content(非空檔)。
- [ ] **LIVE**:對真 OpenShell sandbox `exec.write_file` 寫 + `exec.cat` 讀回 == content,需 deploy 一個真 OpenShell sandbox(deploy fact;in-repo 證鏈到 RPC request,未含真 gateway 往返)。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(`toStdin?` optional + 新 binding 純加法;缺省 byte-identical)。
- Depends-on:exec-closed-loop(ExecToolBinding/bindingWrappedExecEffect)、exec-effect(makeExecEffect + substrate stdin)、port(`ExecCommandSpec.stdin`)、exec-buffered(`optsFromSpec` stdin 轉發)、exec-seed-tools(seed 樣式)、R9b-2b(governanceProjector)、manifest。Blocks:CAP 後續(git family / apply_patch / classifier …)。
- **誠實前提**:
  - stdin **end-to-end 串通**(toStdin → bindingWrappedExecEffect → makeExecEffect → `optsFromSpec` → real adapter → RPC `stdin`),write_file **real-functional**(real path 真寫 content,非空檔)。
  - in-repo 證鏈到 **RPC request**;**LIVE 仍需真 OpenShell sandbox**(deploy fact)——in-repo 不含真 gateway 往返(EXEC2 gated live harness)。
  - 本刀只 in-sandbox 寫(限 seal 內,隨 sandbox 銷毀)——**非 host-persistent**(那是 Slice 9 + write-target allowlist);content 不進 projection(AGT 看目標非內容);`toStdin?` 是 inside-seal binding 擴充非 seal-punch primitive。
