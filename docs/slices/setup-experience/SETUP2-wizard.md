# SLICE-SETUP2: `agentos setup` wizard + 宣告式 `agent-os.config.yaml`

- **Phase**: setup experience（從「doctor 驗證」到「一步產生 + 套用設定」)
- **Branch**: slice/setup2-wizard
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1.5 day（TS only;**零新依賴**——thin CLI 哲學)
- **狀態**: **DRAFT（待你核准開工 + 定 open decisions)**

## (0) 動機
SETUP1b 的 `agentos doctor` **驗證**前置;SETUP2 **產生 + 套用**——讀一份宣告式 `agent-os.config.yaml`(契合你「先提供 yaml」的直覺),驗證(fail-closed),把 Agent OS 的 governed MCP bin 註冊進 Hermes,再跑 doctor。**不做 TUI**(thin/zero-dep CLI + 宣告式 config 是定案)。

## (1) `agent-os.config.yaml`(固定淺 schema,zero-dep subset reader)
```yaml
openshell:                       # 必要
  endpoint: 127.0.0.1:17670
  mtlsDir: ~/.config/openshell/gateways/openshell/mtls
  image: ghcr.io/.../openclaw@sha256:...
kernel:                          # 必要(commit-before-effect)
  ingestEndpoint: 127.0.0.1:50051
spendguard:                      # 可選(設了即 gate;SETUP1a 已讓 bin 接)
  udsPath: /path/to/sidecar.sock
  budgetId: ...
  unitId: ...
  windowInstanceId: ...
# agt:                           # 見 open decision:AGT-on-bin endpoint adapter 是 follow-up
```
- 全為**非-secret**(端點/路徑/id);**絕不放金鑰**。reader = in-house **YAML-subset**(僅本固定 schema 的 `key: value` + 一層巢狀;**fail-closed**:非預期形狀 → throw,不猜)。(repo 無 YAML dep;此 reader 非通用 parser,僅讀本 schema。)

## (2) `agentos setup [--config <path>] [--print] [--non-interactive]`
1. **Load**:讀 `agent-os.config.yaml`(預設 `./agent-os.config.yaml` 或 `--config`)→ subset reader。**互動模式**:缺欄位用 Node 內建 `readline` 補問(零依賴);`--non-interactive` 則缺欄位即 fail。
2. **Validate(fail-closed)**:openshell.endpoint / kernel.ingestEndpoint 必填;spendguard 若有,topology(udsPath+budgetId+unitId+windowInstanceId)必須**完整**(部分 → 清楚報錯,沿用 IT1b 語義);bin 已 build(dist 存在)。**任一不合 → 非零 exit,絕不寫半套**。
3. **Build registration**:用 **HDI1 `buildHermesMcpAddArgv`**(或 `renderHermesMcpServersConfigYaml`)組 `agentos-exec` 條目,env = `{AGENTOS_OPENSHELL_ENDPOINT, AGENTOS_OPENSHELL_MTLS, AGENTOS_OPENSHELL_IMAGE, AGENTOS_KERNEL_INGEST_ENDPOINT}` +(若設)`{SPENDGUARD_UDS_PATH, SPENDGUARD_BUDGET_ID, SPENDGUARD_UNIT_ID, SPENDGUARD_WINDOW_INSTANCE_ID}`。SPENDGUARD_* 進 mcp_servers.env → **SETUP1a 讓 bin 接通 SpendGuard gate autonomous 路徑**。
4. **Apply(非破壞)**:
   - **互動**(預設,有 TTY):跑 `hermes mcp add agentos-exec …`(**Hermes 自己做 config.yaml 的非破壞 merge**;使用者答 discovery-first 的「Enable tools?」)。
   - **`--print` / headless**:印出 `renderHermesMcpServersConfigYaml` 區塊 + 目標路徑(`~/.hermes/config.yaml`),讓使用者手動 merge。**不自動 merge 使用者真實 config.yaml**(zero-dep 下對任意既有 config〔含 provider/auth + 既有 mcp_servers〕做安全 merge 很脆;交給 Hermes 或印出最安全)。
5. **Verify**:跑 **SETUP1b `doctorCommand`** → 最終 PASS/FAIL 報告 + 下一步。

## (3) ⚠️ 誠實 scope
- **SpendGuard**:SETUP2 完整 turnkey(config → mcp_servers.env → SETUP1a bin 接通)。
- **AGT**:`agt:` 的 yaml 化需 **AGT-on-bin endpoint adapter**(一個呼叫 AGT endpoint 的 `AgtSecondaryPolicy` evaluate)——那是 follow-up(env 帶不了 code)。**本刀:SpendGuard + bin 註冊 + doctor**;AGT 留待 adapter slice(屆時 config 加 `agt.endpoint` + bin 須補 `redactSecrets(combined.reason)`)。見 open decision。
- **setup 不啟動三個服務**(Hermes/OpenShell/kernel)——那是部署;doctor 檢查它們在跑。
- **不自動 merge 真實 config.yaml**(互動委派 hermes mcp add / headless 印區塊)。

## (4) 不變量
fail-closed 驗證(部分/malformed config → 非零、不寫半套)/ credential-blind(config/env 只非-secret;readline 不回顯敏感、輸出不印值;**絕不寫/印金鑰**)/ 非破壞(Hermes-owned merge 或 print,不脆性 auto-merge)/ zero-dep(in-house subset reader + readline)/ idempotent(`hermes mcp add` upsert)。

## (5) Test-first plan（RED 先行)
- subset reader:valid config → parsed 物件;malformed/非預期 → fail-closed throw。
- validate:openshell/kernel 缺 → 非零;spendguard 部分 → 報錯(沿用 IT1b);完整 → ok。mutation:部分 config 靜默通過 → 測翻紅。
- build:argv/區塊 含正確 env(SPENDGUARD_* 當設時);**無金鑰**(canary 測)。
- apply:`--print` 印出 renderHermesMcpServersConfigYaml 區塊 + 路徑(不跑 hermes);互動路徑用 injected spawner 斷言 `hermes mcp add` argv(不真跑)。
- verify:setup 末呼叫 doctorCommand(injected probes)。
- readline:缺欄位互動補問(injected input);`--non-interactive` 缺欄位 → 非零。
- 全程不印/不寫 secret(spy)。

## (6) Definition of Done（待實測填)
- [ ] `agentos setup`:RED → verify 綠(subset reader + validate fail-closed + build + apply〔--print / injected spawner〕+ doctor;readline 互動 + --non-interactive;zero-dep;credential-blind〔canary 不洩〕;manifest/verify/doctor 既有不變);各 mutation 證非空;獨立 Opus 4.8 review PASS。
- [ ] 文件:README 設定段補「`agentos setup`(填 `agent-os.config.yaml` → 套用)」為主路徑,doctor 為驗證。

## (7) Rollback
- `git revert`(新 setup subcommand + subset reader 純加法)。CLI 其餘不受影響。

## (8) Depends-on / blocks + ⚠️ 待你決定
- Depends-on:HDI1(`buildHermesMcpAddArgv`/`renderHermesMcpServersConfigYaml`)、IT1b(SpendGuard config 驗證語義)、SETUP1a(bin 接通)、SETUP1b(`doctorCommand`)、CLI thin switch、Node readline。Blocks:無。
- **待你決定**:① **config 格式**:in-house YAML-subset reader(建議,契合「yaml」)vs JSON(JSON.parse 零依賴更穩)vs 純互動(無檔)。② **apply 機制**:互動委派 `hermes mcp add` + `--print` headless(建議,非破壞)vs 嘗試 in-house 安全 merge(脆,不建議)。③ **AGT**:本刀只 SpendGuard,AGT 待 endpoint adapter follow-up(建議)vs 一併做 adapter。④ setup 是否一鍵帶起 kernel(本機 dev 便利)——建議**否**(部署事;doctor 檢查即可),避免 wizard 管理服務生命週期。
- **誠實前提**:SETUP2 = 產生 + 套用 + 驗證的 onboarding;SpendGuard turnkey,AGT 待 adapter;不啟動服務、不脆性 auto-merge;真信任根/ sandbox provisioning 仍部署事實。
