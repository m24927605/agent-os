# SLICE-CRED-ONELEVEL: AGENTOS_GMAIL_OAUTH_KEY 直接放 token（一層;移除 footgun)

- **Phase**: hardening（移除兩層 footgun:`AGENTOS_GMAIL_OAUTH_KEY` 直接是 token,不再是「裝 token 的 env 名」)
- **Branch**: slice/cred-onelevel
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
兩層設計(`AGENTOS_GMAIL_OAUTH_KEY` = 裝 token 的 env **名稱**)違反直覺、害使用者把 token 放錯位、間接導致洩漏事件。改**一層**:`AGENTOS_GMAIL_OAUTH_KEY` **直接持有 token**(使用者本來就這樣設)。credential-blind 不變(連接器只發 placeholder、egress 才解析、絕不 echo)。

## (1) 範圍
1. **`action-seed-tools.ts`**:`gmail.send`/`gmail.search` 的 `toCredentialEnv` 從 `toCredentialEnv(process.env[GMAIL_OAUTH_KEY_ENV])`(讀「值」當 key 名)改為 `toCredentialEnv(GMAIL_OAUTH_KEY_ENV)`(用**常數名** "AGENTOS_GMAIL_OAUTH_KEY" 當 placeholder key)。calendar 同理(`GCAL_OAUTH_KEY_ENV`)。
   - 結果:descriptor.env = `{ AGENTOS_GMAIL_OAUTH_KEY: "openshell:resolve:env:AGENTOS_GMAIL_OAUTH_KEY" }` → transport 解析 `env["AGENTOS_GMAIL_OAUTH_KEY"]` = **token 本身**。一層。
   - `GMAIL_OAUTH_KEY_ENV`/`GCAL_OAUTH_KEY_ENV` 常數本身須 match `SAFE_ACTION_ENV_KEY`(是;大寫識別字)→ `toCredentialEnv` 正常產 placeholder。
2. **`liveGmailPreflight`**(action-live-gmail-runner.ts):`AGENTOS_GMAIL_OAUTH_KEY` 現在持有 **token**(secret),不再驗它是識別字——改為**只檢查非空**(未設/空白 → skip/blocked,固定 reason)。**仍絕不 echo 其值**(CRED-LEAK-FIX 的零洩漏不變)。移除/改寫「key-name 非法」分支(改成「token 未設」語意)。
3. **runner**(runGmailSelfSend):`opts.oauthKey` 語意從「key 名」變「token 直放於 AGENTOS_GMAIL_OAUTH_KEY」——對齊(它把 oauthKey 設進 process.env[GMAIL_OAUTH_KEY_ENV],現在 GMAIL_OAUTH_KEY_ENV 就是 token 的家,一致)。確認 transport 解析鏈端到端對。
4. 不改 transport / connector / guard / pipeline(它們本就用 placeholder + env 解析,一層/兩層只差「key 名來源」)。

## (2) 不變量
- **一層可用**:`AGENTOS_GMAIL_OAUTH_KEY=<token>` → 端到端解析出該 token 進 Authorization(egress)。
- **credential-blind 不變**:placeholder 只在 transport egress 解析;brain/audit/WORM/projection/log 只見 placeholder;script 零 env 值 echo(CRED-LEAK-FIX)。
- **fail-closed 不變**:token 未設/空白 → skip/blocked,不送,不 echo。
- **byte-identical(其他)**:transport/connector/guard/pipeline 行為不變;只改 key 名來源 + preflight 檢查。無新依賴。

## (3) Test-first plan（RED 先行;fake env/transport,無網路)
- `toCredentialEnv` 鏈:gmail.send binding 的 toCredentialEnv → `{ AGENTOS_GMAIL_OAUTH_KEY: placeholderForKey("AGENTOS_GMAIL_OAUTH_KEY") }`;transport resolveCredentialHeaders 對該 placeholder + `env={AGENTOS_GMAIL_OAUTH_KEY:"ya29.<canary>"}` → Authorization "Bearer ya29.<canary>"(egress);canary 不入 WORM/projection。
- `liveGmailPreflight`:`AGENTOS_GMAIL_OAUTH_KEY` 設(任意非空,含 token-shape)+ 其他齊 → **ok**(不再因 `.` 被擋);未設/空白 → skip/blocked,固定 reason,**不含值**(canary 測)。
- 端到端 runner(fake transport):`AGENTOS_GMAIL_OAUTH_KEY=ya29.<canary>` + live + allowlist + account 符 → 過 governed pipeline → transport 收到 Authorization 含解析值;canary 不入 WORM/boundary/trace。
- mutation:toCredentialEnv 又改回讀「值」當 key → 一層測翻紅。
- byte-identical:既有 transport/connector/guard/ACT 全測續綠(必要處更新 key-name 期望)。

## (4) Definition of Done（實測）
- [x] **DONE（merged)**:`toCredentialEnv(GMAIL_OAUTH_KEY_ENV/GCAL_OAUTH_KEY_ENV)`(常數名當 placeholder key;gmail.send/gmail.search/calendar.events.create)+ `liveGmailPreflight` 改非空閘(移除識別字驗證 + 兩層 teaching 分支;仍零 echo)+ 移除 dead 兩層 process.env mutation。RED → verify **exit 0**(1681 passed + 29 skipped;RED 前 10 failed;**re-read-value-as-key mutation 翻 3**)。獨立 Opus4.8 review **PASS**:**一層下零-echo 仍成立**(真 .sh skip-config canary grep=0、preflight reason ok/skip 皆 value-free)、一層端到端(`AGENTOS_GMAIL_OAUTH_KEY=<token>`→egress Authorization)、credential-blind 不變(canary 只在 transport egress、不入 WORM/projection/trace)、fail-closed、byte-identical(transport/connector/guard/pipeline UNCHANGED)、無新依賴。footgun 移除。
- **live 仍需有效 token**(ya29. ~1h,過期→Google 401,非 bug)。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(toCredentialEnv key 來源 + preflight 檢查)。
- Depends-on:CRED-LEAK-FIX(preflight/零 echo)、ACT3-live(transport/runner)、ACT3a(connector/placeholder)。Blocks:重跑 live drive(改後使用者現有一層 ~/.env 可直接用)。
- **誠實前提**:一層 = `AGENTOS_GMAIL_OAUTH_KEY` 直接持 token,直覺且移除 footgun;security 與兩層等價(token 都在某 env var,都是 secret,都零 echo)。**live 仍需有效 token**——ya29. 約 1h,過期則 Google 回 401(token 過期非 bug)。
