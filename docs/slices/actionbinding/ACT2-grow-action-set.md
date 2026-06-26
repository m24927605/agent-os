# SLICE-ACT2: 擴充 action set（calendar/drive.delete/gmail.search — 純加)

- **Phase**: ActionBinding — Slice 2（純加 read/write/destructive action,證 family 以 pure addition 成長)
- **Branch**: slice/act2-grow-action-set
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
ACT1 確立 ActionBinding port + gmail.send/drive.read。ACT2 以**純加**(ACT1 建立的 manifest+binding+projector triad 模式)擴充 action 目錄,證 family 像 exec seed-tools 一樣以 pure addition 成長、不放寬任何治理。仍 **fake-proven**(FakeActionConnector,無 real MCP/OAuth/network)。

## (1) 範圍（4 個新 action,皆 manifest+binding+projector + 條件註冊)
1. **`calendar.events.create`**:service "calendar"/method "events.create"、`containment:"network-egress"`、`sideEffect:"write"`(非 destructive → 無 approval,仍 egress-gated)、strict `{summary, start, end}`、actionProjector → networkHosts:["www.googleapis.com"](calendar host)+operationClass+無 params、toCredentialEnv → placeholder(`AGENTOS_GCAL_OAUTH_KEY`)。
2. **`calendar.events.list`**:read、network-egress、strict `{timeMin?, timeMax?}`(或最小 `{}`)、projector。
3. **`drive.files.delete`**:**destructive**(superRefine ⇒ requiresApproval:true)、network-egress、strict `{fileId}`、projector → networkHosts:[drive host]。
4. **`gmail.search`**:read、network-egress、strict `{query}`、projector。
- 全進 `seedActionRegistry`/`seedActionBindings`(條件註冊:network-egress→egress-allowlist;destructive→+approval)。
- 不改 port / pipeline / exec / ACT1 既有(純加)。

## (2) 不變量
- **pure addition**:不放寬任何 gate;每 action 一 manifest+binding+projector triad;ACT1 的 6 SEATBELT 性質對每個新 action 同樣成立(沿用同 join 機制)。
- **destructive→approval**:drive.files.delete superRefine 強制 requiresApproval(同 gmail.send);read/write 無 approval。
- **credential-blind / no-shell / projector-no-params**:同 ACT1。
- **註冊 gated**:每 action 因 network-egress 需 egress-allowlist wired;drive.files.delete 另需 approval。缺 → assertRegisterable throw。
- **缺省 byte-identical**:純加;ACT1 的 gmail.send/drive.read + 16 exec 工具 + 全測不變。無新依賴。

## (3) Test-first plan（RED 先行;FakeActionConnector)
- 每 action:在 wired{egress-allowlist[,approval]} 註冊成功;缺 primitive → assertRegisterable throw;strict(extra key 拒);argSchema 驗;projector networkHosts 非空 + 無 params。
- **drive.files.delete(destructive)端到端**:過 REAL runGovernedToolCall + Fake:無 pre-auth → denied@approval,Fake never called;pre-auth(AGENTOS_APPROVE_PREAUTH 含 drive.files.delete)+ allowlisted host → proceed → boundary event(無 params)。
- read/write(calendar.list/create、gmail.search):無 approval;egress-gated(非-allowlist→denied@policy;allowlisted→Fake.invoke);credential-blind(literal secret in params → INPUT guard deny)。
- byte-identical:ACT1 + exec/CAP 全測不變綠。
- (選)若 ACT1 有 action-conformance 風格的參數化斷言,新 4 action 自動納入。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(4 新 action manifest+binding+projector+條件註冊;drive.files.delete destructive→approval 端到端;read/write egress-gated + credential-blind;projector 無 params;registration-gated;**byte-identical**〔ACT1+exec 不變〕;mutation 證;depcruise/secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純加 4 action)。
- Depends-on:ACT1(port + seedAction* + join 機制)、manifest superRefine、capability-containment。Blocks:ACT3(真接線)。
- **誠實前提**:ACT2 = 純加 fake-proven action(同 ACT1 posture)。真 MCP/OAuth/network = deploy-gated(ACT3)。各 provider host 是 composer-fixed 常數(真 SDK 可能 resolve 別的 host → substrate PRIMARY,ACT3 connector 須拒未宣告 host)。
