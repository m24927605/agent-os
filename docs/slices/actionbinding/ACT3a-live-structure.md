# SLICE-ACT3a-live-structure: GoogleActionConnector（descriptor → Google REST 請求映射;host 釘死;過 guard)

- **Phase**: ActionBinding — Slice 3a-live（結構部分:真連接器的請求映射 + host-pin + credential placeholder,fake-transport-proven)
- **Branch**: slice/act3a-live-structure
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機 + 誠實前提（最重要)
使用者選 governed live 路徑。**真上線需 GCP OAuth app + 你 consent + 真 token + 真 HTTP transport = BLOCKED(你的部署 + 明確 go-live)**。本刀建**可 verify-proven 的連接器結構**:`GoogleActionConnector` 把 `ActionDescriptor{service,method,params,env?}` 映射成 **Google REST 請求**(method/url/headers/body),host **per-service 釘死**,credential 走 **placeholder**(連接器永不持有真 token),全程過 **ACT3a-guard**。
- **誠實**:Google API 請求形狀依**官方文件**寫,**Fake HTTP transport 只證「連接器組出該形狀」**;**真 Google 是否接受 = BLOCKED 的 live 步驟**(不宣稱 live 過)。憑證解析(placeholder → 真 token)在 egress = EXEC2-class,未落。

## (1) 範圍
1. **`HttpActionTransport` port**:`request(req: {method, url, headers, body?}): MaybePromise<{status: number, body?: string}>`。`FakeHttpActionTransport`(記 req、回 canned)。**真 transport(打 googleapis.com,經 egress)= BLOCKED**。
2. **`createGoogleActionConnector(http: HttpActionTransport): ActionConnector`**:
   - **host per-service 釘死**:`gmail` → `gmail.googleapis.com`、`drive` → `www.googleapis.com`、`calendar` → `www.googleapis.com`(常數表)。未知 service → refuse(transport 不呼叫)。**這是 ACT1 誠實點的落實:連接器只打它釘死的 host,descriptor 改不了**。
   - **per-(service,method) 請求 builder**(本刀:`gmail.send` + `drive.read`):
     - `gmail.send`:`POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,body = `{ raw: base64url(RFC822 from params.to/subject/body) }`(依官方文件)。
     - `drive.read`:`GET https://www.googleapis.com/drive/v3/files/{fileId}?alt=media`(依官方文件)。
     - 未知 method → refuse。
   - **credential**:`descriptor.env` 的 placeholder(`openshell:resolve:env:KEY`)→ `Authorization` header **值就是 placeholder**(真 transport 在 egress 解析成 token;**連接器永不持有真 token** → credential-blind)。無 env → 無 auth header(unauthenticated-to-allowlisted,= net.fetch 誠實點)。
   - 回 `ActionResult`(由 response status 判 ok)。
3. **過 guard**:`createGuardedActionConnector(createGoogleActionConnector(fakeHttp), config)`——guard(ACT3a-guard:live-off-by-default + test-account allowlist)包在外層。
4. **不接真 transport / 不做 OAuth / 不真寄**(BLOCKED)。

## (2) 不變量
- **host-pin(substrate-PRIMARY 落實)**:連接器只打 per-service 釘死的 host;未知 service / 無法映射 → refuse(transport 不呼叫)。**descriptor 無法 retarget 到別的 host**。
- **credential-blind**:Authorization 值是 placeholder,**連接器永不持有/log 真 token**;Fake transport 收到的是 placeholder(測斷言無真 token)。
- **deny-by-default**:未知 service/method → refuse;guard 在外層(live-off → refuse,連接器/transport 都不碰)。
- **fail-closed**:transport throw / 非-2xx → ok:false。
- **byte-identical**:純加(新 transport port + connector);未接真 transport;guard 來自 ACT3a-guard。無新依賴(用 node 內建或既有;Fake 不需網路)。

## (3) Test-first plan（RED 先行;Fake HTTP transport,無網路)
- `gmail.send {to,subject,body}` → transport 收到 `POST gmail.googleapis.com/.../messages/send`,body 是 base64url RFC822(解回含 to/subject/body),Authorization = placeholder。
- `drive.read {fileId}` → `GET www.googleapis.com/drive/v3/files/<id>?alt=media`。
- 未知 service(如 descriptor.service="evil")→ refuse,transport **不呼叫**。
- 未知 method → refuse。
- credential-blind:Authorization 值 == placeholder(非真 token);注入「真 token 樣 string」進 env → 仍只傳 placeholder(連接器不解析)。canary:descriptor 帶 canary token → transport req 無 canary(只 placeholder)。
- **過 guard 端到端**:guard live-off → refuse,GoogleActionConnector **不呼叫**、transport 不呼叫;guard live-on + 測試帳號(Fake resolver)→ 才到 GoogleActionConnector → transport。
- fail-closed:transport throw → ok:false;非-2xx → ok:false。
- mutation:host-pin 改成吃 descriptor 的 host → unknown-service 測翻(本該 refuse)。
- byte-identical:既有全測不變綠。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(`HttpActionTransport` port + `FakeHttpActionTransport` + `createGoogleActionConnector`〔host-pin + gmail.send/drive.read builder + placeholder auth〕+ 過 guard;未知 service/method refuse;credential-blind〔placeholder-only,canary 不入 req〕;fail-closed;host-pin 不吃 descriptor host;byte-identical;mutation 證;depcruise/secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純加 transport port + connector)。
- Depends-on:ACT1(ActionDescriptor/ActionConnector)、ACT3a-guard(createGuardedActionConnector)、credential placeholder。Blocks:**ACT3a-live-real**(真 HttpActionTransport〔經 egress 打 googleapis.com〕+ 真 token 解析〔OAuth/SecretResolver/EXEC2〕+ 真 AccountResolver + 真寄;需 GCP OAuth app + 你 consent + go-live)。
- **誠實前提**:本刀 = 連接器**結構**,Google REST 形狀依官方文件、**Fake transport 證形狀**(非 live 驗證)。**BLOCKED**:真 Google 接受、真 token、真網路、GCP OAuth app。連接器 host-pin 確保只打釘死 host(substrate-PRIMARY 落實);credential-blind(placeholder-only)。`mrfed1913@gmail.com` 等帳號 = 你的 `AGENTOS_ACTION_TEST_ACCOUNT` env config,**不入程式碼**。
