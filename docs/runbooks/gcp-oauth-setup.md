# Operator Runbook — GCP OAuth setup for the ActionBinding Google integration

**目的**:替 agent-os 的 governed Google ActionBinding(`gmail.send` / `drive.read` / `calendar.*`)取得 OAuth 憑證,綁定一個**專用測試帳號**(本例 `mrfed1913@gmail.com`)。

> ⚠️ **誠實前提**:完成本 runbook 你會拿到 OAuth client + token。但**這還不會讓 agent-os 真的寄信**——runtime 仍缺(a)真 HTTP transport、(b)credential 解析 at egress(EXEC2,未落)、(c)真 AccountResolver。GCP 是**必要前置**,非充分條件。token 是 deploy/runtime 才用得上的東西。
>
> 🔒 **憑證鐵律**:client_secret、access/refresh token **全是機密,絕不貼進與 Claude 的對話、不進 repo、不進 log**。它們只進你 runtime 的 env(由 egress SecretResolver 解析)。

---

## 0. 前置
- 用**測試帳號 mrfed1913@gmail.com**(或另一個 Google 帳號當「開發者」)登入 `console.cloud.google.com`。
- 用測試帳號當該 app 的 **test user**(下面步驟 3),這樣**不需 Google 驗證審查**即可授權 restricted scope(如 `gmail.send`)——前提是 app 停在 **Testing** 模式。

## 1. 建 GCP 專案
- Console 左上專案選單 → **New Project** → 命名(如 `agentos-sandbox`)→ Create → 切到該專案。

## 2. 啟用 API
- **APIs & Services → Library** → 各別搜尋並 **Enable**:
  - **Gmail API**(gmail.send 用)
  - **Google Drive API**(drive.read 用)
  - **Google Calendar API**(calendar.* 用)
  - 只啟用你要的;最小化。

## 3. OAuth consent screen
- **APIs & Services → OAuth consent screen**
  - User Type:**External** → Create
  - App name / User support email / Developer contact:填測試帳號 email 即可
  - **Scopes**:Add or Remove Scopes → 只加最小必要:
    - `https://www.googleapis.com/auth/gmail.send`(寄信)
    - `https://www.googleapis.com/auth/drive.readonly`(讀檔;或更窄的 `drive.file`)
    - `https://www.googleapis.com/auth/calendar.events`(行事曆)
  - **Test users**:Add Users → **加 `mrfed1913@gmail.com`**(必加,否則無法授權)
  - **保持 Publishing status = Testing**(不要 Publish to production → 免驗證審查)

## 4. 建 OAuth client
- **APIs & Services → Credentials → Create Credentials → OAuth client ID**
- **Application type**:
  - 若用下面步驟 5 的 **OAuth Playground**(最快、免寫程式)→ 選 **Web application**,並在 **Authorized redirect URIs** 加 `https://developers.google.com/oauthplayground`
  - 若 runtime 自己跑 loopback flow → 選 **Desktop app**
- 建好後拿到 **Client ID** + **Client secret**(secret 是機密——別貼我)。

## 5. 取得 token(最快:OAuth Playground)
- 開 `developers.google.com/oauthplayground`
- 右上**齒輪** → 勾 **Use your own OAuth credentials** → 貼你的 Client ID + Client secret
- 左側選 scopes(Gmail API v1 → `gmail.send`;Drive API v3 → 對應 readonly;Calendar API v3)→ **Authorize APIs**
- 跳轉時**用 mrfed1913 登入並同意**
- 回到 Playground → **Exchange authorization code for tokens** → 拿到:
  - **access_token**(`ya29.…`,約 1 小時有效)
  - **refresh_token**(用來換新 access_token;= runtime 的 token store,ACT3b)

## 6. token 放哪(runtime env,不經對話)
- 在你 runtime 的環境(非對話、非 repo)設:
  ```bash
  export AGENTOS_GMAIL_OAUTH_KEY="<access_token ya29.…>"   # 機密
  # calendar: AGENTOS_GCAL_OAUTH_KEY
  ```
- 配合先前的 config env(非機密):`AGENTOS_EGRESS_ALLOW=gmail.googleapis.com,www.googleapis.com`、`AGENTOS_ACTION_TEST_ACCOUNT=mrfed1913@gmail.com`、`AGENTOS_APPROVE_PREAUTH=…`、`AGENTOS_ACTION_LIVE=true`(只在要 live 時)。

---

## ⚠️ 重要限制(誠實)
1. **access_token 約 1 小時過期** → 靜態塞 `ya29.` 只能撐 ~1hr;持續使用需 **refresh_token 流程**(runtime token store = **ACT3b,未建**)。
2. **Testing 模式的 refresh_token 約 7 天過期**(Google 對未驗證 app 的政策)→ 沙盒可接受(到期重新授權);長期需 publish + 驗證。
3. **`gmail.send` 是 sensitive/restricted scope** → production/publish 才需 Google 驗證審查;**Testing 模式 + test user 免審**(故沙盒保持 Testing)。
4. **最小 scope**:只給動作需要的,別給 full Gmail/Drive。
5. 完成 GCP **仍不等於能寄信**:runtime 的真 transport + egress credential 解析(EXEC2)+ 真 AccountResolver 未落——那是 deploy 工作,GCP 只是其前置。

## 產出對應到 agent-os
- Client ID/secret + refresh_token → 你 runtime 的 secret store(ACT3b token 流程會用)。
- access_token → `AGENTOS_GMAIL_OAUTH_KEY`(連接器只發 placeholder,egress 解析此 env;= EXEC2)。
- 授權的帳號(mrfed1913)→ 必須等於 `AGENTOS_ACTION_TEST_ACCOUNT`(ACT3a-guard 鎖)。
