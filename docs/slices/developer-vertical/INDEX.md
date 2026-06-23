# Developer 垂直切片 — 把已建 R9+R10 原語組成「作者→治理→WORM→獨立驗證」的可跑 kit(INDEX)

> 2026-06-23。目標:把 R9(SDK barrel / manifest+registry / Python credential-blind shim / CLI / authoring
> templates / verifier-release WASM)+ R10(forensic-replay fold / snapshot / restore / verifier-recognizes-
> RestoreEvent)+ 治理核 + commit-before-effect + WORM,**組裝成一條可執行的開發者主幹**:
> `author ToolManifest → credential-blind SDK → runGovernedToolCall → WORM → 第三方獨立驗證 / forensic replay`。
> 核心護城河 = **developer-facing INDEPENDENT VERIFIABILITY**(開發者/稽核員不必信任 operator,自己重算+驗證整條
> WORM 鏈;READING ≠ ATTESTING)。grounded 研究見 task ws6xoh4ep。樣板 = createPersonalShell + createEnterpriseFleet。
> 方法論:[`looping-engineering.md`](../../standards/looping-engineering.md)。

## 0. 唯一缺口 = composition root
R9 + R10 **全部 DONE & merged**(各有 RED/contract 測試),治理核(runGovernedToolCall / commit-before-effect / WORM / PDP / cost / credential screen)已被 Personal/Enterprise 兩個 composition root 證明可組裝。但**全 repo 無任何 src 檔把它們組成可跑的開發者主幹**(`src/developer/` 不存在;`grep createDeveloperKit` 零命中)。CLI 是 tool,不是 composition root。本垂直補上 `createDeveloperKit` + **作者→治理→WORM→獨立驗證**的端到端證明。

## 1. 已建原語（grounded,file:line）
- **R9-S2 SDK author barrel**:`src/sdk/index.ts` 只導出 `ToolManifest`+`parseToolManifest`+4 Ports(BrainAdapter/SandboxAdapter/CostGate/AgentHosting)+ in-tree Fakes;**anti-leak**:不導出 policy/audit 內部(測 src/sdk/index.test.ts;deep-import → not-to-internal 違規)。
- **R9-S2 工具契約**:`src/tools/manifest.ts`(Zod `.strict` 9-field + guardrail A〔none⇒idempotent〕/B〔destructive⇒requiresApproval〕;`parseToolManifest` fail-closed);`src/tools/registry.ts:30-36` `ToolRegistry.register`(malformed/重複 name throw → `ToolBinding{name,version,resourcePattern,action}`);`src/tools/authorize.ts` `authorizeToolInvoke(req, registry, rules)`(未註冊 tool **deny-by-default** → delegate `evaluatePolicy`)。
- **R9-S1 Python credential-blind shim**:`python/agentos_shim/shim.py:48-66` `to_bundle_ref_tool_call`/`_assert_bundle_ref_only`(args 只允許 `bundle://` 前綴;字面 secret → `ValueError`,從不 echo)+ import-linter forbidden contract。
- **R9-S3 CLI**:`src/cli/main.ts` `manifest lint`(exit 0/1)、`verify --chain --pubkey`(spawn verifier,relay exit 0/1/2,`AGENTOS_VERIFIER_BIN`)。
- **R9-S4 authoring**:`src/sdk/templates/index.ts` + `tool-manifest.example.json`(byte-equivalent 已測)。
- **R9-S5 verifier release**:`kernel/cmd/verifier/{main.go,verify_bytes.go:28,wasm_main.go}`(standalone + WASM;IO-free `verifyChainBytes`;**depguard 禁 import internal/log**;fail-closed exit 0/1/2)。
- **R10-S1 forensic replay**:`src/orchestration/replay.ts:114` `replayTimeline(events, uptoSeq)`(純 left-fold,deterministic `timelineHash=sha256(redact(canonical))`,ReplayError fail-closed)。
- **R10-S2/S3/S5/S6**:`snapshot.ts`(SnapshotRecord `.strict` credential-blind)、`restore.ts:125` `runRestore`(forward-append FSM,attester≠actor)、kernel verifier 認得 RestoreEvent、brain-memory-versioning port。
- **整合對象**:`createPersonalShell`(src/personal/bootstrap.ts:129)、`createEnterpriseFleet`(src/enterprise/bootstrap.ts:216)。

## 2. 端到端呼叫鏈（grounded）
1. 作者寫 ToolManifest(`templates/tool-manifest.example.json`)→ `parseToolManifest` 驗證(fail-closed,guardrail A/B)。
2. `authorTool` → `ToolRegistry.register`(fail-closed)→ `ToolBinding`。
3. credential-blind:args 只放 `bundleRef`(Python shim `_assert_bundle_ref_only`;TS 端 `detectSecret`=redactSecrets-changed)。
4. `integrateWithPersonal`/`integrateWithEnterprise`:把 registry 注入既有 root 的 **authorize seam**(關鍵:讓 authorize 走 `authorizeToolInvoke(req, registry, allow)`,未註冊 tool deny-by-default)。
5. 同一條 `runGovernedToolCall`:screen(`screenBrainEvent`)→ authorize → cost(`InMemoryCostGate`)→ **commit-before-effect**(seam appender 先 `createAuditEvent` 寫 WORM 取 `AppendReceipt` 才跑 effect)→ effect。
6. WORM:`InMemoryAppendOnlyLog`(ed25519 鏈);live 注入 `wormSink=createIngestAppender(...).append`。
7. **forensic replay**:`replayFold` 薄包 `replayTimeline`(read-only,deterministic timelineHash)。
8. **INDEPENDENT 驗證**:`verifyEvidenceChain` **spawn 釋出的 verifier**(`kernel/cmd/verifier`)relay exit 0=intact/1=broken/2=bad-input——**TS 端絕不重寫鏈驗證**(同 CLI 的 process-boundary 模式)。

## 3. ⚠️ 護城河不變量 + 最高風險
- **INDEPENDENT VERIFIABILITY(本垂直獨有,Personal/Enterprise 未外顯)**:開發者/稽核員**不必信任 operator** 就能重算+驗證 WORM 鏈。by construction:① 鏈驗證下放給獨立 verifier(process 邊界;depguard 禁 import internal/log;verifier 只信手上 entries+checkpoint+作者**自備**的 pubkey)② 純函數重算(`replayTimeline` deterministic timelineHash)。**DeveloperKit 絕不在 TS 重寫鏈驗證**。
- **最高風險(必防)**:`createPersonalShell` 的 authorize 目前**寫死** allow `personal:*` + 只吃 `allowToolInvoke` boolean(bootstrap.ts:134-136,202-206),**未走 `authorizeToolInvoke(registry,...)`**。`integrateWithPersonal` 必須讓註冊 tool **真的過 registry deny-by-default**(否則整合是假的)。
- **verifier 信任根**:pubkey 外部化 = P4;「不信任 operator」目前只成立到「作者自備正確 pubkey」(錯 pubkey → exit 2)。WASM/release provenance(SHA-256SUMS 分發 + 完整性校驗)未串 → DV2 spawn 的 binary 若被替換則獨立性假設失效,需 checksum 步驟。

## 4. 切片分解（小、RED-first）
| Slice | 範圍 | 狀態 |
|---|---|---|
| **DV1** | 最薄 in-tree 可跑 Developer spine:`createDeveloperKit`(`src/developer/bootstrap.ts`)+ authorTool/verifyToolManifest/registeredTools/bundleRefFor + integrateWithPersonal/Enterprise(registry → authorize seam)+ replayFold + verifyEvidenceChain;**作者→治理→WORM→獨立驗證**全鏈 in-memory(零 kernel/docker/vendor)| ✅ **DONE**(registry-deny/commit-before-effect/spawn-relay moat 3 mutation 證實;Personal/Enterprise byte-unchanged;獨立 Opus4.8 review PASS)|
| **DV2** | 護城河真證明:暴露 kit pubkey + gated e2e(build 真 `kernel/cmd/verifier` + **checksum 對 SHA-256SUMS** → kit 的 ed25519-signed 鏈 `verifyEvidenceChain` → **intact〔跨語言 byte-match〕/ tampered→broken / wrong-pubkey→非零**)。**驗 live kernel 鏈撞 kernel-UNSIGNED(P2R-PV-S3a)→ 護城河證明改用 kit 自簽鏈,驗 kernel 鏈留後續** | ✅ **DONE + LIVE 3/3**(真 Go verifier 驗 TS 鏈 intact〔跨語言 byte-match〕、tamper→broken、wrong-pubkey→拒、checksum-verified;獨立 Opus4.8 review 親 re-ran PASS)|
| **DV3** | Forensic replay 端點:typed `ForensicState`(鎖定 `foldedState` 的 `unknown`)+ `projectWormToReplayEvents` 投影 helper + `replayFold` 與 `buildTaskTimeline` **對齊** + point-in-time `uptoSequence`(純函數,無 live)| ✅ **DONE**(typed ForensicState + projection + point-in-time + 1:1 對齊 buildTaskTimeline,7 mutation 證實;replay.ts/timeline.ts ZERO-diff;獨立 Opus4.8 review PASS)|
| **DV4** | Python plane 端到端 demo + 邊界證明:committed bundleRef-only proposal fixture(byte-equivalent 契約)+ Python 測試(shim 產它)+ TS 測試(讀 fixture → governed 管線 accepted + WORM)+ 雙重 credential-blind(Python ValueError / TS denied@screen)+ import-linter。**fixture/JSON 邊界,非 live runtime 整合(R11)** | ✅ **DONE**(byte-equivalent 契約雙向 pin + 雙重 credential-blind〔Python ValueError / TS denied@screen〕+ import-linter bite,5 mutation 證實;verify:py RAN;shim 核未動;獨立 Opus4.8 review PASS)|
| **DVx**(跨-vertical) | 三面共用一套治理:`createPersonalShell` + `createEnterpriseFleet` opts 加可注入 `toolRegistry`,authorize 改 registry-backed deny-by-default(缺省 byte-identical);跨面 e2e 證同一 registry 注入三面 → 已註冊工具三面 executed、未註冊三面 denied@authorize | ✅ **DONE**(三面共用同一 registry-backed deny-by-default;缺省 byte-identical;租戶隔離/WORM/PDP 不變;5 mutation 證實;獨立 Opus4.8 review PASS)|

## 5. 誠實風險（界定 P4/外部/R11 範圍）
- **verifier pubkey trust-root 外部化 = P4**(可信分發/釘選未建);WASM provenance/checksum 校驗未串 = P4。
- **Python runtime 整合 = R11**(S1 只是 import-time 結構保證;DV4 用 fixture/mock 證結構+credential-blind,**不宣稱 runtime 整合完成**)。
- **snapshot/restore(R10-S2/S3)雖 BUILT,DV1–DV4 不依賴**;forensic replay 只用 `replayTimeline`。restore+replay 的 demo = 後續。
- `replayFold` 的 `foldedState` 目前型別 `unknown`(replay.ts:33);DV3 須鎖定 schema 對齊,否則各 surface 各自詮釋。

## 6. 交付順序
DV1(in-tree,可跑,展示「作者→治理→WORM→獨立驗證」)→ DV2(live + 真 verifier + checksum)→ DV3(forensic replay 端點)→ DV4(Python plane demo)。每刀 doc-first + RED + `pnpm run verify` 綠 + 獨立 Opus 4.8 review + merge。
