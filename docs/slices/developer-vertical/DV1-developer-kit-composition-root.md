# SLICE-DV1: Developer kit composition root（最薄 in-tree 可跑:author→治理→WORM→獨立驗證）

- **Phase**: P4（Developer 垂直;第一條「作者→治理→WORM→開發者獨立驗證」的可執行主幹）
- **Branch**: slice/dv1-developer-kit-composition-root
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~240（`src/developer/bootstrap.ts` + e2e + barrel）、新增依賴 = 0、新模組 = 1(`src/developer`)
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-DV1 — 新增 composition root `createDeveloperKit(opts?)`(`src/developer/bootstrap.ts`),把 R9 的 `ToolRegistry`/`parseToolManifest`/`authorizeToolInvoke` + 治理核 `runGovernedToolCall` + commit-before-effect + WORM + R10 `replayTimeline` + R9-S5 釋出的 verifier,組成一條**自包含、可呼叫**的開發者主幹:`authorTool → runTool(governed)→ WORM → replayFold + verifyEvidenceChain(獨立)`。鏡像 `createPersonalShell`/`createEnterpriseFleet`,但**獨有 developer-facing INDEPENDENT VERIFIABILITY**(開發者不必信任 operator,自己重算+驗證鏈)。

## (2) Goal（一句話）
第一次把 Developer-surface 原語組成可跑 kit:作者註冊工具(registry deny-by-default)、經同一條治理管線執行、落 WORM,且開發者能**用釋出的 verifier 獨立驗證整條鏈**(READING ≠ ATTESTING)+ 純函數 forensic replay。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/developer/bootstrap.ts`:`createDeveloperKit(opts?: DeveloperKitOpts): DeveloperKit`,門面含:
    - `verifyToolManifest(manifest: unknown): ToolManifest` — 薄包 `parseToolManifest`(fail-closed;等同 CLI `manifest lint` 的 TS API)。
    - `authorTool(manifest: unknown): ToolBinding` — `ToolRegistry.register`(fail-closed:malformed/重複 name throw)→ `ToolBinding`。
    - `registeredTools(): readonly ToolManifest[]` — registry 唯讀快照。
    - `bundleRefFor(pattern: string): string` — helper `bundle://<pattern>`(credential-blind;不碰明文)。
    - `runTool(toolCall): Promise<...>` — 經 `runGovernedToolCall`,deps 的 **authorize = `authorizeToolInvoke(req, THIS registry, rules)`**(未註冊 tool **deny-by-default**;註冊則 delegate `evaluatePolicy`)+ screen(`screenBrainEvent`,credential 守門)+ cost(`InMemoryCostGate`)+ **commit-before-effect** seam(`createAuditEvent` 寫 WORM 取 receipt 才跑 effect)+ effect(`FakeSandboxAdapter`)。
    - `replayFold(uptoSeq?): TaskTimeline` — 薄包 `replayTimeline`(read-only,deterministic timelineHash)。
    - `verifyEvidenceChain(pubkey): Promise<VerifyResult>` — **spawn 釋出的 verifier**(`kernel/cmd/verifier`,`AGENTOS_VERIFIER_BIN` 覆寫)relay exit 0=intact/1=broken/2=bad-input → `{ok, length?, brokenAt?, reason?}`;**TS 端絕不重寫鏈驗證**(同 `src/cli/main.ts:102-132` process-boundary)。
  - barrel `src/developer/index.ts` 匯出 `createDeveloperKit`;由 `src/index.ts` re-export。
  - 經 barrel 消費(tools/orchestration/cost/audit/runtime*/policy);無 deep-import、無 vendor 進 core、無 cycle。
- Out-of-scope（明確不做,誠實標記）:
  - **`integrateWithPersonal`/`integrateWithEnterprise`** → 後續刀:需把 registry 注入 `createPersonalShell`/`createEnterpriseFleet` 的 authorize seam(目前 Personal authorize **寫死** allow `personal:*` + 只吃 boolean,bootstrap.ts:134-136),是跨-vertical 改動 + 自帶 review。DV1 先做**自包含 governed run**(registry-backed authorize),整合留 DVx。
  - **live kernel WORM**(注入 `wormSinkFor`/`readEntries`)+ **真 verifier binary 的 intact/broken 證明** → **DV2**(DV1 verify 用 hermetic test-double 證 spawn-relay 契約,gated e2e 我跑真 verifier)。
  - forensic replay 投影/foldedState schema 對齊 → **DV3**;Python plane demo → **DV4**。
  - snapshot/restore(R10-S2/S3)不依賴。

## (4) Design delta + 依賴方向
- 純組合層,**不改既有模組**(尤其不改 Personal/Enterprise);只新增 `src/developer/`。低耦合靠 DI(同 Personal/Enterprise)。
- 依賴方向(inward、acyclic):`developer/bootstrap` → `{tools, orchestration, cost, audit, runtime/brain, runtime/substrate, policy}` 皆經 barrel。
- **PUBLIC**:`createDeveloperKit(opts): DeveloperKit`;`verifyEvidenceChain` 的 spawn-relay 語意;registry-backed authorize。

## (5) Test-first plan（RED 先行）
`src/developer/bootstrap.e2e.test.ts`(createDeveloperKit 不存在 → import RED):
- **happy 全鏈**:`authorTool(9-field valid)` → `ToolBinding` 正確 pin(name/version/resourcePattern/action)→ `runTool`(該註冊 tool)→ executed + FakeSandbox + WORM 多一筆 AuditEvent → `replayFold()` deterministic timeline(steps 反映)。
- **registry deny-by-default(本垂直核心)**:`runTool` 一個**未註冊** tool → denied@authorize(WORM 不寫 effect-success)。
- **manifest guardrail**:`verifyToolManifest`/`authorTool` 對 destructive+no-approval → 拒(guardrail B);unknown field → 拒(`.strict`)。
- **credential-blind**:args 含 sk- secret canary(runtime 組裝)→ denied@screen;`bundleRefFor` 產 `bundle://` 值可過。
- **INDEPENDENT verify(moat,DV1 以 test-double 證契約)**:`verifyEvidenceChain` spawn 一個 stub verifier(`AGENTOS_VERIFIER_BIN`)→ relay exit 0→`{ok:true}`、1→`{ok:false,broken}`、2→`{ok:false,bad-input}`;**斷言 DeveloperKit 從不 import Go / 不在 TS 重算鏈**(grep/結構)。真 verifier binary 的 intact/broken = DV2(gated,我跑)。
- 首次 RED:import `./bootstrap.js` 失敗(exit≠0)。

## (6) Definition of Done（待實測填）
- [ ] RED:bootstrap 不存在 → e2e import 失敗 exit≠0。
- [ ] `pnpm run verify` exit 0(e2e 全綠:happy + registry deny + guardrail + credential-blind + verify-relay 契約;Personal/Enterprise 既有 e2e **不變**)。
- [ ] **registry-backed authorize 非 vacuous**:未註冊 tool → deny;mutation(authorize 略過 registry/always-allow)→ deny test 紅。
- [ ] **commit-before-effect**:AuditEvent 先落 WORM 才 effect(沿用既有 seam;mutation:effect 先 → 序列/happy 紅)。
- [ ] **INDEPENDENT verify**:`verifyEvidenceChain` spawn-relay test-double exit 0/1/2 正確映射;**確認從不 import Go 內部、不在 TS 重寫鏈驗證**(depcruise + grep)。
- [ ] credential-blind(canary runtime 組裝、不在 source、不出現在 timeline/verify 出口);depcruise/secret-scan clean。
- [ ] **誠實標記**:integrateWithPersonal/Enterprise = 後續(需 authorize-seam 改動);真 verifier binary + live kernel = DV2;verifier pubkey trust-root 外部化 = P4。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:authorize-always-allow、effect-before-audit、verify-relay 吞 exit code)。

## (7) Rollback
- `git revert <merge-sha>`(移除 `src/developer/`)。純組合、無既有模組改動、可逆。

## (8) Depends-on / blocks
- Depends-on:R9-S2(SDK barrel/manifest/registry/authorize)、R9-S3(CLI spawn-relay 樣板)、R9-S5(verifier release)、R10-S1(replayTimeline)、P2-I(runGovernedToolCall)、P2-C(commitgate)、P2-G(InMemoryCostGate)、Personal/Enterprise composition 樣板。
- Blocks:DV2(live + 真 verifier)、DV3(forensic replay 端點)、DV4(Python demo)、DVx(integrateWith*)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:DV1 證**自包含 in-tree** 的作者→治理→WORM→獨立驗證(verify 以 test-double 證契約);真 verifier binary intact/broken、live kernel、integrateWith*、Python runtime、pubkey trust-root = DV2/DVx/R11/P4。
