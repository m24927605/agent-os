# SLICE-CRED-HARDENING-GOOGLE: secret detector 認得 Google 憑證形狀（ya29./AIza/Bearer)

- **Phase**: hardening（ACT3a-live-structure reviewer 的 MINOR-1:credential-blind detector 不認得 Google token 形狀)
- **Branch**: slice/cred-hardening-google
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
共用 secret detector `SECRET_VALUE`(src/audit/redact.ts)目前認得 `sk-/gh[pousr]_/AKIA/xox/PEM/JWT`,但**不認得 Google 憑證形狀**——而我們正在做 Google 整合(ActionBinding/GoogleActionConnector),Google OAuth access token(`ya29.…`)、API key(`AIza…`)、generic `Bearer <token>` 正是該整合的憑證。`redactSecrets` + credential-blind INPUT guard(redactSecrets-changed 偵測)目前**對它們是盲的**——若一個真 `ya29.` token 流進 arg/env value,INPUT guard 不會擋。本刀補上,defense-in-depth。

## (1) 範圍
- 在 `SECRET_VALUE` regex 加 3 個 high-signal、低-false-positive 的 alternation:
  - `ya29\.[0-9A-Za-z._-]{20,}`(Google OAuth access token)
  - `AIza[0-9A-Za-z._-]{35}`(Google API key,AIza + 35 字)
  - `\bBearer\s+[A-Za-z0-9._-]{20,}`(generic bearer header 值;20+ token 字元)
- 不改 detector 介面 / 呼叫點(redactSecrets / SECRET_VALUE 既有用法不動);純擴充 pattern。

## (2) 不變量
- **更緊不更鬆**:純加 alternation → 偵測更多真憑證;既有 6 類仍偵測(no regression)。
- **低 false-positive**:`ya29.`/`AIza` 是 Google 專屬前綴;`Bearer ` + 20+ 字元 token 在 arg/env 幾乎必是憑證。
- **不誤判 placeholder**:credential placeholder `openshell:resolve:env:KEY` 含冒號(非 `[A-Za-z0-9._-]`)→ `Bearer ` 後最長連續匹配 run < 20 → **不匹配**(placeholder 不被當 secret,連接器不被誤擋)。明確測這點。
- **credential-blind INPUT guard 連動**:redactSecrets-changed 偵測 → 加了 pattern 後,`ya29./AIza/Bearer <token>` 在 params/env → INPUT guard 擋(fail-closed)。
- byte-identical 行為:不含這些形狀的既有輸入,redact 結果不變。無新依賴。

## (3) Test-first plan（RED 先行)
- redactSecrets:`ya29.<20+>` → REDACTED;`AIza<35>` → REDACTED;`Bearer <20+ token>` → REDACTED;**`openshell:resolve:env:GMAIL_KEY`(placeholder)→ 不變(不誤判)**;`Bearer x`(短)/ `AIza`(無尾)/ 純 "Bearer me" → 不誤判。
- no-regression:既有 `sk-…/ghp_…/AKIA…/xox…/PEM/JWT` 仍 REDACTED;benign 字串不變。
- INPUT guard 連動(若可在 redact 層測即可):一個 `ya29.` 在值 → redactSecrets 改變 → detector 視為 secret。
- mutation:移除新 alternation → ya29./AIza/Bearer 測翻紅(本該 redact)。
- byte-identical:既有 redact/audit/INPUT-guard/全測不變綠。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(SECRET_VALUE 加 ya29./AIza/Bearer;ya29./AIza/Bearer<token> redact;**placeholder 不誤判**;短/benign 不誤判;既有 6 類 no-regression;mutation 證;depcruise/secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(一條 regex alternation 擴充)。
- Depends-on:redact.ts(SECRET_VALUE / redactSecrets)、credential-blind INPUT guard(用 redactSecrets-changed)。Blocks:無。
- **誠實前提**:這是 **best-effort shape detector** 的擴充(非完備)——非標準形狀的憑證仍可能漏(R9b-1 的既有誠實點:shape-only redact,非完備)。本刀只把 Google 整合最常見的 token 形狀納入,縮小盲區;真 no-leak 的根本保證仍是「憑證走 placeholder、egress 才解析、絕不進 arg/env raw」的設計,detector 是補強層。
