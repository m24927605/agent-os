# SLICE-CRED-LEAK-FIX: live-gmail script 不得 echo env 值（修真實洩漏破口)

- **Phase**: hardening（嚴重:ACT3-live 的 operator script 在 BLOCKED 診斷路徑 echo 了 `AGENTOS_GMAIL_OAUTH_KEY` 的值,使用者誤把 token 放該 env → token 洩漏進輸出)
- **Branch**: slice/cred-leak-fix
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 事件 + 根因
live drive 時 `scripts/e2e-live-gmail.sh:33`(`token KEY = ${AGENTOS_GMAIL_OAUTH_KEY}`)+ `scripts/act-live-gmail.mjs:38`(`env[${oauthKey}] … not set`)**把 `AGENTOS_GMAIL_OAUTH_KEY` 的值 echo 出來**。語意上 `AGENTOS_GMAIL_OAUTH_KEY` 應是「裝 token 的 env var **名稱**」(兩層;`gmail.send.toCredentialEnv` 讀它當 key 名);使用者誤把 **token 本身**放進去 → 診斷 echo → **token 洩漏**(fail-closed 仍生效,未寄信)。
- **教訓**:operator script 的**診斷/錯誤訊息**也是 credential sink;**絕不 echo 任何 env 值**(連「key 名」都不行——使用者可能誤放 secret)。review 漏測 BLOCKED 診斷路徑。

## (1) 範圍
1. **`scripts/e2e-live-gmail.sh`**:line 33 移除 `${AGENTOS_GMAIL_OAUTH_KEY}`;改成**固定字串**(只提 env 變數**名稱**常數,絕不印值)。掃全檔:任何 `echo` 不得內插 `AGENTOS_GMAIL_OAUTH_KEY` / `GMAIL_TOKEN` / 任何可能含 secret 的 env 值。
2. **`scripts/act-live-gmail.mjs`**:BLOCKED 診斷不得印 `oauthKey`(= `AGENTOS_GMAIL_OAUTH_KEY` 的值)或 `process.env[oauthKey]`。改用下方可測的 preflight 的**固定 reason**。
3. **可測的 preflight**(放 `action-live-gmail-runner.ts`):`liveGmailPreflight(env): { status: "ok"|"skip"|"blocked"; reason: string }`——reason 是**固定列舉字串,零 env 值內插**。驗證 `AGENTOS_GMAIL_OAUTH_KEY` 須 match `^[A-Z][A-Z0-9_]*$`(env 變數名);否則 `blocked`,reason = 固定「AGENTOS_GMAIL_OAUTH_KEY must be the NAME of the env var holding the token (e.g. GMAIL_TOKEN), not the token itself」(**不印值**)。token env 未設 → blocked(固定 reason,不印名/值)。
4. `.mjs`/`.sh` 改用 preflight 的固定 reason;**唯一允許出現在輸出的 env 識別字 = 固定常數名**(如字面 "AGENTOS_GMAIL_OAUTH_KEY"),**絕不是其值**。

## (2) 不變量
- **零 env 值洩漏**:任何 env 值(尤其 `AGENTOS_GMAIL_OAUTH_KEY` 的值、`GMAIL_TOKEN`、resolved token)**永不出現在 script stdout/stderr**。
- **fail-closed 仍在**:misconfig(token 放錯位 / key 名非法 / token 未設)→ BLOCKED,不寄,**不印值**。
- **誤放 token 即時擋**:`AGENTOS_GMAIL_OAUTH_KEY` 值非合法 env 名(如 `ya29.…` 含 `.`)→ blocked + 固定教學 reason(引導兩層設法),不印。
- byte-identical(成功路徑行為不變,只是診斷字串改固定);無新依賴。

## (3) Test-first plan（RED 先行)
- `liveGmailPreflight`(vitest,fake env):
  - `AGENTOS_GMAIL_OAUTH_KEY` = canary token-shape(`ya29.<runtime canary>`)→ status blocked,**reason 不含 canary 任何片段**、不含 "ya29"。
  - `AGENTOS_GMAIL_OAUTH_KEY` = "GMAIL_TOKEN"(合法名)+ `GMAIL_TOKEN` 未設 → blocked,reason 固定(token-not-set),**不含 token 值**。
  - 合法名 + token 設 + 其他 env 齊 → ok。
  - 缺 AGENTOS_ACTION_LIVE 等 → skip。
  - **斷言**:對任一 env 值塞 canary,preflight 回傳的 reason **絕不含該 canary**。
- mutation:preflight 把 env 值放進 reason → canary 測翻紅。
- (script 層)`.test`:以 canary `AGENTOS_GMAIL_OAUTH_KEY` 跑 `.mjs`/`.sh`(fail-closed,不送)→ 擷取 stdout+stderr **不含 canary**。
- byte-identical:既有 runner/transport/全測不變綠。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(`liveGmailPreflight` 固定-reason 零內插 + key-name 驗證 + `.sh`/`.mjs` 改用它;canary env 值絕不入輸出;misconfig→blocked-不印;byte-identical;mutation 證;depcruise/secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提 / 後續
- Rollback:`git revert`(script 訊息 + 一個 preflight 函式)。
- Depends-on:ACT3-live(.sh/.mjs/runner)。Blocks:重跑 live drive(修後 + token 重新以兩層正確設)。
- **誠實前提**:本刀修「診斷 echo env 值」的洩漏破口;**已洩漏的 token 需使用者撤銷**(本刀不能收回 transcript)。命名 `AGENTOS_GMAIL_OAUTH_KEY`(實為「key 名」)易誤導,reason 文案直接教兩層設法。fail-closed 全程未破(未寄信)。
- **後續**:考慮把「KEY 名」env 改名為 `AGENTOS_GMAIL_OAUTH_KEY_ENV`(更明確「這是個 env 變數名」),降低誤放 token 的機率(本刀先止血 + 驗證 + 教學 reason)。
