# SLICE-ACT3-live: 真 transport + account resolver + live self-send runner（runtime-direct)

- **Phase**: ActionBinding — Slice 3-live（接通真 Google:真 HTTP transport + 真 AccountResolver + live runner)
- **Branch**: slice/act3-live
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機 + 姿態（誠實)
使用者完成 GCP OAuth(拋棄式帳號 mrfed1913)。本刀接通**runtime-direct** live 路徑:agent-os 的 transport(actor)在 **egress 邊界**從 env 解析 `openshell:resolve:env:KEY` → node fetch 打 googleapis.com。**credential-blind-to-brain/audit/WORM/projection 全程成立**(只有 transport 這個 actor 解析真 token)。**生產級最強姿態 = sandbox SecretResolver(EXEC2)讓 runtime 連 token 都不持有**;本刀的 runtime-direct 對拋棄式測試帳號是合理且誠實的第一條 live 路徑。
- **fake-proven**(verify 內):transport 的 placeholder-resolution + resolver 的 parse(用 fake http,**無真網路**)。**真 fetch 只在 operator 跑 runner 時觸發**(模式同 `e2e:live-agt`)。

## (1) 範圍
1. **真 `createHttpActionTransport(env)`**(實作 ACT3a 的 `HttpActionTransport`):
   - `resolveCredential(headers, env)`(**純、可測**):header 值若是 `openshell:resolve:env:KEY` → 換成 `env[KEY]`;非 placeholder → 原樣;`env[KEY]` 缺 → **fail-closed**(回 error,不打網路)。
   - 真 `request()`:解析後 `fetch(url,{method,headers,body})` → `{status, body}`。**fetch 只在 live runner 跑**(測用 fake)。
2. **真 `createGoogleAccountResolver(http)`**(實作 ACT3a-guard 的 `AccountResolver`):用 token 向 Google `oauth2/v3/userinfo`(或 tokeninfo)取 `email` → 即「作用帳號」(餵 guard 比對 `AGENTOS_ACTION_TEST_ACCOUNT`)。parse 可測(fake http 回 canned userinfo);error → undefined → guard deny。
3. **live runner** `scripts/act-live-gmail.mjs` + `scripts/e2e-live-gmail.sh` + package.json `e2e:live-gmail`:
   - env 未設 → **skip**(同其他 e2e:live-*,不 fake-green)。
   - wire 完整 governed pipeline(ACT1c join 樣式)+ in-memory WORM appender + `deps.effect = bindingWrappedActionEffect(createGuardedActionConnector(createGoogleActionConnector(createHttpActionTransport(env)), guardConfig), actionBindings)`。
   - guardConfig:`live=actionLiveFromEnv`、`testAccounts=testAccountsFromEnv`、`resolveAccount=createGoogleAccountResolver`。
   - 跑 **一封 self-send**:`gmail.send {to: AGENTOS_ACTION_TEST_ACCOUNT(自己), subject:"agent-os live test", body:"…"}`。
   - 印治理 trace(screen/authorize/egress/approval/commit-before-effect/boundary)+ 結果;send 前 runner 印「about to send to <account>」(operator 明確跑 = 確認)。
4. **不改** pipeline/exec/ACT1/ACT2/ACT3a-guard/ACT3a-structure 邏輯(純加真 adapter + runner)。

## (2) 不變量
- **credential-blind**:placeholder 只在 transport 的 egress 邊界解析;brain/authorize/projection/WORM/boundary 全程只見 placeholder(self-send 的真 token 不入任何 sink)。env 缺 KEY → fail-closed(不打網路)。
- **治理全程**:live send 走完整 `runGovernedToolCall`——egress fold(只允許 gmail host)、approval(gmail.send destructive → 需 pre-auth)、commit-before-effect(WORM append + receipt 先於 send)、boundary(post-effect)、guard(live-on + 帳號 ∈ allowlist)。任一不過 → 不送。
- **fail-closed**:env 未設 → runner skip;guard live-off / 帳號不符 → deny,不送;transport 解析失敗 / 非-2xx → ok:false。
- **verify 不打網路**:transport.resolveCredential + resolver.parse 用 fake http 測;真 fetch 只在 runner(operator-run,verify 不跑)。
- byte-identical:純加;既有全測不變。無新依賴(用 node 內建 `fetch`)。

## (3) Test-first plan（RED 先行;fake http,無真網路）
- `resolveCredential`:`openshell:resolve:env:K` + env[K]="ya29.x" → header 變 "Bearer ya29.x"(在 transport 內、egress);env[K] 缺 → fail-closed error,fetch 不呼叫;非-placeholder header → 原樣。
- transport.request(fake http):2xx → ok;非-2xx/throw → ok:false。
- `createGoogleAccountResolver`(fake http 回 `{email:"mrfed1913@gmail.com"}`)→ 回該 email;回 error/無 email → undefined。
- **runner wiring(fake transport + fake resolver)**:gmail.send self-send 過 governed pipeline → guard live-on + 帳號符 → connector → (fake)transport 收到 POST gmail host + Authorization=Bearer <resolved>;**canary token 不入 WORM/boundary**;guard live-off → 不送;帳號不符 → 不送;egress 非 gmail host → denied@policy。
- **credential-blind 端到端**:跑 runner-wiring 帶 canary token in env → WORM/boundary/projection 無 canary(只 transport 出口有解析後的值)。
- mutation:transport 略過 resolveCredential 的 fail-closed(env 缺仍打)→ 翻紅。
- byte-identical:既有全測綠。
- **live(operator,非 verify)**:`e2e:live-gmail` 設好 env → 真寄一封 self-send → 印 message id。env 未設 → skip。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(真 HttpActionTransport〔resolveCredential fail-closed + request〕+ 真 GoogleAccountResolver〔userinfo parse〕+ runner wiring〔governed pipeline + guard + connector + fake transport/resolver〕;credential-blind 端到端〔canary 不入 sink〕;egress/approval/commit-before-effect/boundary/guard 全程;fail-closed;verify 不打網路;byte-identical;mutation 證;depcruise/secret-scan clean;無新依賴〔node fetch〕);獨立 Opus 4.8 review PASS。
- [ ] **live drive(operator + 明確確認):** `e2e:live-gmail` 設 env(token 不入對話)→ 真寄 self-send → 收件確認。送前確認收件人/內容。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純加 transport + resolver + runner)。
- Depends-on:ACT3a-structure(GoogleActionConnector/HttpActionTransport port)、ACT3a-guard(AccountResolver port + guard)、ACT1(pipeline join 樣式)、credential placeholder。Blocks:無(這是 live 路徑收尾)。
- **誠實前提**:**runtime-direct** 姿態(runner 程序在 egress 解析+持有 token 去打 Google)——credential-blind-to-brain/audit/projection;**生產最強姿態 = sandbox SecretResolver(EXEC2)讓 runtime 不持有 token**,本刀對拋棄式測試帳號合理。Google REST 形狀依官方文件(ACT3a-structure 已建),**live drive 才真驗證 Google 接受**。真寄 = operator 明確跑 + self-send 最小風險。token 永不入對話/repo/log;只入 runner 程序的 env。
