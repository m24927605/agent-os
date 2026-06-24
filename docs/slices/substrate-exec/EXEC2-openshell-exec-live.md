# SLICE-EXEC2: OpenShell exec → buffered port reconcile + gated live（真 sandbox 跑真命令)

- **Phase**: substrate capability — live（DHB3 閉環真輸出 = EXEC3)
- **Branches**: slice/exec2-openshell-exec-buffered（in-repo reconcile)、live = 同檔 gated test
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；TS only;新增依賴 = 0
- **狀態**: **DONE（in-repo reconcile + gated live harness;merged）**;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer=PASS(fail-closed 映射 / credential-blind 透 wrapper / lifecycle 同實例 / UTF-8 / gated skip load-bearing,mutation 證實;OpenShell 既有 exec+39 測+contract+EXEC1+nemoclaw+pipeline 未動)。**live-run = 待跑**(`AGENTOS_LIVE_OPENSHELL=1 pnpm run e2e:live-substrate-exec`)。

## (0) 動機 + 現況 + ⚠️ 誠實分界（grounded)
EXEC1 給了 port 的 **buffered** exec(`ExecCapableSandboxAdapter.execSandbox(spec)→ExecResult{ok,exitCode?,stdout,stderr,truncated?}`)+ Fake + credential-blind `makeExecEffect`。OpenShell adapter **早已有自己的 streaming exec**(adapter.ts:54-105,514+):`execSandbox(ctx, sandboxId, cmd: readonly string[], opts?: ExecSandboxOpts)→ExecOutcome`(ok/denied union,內含 `ExecResult{exitCode, stdout: Uint8Array, stderr: Uint8Array}`),且**已 fail-closed + capped**:8 MiB byte-cap(溢位→deny,不 OOM、不假造截斷成功)+ wall-clock deadline(terminal exit 前到期→deny)。**唯一缺口 = 把 OpenShell 的 streaming exec 收斂成 port 的 buffered `ExecResult`,讓 `makeExecEffect` 能驅動真 OpenShell。**
- **EXEC2 in-repo(reconcile)**:一個**薄 buffered wrapper**(`makeOpenShellExecCapable(adapter)→ExecCapableSandboxAdapter` 或等價)delegate lifecycle(create/start/stop/destroy)+ 把 streaming `ExecOutcome`→port `ExecResult`(`Uint8Array`→string;denied→`{ok:false,reason}`)。**不改** OpenShell adapter 既有 streaming exec/~40 測/nemoclaw。Fake/contract 證 reconcile,verify 內。
- **EXEC2 live(gated,你親跑或我代跑)**:對你**真 OpenShell gateway**(127.0.0.1:17670,已在跑)建真 sandbox → `makeExecEffect(wrapper, sandboxId)` exec 真命令 → 拿真 {exitCode,stdout,stderr}(redact+cap)→ destroy sandbox。**這是 sandbox 命令、非 LLM credits**;但在你 OpenShell 內有真副作用(建/刪 sandbox、跑命令),故 gated。
- **EXEC2 誠實不宣稱**:DHB3 閉環真輸出回饋 Hermes = EXEC3。

## (1) ID + Title
SLICE-EXEC2 —（a)`makeOpenShellExecCapable(adapter: OpenShellSandboxAdapter): ExecCapableSandboxAdapter`(delegate 4 lifecycle;`execSandbox(ctx,sandboxId,spec)` 呼 `adapter.execSandbox(ctx,sandboxId,spec.argv, optsFromSpec)` → ExecOutcome → ok:`{ok:true,exitCode,stdout:decode(Uint8Array),stderr:decode,truncated:false}`、denied:`{ok:false,reason}`);(b)in-repo reconcile 測(用既有 OpenShell 測 double / fake transport 證映射 + fail-closed〔denied→ok:false、deadline/byte-cap deny 傳遞〕,**不啟動真 gateway**);(c)gated live 測(對真 OpenShell:create→exec real argv→ExecResult→`makeExecEffect` redact+cap→destroy),`e2e:live-*` gated,skip-under-verify。

## (2) Goal（一句話）
讓 `makeExecEffect` 能驅動**真 OpenShell** 在真 sandbox 跑真命令拿真輸出——把 OpenShell 既有 streaming exec 薄收斂成 port 的 buffered `ExecResult`(不碰 OpenShell 既有碼),in-repo 證映射 + gated live 證真執行。

## (3) In-scope / Out-of-scope
- In-scope:
  - `makeOpenShellExecCapable`(src/runtime/openshell/ 內,vendor 區;經 barrel)——delegate lifecycle + buffered exec 收斂;`Uint8Array`→string(UTF-8);denied/deadline/byte-cap → `{ok:false,reason}`(**絕不把 denied 當 ok、絕不假造 exit 0**)。
  - in-repo reconcile 測(OpenShell 既有 fake transport / 測 double):ok ExecOutcome→buffered ok;denied→`{ok:false}`;byte-cap/deadline deny 傳遞;經 `makeExecEffect` 仍 credential-blind(redact 輸出)+ 64KB cap。
  - gated live 測(對真 OpenShell gateway):gate(`AGENTOS_LIVE_OPENSHELL=1`〔對齊既有 OpenShell live 測〕+ gateway 在跑;缺→skip/clean BLOCK);create sandbox → `makeExecEffect` exec 真 argv(如 `["sh","-c","echo hello; echo err 1>&2"]`)→ 斷言 `EffectResult{ok:true, detail 含 redacted "hello"}`、真 exitCode;**destroy sandbox 收尾**(不洩 sandbox)。skip-under-verify;`e2e:live-*` 跑。
  - `pnpm run verify` 綠(reconcile 測 + 既有 OpenShell 測不變;depcruise/secret-scan clean;live 不在 verify)。
- Out-of-scope（誠實標記):
  - **改 OpenShell adapter 既有 streaming execSandbox / ExecOutcome / ~40 測 / nemoclaw**(只加 wrapper,不動)。
  - **DHB3 閉環接 exec-backed effect(真輸出回饋 Hermes)** = EXEC3。
  - streaming buffered 之外的形態、tty/interactive。

## (4) Design delta + 依賴方向
- 1 個 wrapper(+ Uint8Array→string decode + opts 映射)+ in-repo 測 + gated live 測。**不改** OpenShell 既有碼、pipeline、EXEC1 port/effect。wrapper 在 openshell/ 內(vendor 區),經 barrel;depcruise no-vendor-in-core 合規(wrapper 是 vendor adapter)。
- **PUBLIC**:`makeOpenShellExecCapable`;`e2e:live-*`(exec)。

## (5) Test-first plan（RED 先行)
- in-repo reconcile(OpenShell 測 double,RED 先):ok ExecOutcome(stdout Uint8Array "hello")→buffered `{ok:true,exitCode,stdout:"hello"}`;denied ExecOutcome→`{ok:false,reason}`;byte-cap/deadline deny→`{ok:false}`(非假造 ok)。映射前紅。
- 經 `makeExecEffect`:wrapper + Fake-ish OpenShell double → EffectResult,credential-blind(redact)+ cap 仍成立。
- gated live(skip 預設):缺 gate → skip/clean BLOCK exit 0(不假綠;非空 guard)。

## (6) Definition of Done（實測）
- [x] in-repo:RED → `pnpm run verify` **exit 0**(985 passed + 21 skipped;reconcile 12 測綠;**OpenShell adapter.exec 39 + sandbox-adapter contract 17 + EXEC1 exec-effect 12 不變綠**;depcruise 141 modules clean〔reviewer deep-import 親證 bite〕;secret-scan clean;live SKIPPED、不在 verify)。
- [x] **映射 fail-closed 非 vacuous**:ok→buffered ok(exitCode 忠實);denied/deadline/byte-cap/transport-refusal→`{ok:false}` 無 exitCode、**never throws、never 假 exit 0**;reviewer mutation(denied 當 ok → 翻 4;hardcode exit 0 → 翻非零-exit 測)。UTF-8 decode 真(多 chunk)。
- [x] **credential-blind 透 wrapper**:env screen 在 `makeExecEffect` **上游**(raw secret env → deny、adapter `execSandbox` **0 RPC**);輸出 redact 重用(canary→`[REDACTED]`,decode-empty mutation 翻 4 含 redaction+cap);64KB cap held。lifecycle delegate **同 adapter 實例**(shared refById)。
- [x] OpenShell 既有 streaming exec / `ExecOutcome` / 39 exec 測 / nemoclaw / EXEC1 / pipeline **未動**(git-diff 空;只 6 EXEC2 檔)。
- [x] gated live 骨架:`exec-buffered.live.test.ts` gate `AGENTOS_LIVE_OPENSHELL=1`(skip-under-verify load-bearing)+ `e2e-live-substrate-exec.sh` 缺 gate clean BLOCK exit 0 + 非空 guard;`afterAll` destroy sandbox(不洩)。
- [x] **獨立 Opus 4.8 review = PASS**(8 攻擊面 HELD/N/A;5 mutation 翻紅;1 MINOR〔depcruise not-to-internal 把 src/runtime/ 視為單一 module 的 pre-existing 廣度限制,非本刀引入、wrapper 正確走 barrel,無需處理〕)。
- [ ] **live-run(待跑後填)**:`AGENTOS_LIVE_OPENSHELL=1 pnpm run e2e:live-substrate-exec` 對真 OpenShell:create→exec 真命令→真 {exitCode,stdout,stderr} 經 effect(redact+cap)→destroy;綠 / 或揭露差異(fail-closed)。

## (7) Rollback
- `git revert <merge-sha>`(wrapper + 測 + live 骨架)。OpenShell 既有碼/EXEC1/pipeline 不受影響。

## (8) Depends-on / blocks
- Depends-on:EXEC1(`ExecCapableSandboxAdapter`/`ExecCommandSpec`/`ExecResult`/`makeExecEffect`)、OpenShell adapter(既有 streaming exec)。
- Blocks:**EXEC3**(DHB3 閉環真輸出回饋)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:EXEC2 reconcile + gated live 證真 OpenShell exec;DHB3 閉環真輸出回饋 Hermes = EXEC3。
