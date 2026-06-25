# SLICE-CAP5: egress-allowlist primitive（seal 顯式化;deny-all default)

- **Phase**: capability breadth — Slice 5（先建 egress primitive,讓 network-egress 工具日後可註冊)
- **Branch**: slice/cap5-egress-primitive
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機 + open-q#2 的安全答案
brainstorm spine:先建 primitive 再開能力。CAP5 建 **egress-allowlist primitive**——把 sandbox 的 no-egress 從「隱形 deploy 事實」變成**顯式、per-tool、deny-all-by-default**。**open-q#2(每面 egress policy)的安全答案 = deny-all default 各面皆然**;哪些 host 允許 = deploy/config(operator/tenant 提供),default 空 = 拒一切。本刀建 primitive(機制),不訂各面具體 allowlist 內容(那是 config)。**無 real network 工具**(git.push/net.fetch = CAP6,需 credential)。

## (1) 範圍
1. **抽 egress matcher 為共用單一真相源**:把 `src/inference/egress-allowlist.ts` 的 deny-by-default、exact(case-insensitive)、fail-closed-on-empty、無 suffix/substring、static-reason matcher 抽到 vendor-neutral 模組(如 `src/policy/egress-allowlist.ts` 或 `src/runtime/substrate/`)。**inference 改 import 它**(行為 byte-identical;既有 inference 測續綠)。`matchEgressAllow(host, allowlist): boolean`。
2. **`SandboxSpec.egressAllow?`**(src/runtime/substrate/port.ts):`readonly egressAllow?: readonly string[]`(optional;**absent/empty → deny-all**,fail-closed)。OpenShell adapter `createSandbox` 把它朝 network policy 傳(best-effort;**真 kernel 強制 = deploy fact**——proto 若無對應欄位則為「documented intent」,誠實標)。
3. **PDP 防禦層 egress decision**(vendor-neutral):`egressDecisionForProjection(networkHosts: readonly string[], egressAllow: readonly string[]): PolicyDecision`——任一 host 經 `matchEgressAllow` 不過 → deny(static reason);全過或無 networkHosts → allow。這是 **in-repo 可測**的那層(substrate seal 是 PRIMARY;此為 defense-in-depth;networkHosts 是 best-effort,故 substrate 為主)。
4. **bin closure 折入**:bin 的 authorize closure 對有 `governanceProjection.networkHosts` 的 tool,折入 `egressDecisionForProjection(networkHosts, binEgressAllow)`(與 PDP + secondaries 並,any-deny-wins)。`binEgressAllow` 由 config(env,**default 空 = deny-all**)。
5. **wire "egress-allowlist" 進 bin WIRED**(耦合:egress 有強制 ⟺ "egress-allowlist" wired)——讓 network-egress 工具日後可在 bin 註冊(CAP3 gate)。
6. **無 real network 工具**(CAP6)。以合成「有 networkHosts 的 projection」端到端證 PDP 防禦層。

## (2) 不變量
- **deny-all default**:egressAllow absent/empty → 任何 host deny(matcher fail-closed-on-empty);bin default config 空 → deny-all。
- **exact / bypass-resistant**:`evil-api.allowed.example`、`allowed.example.evil.com`、bare `allowed.example`、leading/trailing-dot 變體 **不** match `api.allowed.example`(沿用 inference matcher 的測)。
- **substrate PRIMARY、PDP defense-in-depth**:真強制在 OpenShell network policy(deploy);PDP networkHosts 檢查是補強(best-effort,obfuscated/IP host 可能滑過 PDP → 故 substrate 為主、誠實標)。
- **PDP 仍唯一 DENY 權威**:egress decision 折進 authorize(any-deny-wins),不是第二 runtime path;不放寬 PDP deny。
- **缺省 byte-identical**:無 networkHosts 的 tool(現 14 個全無)→ egress 檢查不觸發;`egressAllow?` optional;inference 抽取後行為不變。
- credential-blind:egressAllow / networkHosts 非-secret;static reason 不洩。無新依賴。

## (3) Test-first plan（RED 先行）
- matcher(抽取後):exact pass;unknown/empty-allowlist/empty-host/suffix/substring/dot-variant → deny(沿用 inference 既有測 + 抽取後 inference 測 byte-identical 綠)。
- `egressDecisionForProjection`:networkHosts 全在 allowlist → allow;任一不在 → deny(static reason);無 networkHosts → allow;空 allowlist + 有 host → deny(deny-all)。
- **bin closure(核心)**:合成 tool 帶 `governanceProjection.networkHosts=["evil.com"]` + binEgressAllow=["api.allowed.example"] → authorize **deny**(egress);networkHosts=["api.allowed.example"] + 同 allowlist → 不因 egress deny(PDP/其他決定);**無 networkHosts → 不觸發**(byte-identical)。mutation:closure 不折 egress decision → evil-host 合成測翻紅(本該 deny)。
- SandboxSpec.egressAllow:absent → deny-all 述語;adapter 傳遞(best-effort,測 adapter 收到 egressAllow);**absent 不改既有 createSandbox 行為**(byte-identical)。
- byte-identical:既有 inference / substrate / bin / 14-tool / CAP1-4 測不變綠。

## (4) Definition of Done（實測）
- [x] **DONE（merged)**:`matchEgressAllow` 抽到 `src/policy/egress-allowlist.ts`(單一源;inference re-import,行為 byte-identical)+ `egressDecisionForProjection`(count-only deny reason,credential-blind)+ `SandboxSpec.egressAllow?`(optional,absent/empty→deny-all)+ OpenShell adapter 標 deploy-intent(proto 無 egress 欄位,wire request byte-identical)+ bin closure 折 egress decision(`AGENTOS_EGRESS_ALLOW`,default 空=deny-all)+ `binWired += "egress-allowlist"`。RED → verify **exit 0**(1388 passed + 29 skipped;policy 18 + inference 14 byte-identical + openshell 2 + cap5 bin 5 測;**neutralize-fold 翻 evil-host、suffix-weaken 同時翻 policy+inference、empty-host-guard 翻**;deny-all + bypass-resistant〔subdomain-prefix/suffix/substring/bare-parent/dot 全 deny〕;無 networkHosts byte-identical;depcruise no-vendor-in-core 綠+bite;secret-scan clean;無新依賴)。獨立 Opus4.8 review PASS。
- **⚠️ 誠實(reviewer 核實)**:OpenShell `CreateSandboxRequest` proto subset **無 egress 欄位** → `SandboxSpec.egressAllow` 是 **documented deploy-intent**(非捏造 wire 欄位;adapter request with/without 它 byte-identical)。**in-repo 唯一 active 強制 = PDP networkHosts fold(best-effort)**;substrate 強制是「provisioned 後的 PRIMARY 層」(deploy fact,proto 加欄位時在 adapter 設)。**非 overclaim**——「substrate PRIMARY」一致限定為意圖層非現狀。1 MINOR(allow-branch 也設 auditRequired:true = 更多稽核,更安全)。
- **egress primitive 就位** → CAP6(git.push/net.fetch:containment network-egress,需 egress〔本刀〕+ approval〔CAP4〕+ credential〔CAP6〕都 wired)。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(matcher 抽取〔inference re-import〕+ egressAllow? optional + egress decision + bin 折入 純加;缺省 byte-identical)。
- Depends-on:inference egress-allowlist(抽取源)、SandboxSpec/OpenShell adapter、R9b-1 projection.networkHosts、CAP3 WIRED/classifier、policy combineDecisions。Blocks:**CAP6(git.push/net.fetch:第一個 real network 工具,containment network-egress,需 egress〔本刀〕+ approval〔CAP4〕+ credential〔CAP6〕都 wired)**。
- **誠實前提**:CAP5 是 **egress primitive**(機制),**無 real network 工具**(合成 projection 證 PDP 防禦層)。**真 no-egress 強制 = deploy fact**(OpenShell network policy);SandboxSpec.egressAllow 在不強制的環境是 documented intent。PDP networkHosts 檢查是 best-effort defense-in-depth(substrate 為 PRIMARY)。各面具體 allowlist 內容 = config(default deny-all)。
