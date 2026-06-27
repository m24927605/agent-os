# SLICE-REPORT-FIX: live runner 誠實回報（effect ok:false ≠ 「ok executed」)+ 診斷

- **Phase**: hardening（誠實 bug:guard/connector 拒送〔effect ok:false〕時,runner 仍印 "ok — executed",造成「寄出了」的假象)
- **Branch**: slice/report-fix
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 事件 + 根因
live drive:guard 因「acting account not in the test allowlist」拒送(token 解不出 mrfed1913,極可能過期)→ effect 回 `ok:false` → **沒寄信**。但 `scripts/act-live-gmail.mjs` 印 `OUTCOME executed` + `ok — governed live self-send executed`。pipeline 的 `executed` 只代表「effect 階段被執行」,**不代表 effect 成功**;runner 沒檢查 effect-result 的 `ok`,把**被拒**當成**寄出**。**這是 fake-green-ish 的誤導回報,必須修。**

## (1) 範圍
1. **`scripts/act-live-gmail.mjs`(+ 必要時 `runGmailSelfSend` 回傳的可測判斷)**:
   - 取 effect 的實際結果 `ok`(connector/guard 回傳的 `ActionResult.ok`)。
   - `outcome=executed` **且** effect `ok:true` → 印 `SENT ok`(真送出)。
   - `outcome=executed` **但** effect `ok:false` → 印 **`NOT SENT — <redactSecrets(reason)>`**(被 guard/connector 拒或 API 非-2xx),exit 非 0。
   - `outcome=denied@<stage>`(pipeline 層 deny)→ 印 `NOT SENT — denied@<stage>`,exit 非 0。
   - 絕不在「未真寄出」時印 "ok ... executed"。
2. **可測判斷**(放 `action-live-gmail-runner.ts`):`classifyLiveOutcome(result): { sent: boolean; label: string }`——`sent` 僅當 outcome executed 且 effect ok:true;label 固定/redacted,**零憑證**。.mjs 用它。
3. **診斷(credential-blind)**:guard 的 account-deny 與「resolver 無法解析帳號(userinfo 非-2xx,可能 token 過期)」可區分時,label 給更有用的固定提示(如 "blocked: acting account could not be verified (token may be expired/invalid)" vs "blocked: account not in allowlist")——**不印 token、不印 resolved email**(PII)。若 resolver 已折成 undefined 無法區分,至少 label 點出「帳號無法確認 → 檢查 token 是否過期」。

## (2) 不變量
- **誠實回報**:只有 effect ok:true(真送出)才說 sent/ok;被拒/錯誤一律 `NOT SENT` + 非 0 exit。
- **零憑證**:label/診斷固定字串或 redactSecrets;不印 token、不印 resolved account email。
- fail-closed 不變;治理鏈不變(只改回報判讀)。byte-identical(成功真送出時行為等價,只是用詞精確)。無新依賴。

## (3) Test-first plan（RED 先行;fake)
- `classifyLiveOutcome`:executed + effect ok:true → `{sent:true}`;executed + effect ok:false → `{sent:false, label 含 "NOT SENT"}`;denied@policy/approval → `{sent:false}`。
- mutation:把 sent 判定成「outcome===executed」(忽略 effect ok)→ ok:false 測翻紅(本該 NOT SENT)。
- (script)spawn `.mjs` with fake/skip 或 guard-deny 模擬 → stdout 不得出現 "ok ... executed" 當未送;出現 "NOT SENT";零憑證(canary 不入)。
- byte-identical:既有 runner/transport/全測續綠。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(`classifyLiveOutcome` + .mjs 改用;effect ok:false → NOT SENT + 非 0 exit;executed+ok:true → SENT;診斷 credential-blind;mutation 證〔忽略 effect ok 翻〕;byte-identical;depcruise/secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(回報判讀 + 一個 classify 函式)。
- Depends-on:ACT3-live(runner/.mjs)、CRED-LEAK-FIX/CRED-ONELEVEL(零 echo)。Blocks:可信的 live drive 重跑。
- **誠實前提**:本刀修「未送卻報 ok」的誤導;不改治理/安全鏈(它本就正確拒送)。live 真送仍需**有效 token**(過期→userinfo 401→guard 無法確認帳號→NOT SENT)。
