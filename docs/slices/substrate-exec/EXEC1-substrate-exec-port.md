# SLICE-EXEC1: ExecutionSubstrate exec primitive — port + Fake + exec-backed governed effect（in-repo)

- **Phase**: substrate capability（真 OpenShell `ExecSandbox` live = EXEC2;DHB3 整合 = EXEC3)
- **Branch**: slice/exec1-substrate-exec-port
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1–1.5 day；TS only;新增依賴 = 0
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer=PASS;credential-blind 進/出 + fail-closed〔無假 exit 0〕+ output cap〔redact 後截斷〕+ commit-before-effect 經 mutation 證實;pipeline/guard/OpenShell empty-diff;12 tests）

## (0) 動機 + 現況 + ⚠️ 誠實分界（grounded)
`SandboxAdapter`(src/runtime/substrate/port.ts:46-50)只有 lifecycle(create/start/stop/destroy)+ `AdapterResult`,**無 exec**——所以 governed effect 只能回 canned stub(DHB3 閉環因此回饋假結果)。但 **exec 能力已在 OpenShell transport 層**(client.ts:221+:`ExecSandboxRequest/Stdout/Stderr/Exit{exitCode}/Event`,streaming,fail-closed)。EXEC1 = **把 exec 經 port 暴露 + Fake 證 + 接 governed effect + credential-blind**;真 OpenShell 接線 = EXEC2;接 DHB3 閉環 = EXEC3。
- **EXEC1 in-repo 可達成**:port `execSandbox` + `FakeSandboxAdapter` impl(deterministic)+ `NullSandboxAdapter` fail-closed + exec-backed effect + credential-blind(placeholder env 進、redactSecrets 輸出出)+ output cap + fail-closed。**Fake 證,verify 內,無 live、無真 sandbox。**
- **EXEC1 誠實不宣稱**:**未**接真 OpenShell `ExecSandbox`(= EXEC2/live,需你的 OpenShell 環境)、**未**接 DHB3 閉環(= EXEC3)。
- **不動** pipeline.ts/guard.ts:結果走既有 `EffectResult.detail`(字串,DHB3 本就把 outcome 序列化成文字回饋);結構化 `EffectResult.output?` widening = open decision/後續。

## (1) ID + Title
SLICE-EXEC1 —（a)port 加 `execSandbox(ctx: unknown, sandboxId: string, spec: ExecCommandSpec): Promise<ExecResult>`;`ExecCommandSpec={argv: readonly string[]; env?: Readonly<Record<string,string>>(**placeholder/bundleRef ONLY,raw secret 禁**); timeoutMs?}`;`ExecResult={ok: boolean; exitCode?: number; stdout: string; stderr: string; truncated?: boolean; reason?: string}`(buffered)。(b)`FakeSandboxAdapter.execSandbox`(deterministic,可腳本化 canned 輸出 + 對抗模式〔stdout echo secret canary、巨量輸出、無 terminal exit〕)。(c)`NullSandboxAdapter.execSandbox` → fail-closed `{ok:false,reason}`。(d)**exec-backed governed effect** `makeExecEffect(substrate, sandboxId)→(tc)=>Promise<EffectResult>`:呼 `execSandbox` → **redactSecrets(stdout/stderr)** → 映 `EffectResult{ok, detail:<redacted、capped 摘要>}`。(e)credential-blind(placeholder env 驗證 + redact 輸出)+ output cap + fail-closed,RED-first。

## (2) Goal（一句話）
讓 `ExecutionSubstrate` 能在 sandbox 真的跑命令拿 {exitCode,stdout,stderr},並以 **credential-blind + fail-closed + capped** 的方式包成 governed effect 的 `EffectResult`——把「canned stub」換成「真實執行能力」的 in-repo 骨幹(Fake 證),為 EXEC2(真 OpenShell)/EXEC3(DHB3 閉環真輸出)鋪路。

## (3) In-scope / Out-of-scope
- In-scope:
  - port `execSandbox` + `ExecCommandSpec` + `ExecResult`(src/runtime/substrate/port.ts;Zod where it crosses a boundary)。
  - `FakeSandboxAdapter.execSandbox`(deterministic;對抗:secret-echo、巨量、無-terminal-exit)、`NullSandboxAdapter.execSandbox`(fail-closed deny)。
  - exec-backed effect helper(src/runtime/substrate/exec-effect.ts 或鄰近;經 barrel)。**credential-blind**:`ExecCommandSpec.env` **拒 raw secret**(只允 placeholder/bundleRef,複用 `detectSecret`/redactSecrets-changed 判定);**輸出**經 `redactSecrets` 才入 `EffectResult.detail`。
  - **output cap**(如 64KB,redact 後截斷 + `truncated:true`)。
  - **fail-closed**:exec 串在 terminal exit 前結束 / Null adapter / 命令啟動失敗 → `{ok:false}`(**絕不假造 exit 0**,對齊 client.ts:213-214);effect 收到 ok:false → `EffectResult{ok:false}`。
  - 單元測(Fake):跑命令→{exitCode,stdout,stderr}→effect→EffectResult;credential-blind 進/出;output cap;fail-closed;commit-before-effect(exec 只在 effect 跑)。
  - `pnpm run verify` 綠;depcruise(substrate→audit 經 barrel、no-vendor-in-core)、secret-scan clean。
- Out-of-scope（誠實標記):
  - **真 OpenShell `ExecSandbox` 接線 + live** = EXEC2(client.ts 已有 client-level;需你 OpenShell 環境)。
  - **接 DHB3 閉環(真輸出回饋 Hermes)** = EXEC3。
  - streaming exec result、`EffectResult.output?` 結構化 widening、interactive/tty = 後續/open decision。
  - 改 pipeline.ts/guard.ts(用既有 EffectResult.detail)。

## (4) Design delta + 依賴方向
- port 加 1 method + 2 type;2 adapter 實作 + 1 effect helper。`EffectResult` 不改(用 detail)。pipeline/guard 不動。無新依賴。
- **依賴**:exec-effect 用 `redactSecrets`(audit barrel)、`detectSecret`-類(credential 判定);substrate 經 barrel,depcruise no-vendor-in-core 合規。
- **PUBLIC**:`SandboxAdapter.execSandbox`、`ExecCommandSpec`、`ExecResult`、`makeExecEffect`。

## (5) Test-first plan（RED 先行,對 Fake)
- RED1 happy:Fake `execSandbox` 回 {exitCode:0,stdout,stderr} → `makeExecEffect` → `EffectResult{ok:true, detail 含 redacted 輸出}`。
- RED2 credential-blind 輸入:`ExecCommandSpec.env` 帶 raw secret → **拒**(只允 placeholder/bundleRef);mutation(允許 raw env)→ 紅。
- RED3 credential-blind 輸出:Fake 命令 stdout echo runtime-built secret canary → `EffectResult.detail` 經 redactSecrets、canary 不在;mutation(skip redact)→ 紅。
- RED4 fail-closed:Fake 無 terminal exit / Null adapter / 啟動失敗 → `{ok:false}`、effect `EffectResult{ok:false}`,**無假造 exit 0**;mutation(無 exit 仍回 ok:true exit 0)→ 紅。
- RED5 output cap:Fake 巨量 stdout → 截斷 + `truncated:true`、長度 <= cap;mutation(不截)→ 紅。
- RED6 commit-before-effect:exec 只經 effect(commit 之後)跑;rejecting appender → execSandbox 從未被呼叫。

## (6) Definition of Done（實測）
- [x] RED → `pnpm run verify` **exit 0**(973 passed + 20 skipped;exec-effect 12/12;depcruise 140 modules clean〔reviewer deep-import 親證 not-to-internal bite,substrate→audit 僅經 barrel〕;secret-scan clean〔canary runtime-built〕;pipeline/guard/OpenShell empty-diff;live/EXEC2/EXEC3 不在 verify)。
- [x] **credential-blind 進**:env 值經 detector(預設 redactSecrets-changed;**throw=secret** fail-closed)篩,raw secret → DENY 且 `execSandbox` **0 calls**;reviewer mutation(drop check / always-false detector / catch 視為非-secret)→ 翻紅;**預設 detector 拒 canary 放 bundleRef(非 vacuous)**。
- [x] **credential-blind 出**:stdout **與** stderr 皆經 `redactSecrets` 才入 detail;skip-redact mutation → canary 漏 → 紅。
- [x] **fail-closed**:無 terminal exit / Null / 啟動失敗 → `EffectResult{ok:false}`,**ExecResult failure arm 結構上無 exitCode**(map-fail-to-ok mutation → 紅;`{ok:false,exitCode}` → TS2353)。
- [x] **output cap**:redact **之後**截斷至 64KB + `[truncated]`(跨截斷邊界 secret 不存活);remove-cap mutation → 紅。
- [x] **commit-before-effect**:rejecting appender → `execSandbox` 0 calls;pipeline/guard EMPTY-diff,effect 在其上注入。
- [x] **獨立 Opus 4.8 review = PASS**(5 安全性質非 vacuous;deviation 證實 sound;2 MINOR——①預設/throwing detector 覆蓋〔已採納補 3 cases〕②EXEC2 reconcile〔下〕)。
> **deviation(reviewer 判定 sound)**:未直接加 `execSandbox` 到 `SandboxAdapter`,改用 `ExecCapableSandboxAdapter extends SandboxAdapter`——因 OpenShell adapter 早有自己的 **streaming** `execSandbox(…cmd, opts)→ExecOutcome`(~40+ 測 + nemoclaw 用),直接 widen 會 TS2416/2322 撞 OpenShell + 逼改 out-of-scope。extension 介面把 buffered exec 加進 port、4 個 lifecycle 凍結、OpenShell 不動。
> **→ EXEC2 tracking item**:buffered `ExecResult`(EXEC1)↔ OpenShell streaming `ExecOutcome` 同名 `execSandbox` 簽章不相容,**EXEC2 須 reconcile**(buffered 包裝 / 收斂 seam)。

## (7) Rollback
- `git revert <merge-sha>`(port method + 2 adapter impl + effect helper + 測)。lifecycle/既有 adapter 用法不變、向後相容。

## (8) Depends-on / blocks
- Depends-on:substrate port(port.ts)、`runGovernedToolCall`/`EffectResult`、`redactSecrets`(audit)、credential bundleRef 慣例。
- Blocks:**EXEC2**(真 OpenShell `ExecSandbox` live)、**EXEC3**(DHB3 閉環真輸出回饋)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:EXEC1 證 exec port + Fake + credential-blind + fail-closed + cap(in-repo);真 OpenShell exec live = EXEC2(你的環境);真輸出回饋 Hermes = EXEC3。
