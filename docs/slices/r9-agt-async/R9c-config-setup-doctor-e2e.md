# SLICE-R9c: AGT config/setup/doctor + gated e2e（R9 收尾)

- **Phase**: R9 — 第 3 刀（onboarding 接通 AGT + gated live 驗證)
- **Branch**: slice/r9c-agt-config-doctor
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
R9b-2b 讓 AGT 在 autonomous 路徑參與,且 `integrationsFromEnv` 從 `AGT_UDS_PATH` 註冊。R9c 把 AGT 接進 **onboarding**:SETUP2 config.json 的 `agt` 區塊(目前被 `.strict()` 拒)→ setup 寫 `AGT_*` env → doctor AGT 檢查 → gated `e2e:live-agt`。完成後 AGT 端到端 turnkey(**除了真 Python sidecar——那是你的環境**)。

## (1) 範圍(鏡像 SETUP2/SETUP1b 樣式)
1. **SETUP2 config schema 加 `agt`**(src/cli/setup.ts `AgentOsConfigSchema`):新增 optional `agt: { udsPath: string; scope?: "effectful"|"all"; timeoutMs?: number }.strict()`(all-or-nothing:`udsPath` 必填於 agt 存在時;partial → fail-closed)。**移除/更新** :92-94 那段「agt must not be accepted」的註解(改為「agt = AGT advisory,udsPath 必填,scope/timeoutMs 選填」)。
2. **setup env-build 加 AGT_***(~:367):`if (config.agt) { env.AGT_UDS_PATH = config.agt.udsPath; if (scope) env.AGT_SCOPE = ...; if (timeoutMs) env.AGT_TIMEOUT_MS = String(...) }`。→ 寫進 bin 的 `mcp_servers.env` → R9b-2b `integrationsFromEnv` 接 → AGT gate autonomous 路徑。**全非-secret**(udsPath/scope/數字)。
3. **doctor 加 AGT 檢查**(src/cli/doctor.ts,**conditional**,鏡像 SpendGuard sidecar 檢查):`AGT_UDS_PATH` 設 → 檢查 UDS socket 可達(existsSync/connect)→ PASS/FAIL;未設 → **SKIP**「AGT off → advisory abstains」。credential-blind(只印 key 名/路徑類別,不印值)。
4. **gated `e2e:live-agt`**:`scripts/e2e-live-agt.sh` + package.json `e2e:live-agt` script(鏡像 e2e-live-spendguard)。對**真 AGT sidecar**(operator 提供;`AGENTOS_LIVE_AGT=1` + `AGT_UDS_PATH`)跑端到端:Hermes/bin → AGT-gated 決策。**未提供 → skip/blocked**(誠實標示,不假綠)。

## (2) 不變量
- **fail-closed**:partial `agt` config(無 udsPath / invalid scope / 非數字 timeoutMs)→ loadAgentOsConfig throw;doctor AGT 設了但不可達 → FAIL(非零)。
- **未配置 byte-identical**:無 `agt` 區塊 → 無 AGT_* env → R9b-2b 無 AGT secondary → 同今日;doctor 無 AGT_UDS_PATH → SKIP。
- **credential-blind**:config/env 只非-secret;doctor 不印值;setup 不寫金鑰。
- **gated**:`e2e:live-agt` 預設 skip(無 `AGENTOS_LIVE_AGT`),絕不在無真 sidecar 下假綠。
- zero new dep(node 內建 + 既有)。

## (3) Test-first plan（RED 先行）
- config schema:`agt: {udsPath}` 合法 → parse;partial(無 udsPath / invalid scope / timeoutMs 非數字)→ fail-closed throw;無 agt → ok(optional)。mutation:agt partial 靜默通過 → 翻紅。
- setup env:agt 配置 → env 含 AGT_UDS_PATH(+scope/timeout);無 agt → 無 AGT_*;canary(若有人塞 secret-shaped)→ 不洩(沿用 setup credential-blind)。mutation:agt 設了卻沒寫 AGT_UDS_PATH → 翻紅。
- doctor:AGT_UDS_PATH 設 + 可達 → PASS;設 + 不可達 → FAIL(非零);未設 → SKIP(不致敗)。mutation:AGT 設了不可達卻回 0 → 翻紅;不印值(spy)。
- e2e:live-agt:無 `AGENTOS_LIVE_AGT` → script skip(exit 0 + 明示 skipped);**不在 verify 內**(gated)。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(config agt 區塊 + setup AGT_* env + doctor AGT conditional;fail-closed〔partial agt / 不可達〕;**未配置 byte-identical**;credential-blind;gated e2e skip-by-default;mutation 證;depcruise/secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(schema agt 區塊 + setup env + doctor 檢查 + e2e script 純加法;未配置 byte-identical)。
- Depends-on:SETUP2(config/setup)、SETUP1b(doctor)、R9b-2b(integrationsFromEnv AGT)、gated-e2e 樣式。Blocks:無(R9 收尾)。
- **誠實前提**:R9c 讓 AGT onboarding turnkey;**真 AGT live 仍 BLOCKED on operator 的 Python sidecar**(`e2e:live-agt` 是那條 gated 路徑,你提供 engine 才能跑)。在那之前,AGT plumbing(R9a/b-1/b-2a/b-2b/c)全 fake-transport 證實 + 未配置 byte-identical。
