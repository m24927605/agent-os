# Capability Breadth — 擴充 governed 工具目錄(Workflow design judge-panel 結論)

- **Phase**: capability（讓「一台會自己操作的電腦」真的能做更多事——在不破壞治理不變量下擴充工具目錄）
- **狀態**: **BRAINSTORM DONE（Workflow:4 獨立 approach → 3-lens 評分 → synthesis)— 待你定方向 + open questions**
- **方法**: ultracode Workflow design judge-panel(非單次呼叫)。4 approach(capability-SDK / high-value-builtins / risk-first / brain-experience-fit)× 3 lens(product-value / governance-safety / build-pragmatism)→ synthesizer。

## (1) 推薦方向(spine = governance-fit,grafted)
**Spine = Approach 3「以治理契合度准入:先建缺的 primitive,再開 capability」**——3 lens 中 governance-safety 與 incrementality 都排第一(product-value 排它最後,但自承四案的高價值工具都卡在同一批未建 primitive,所以真正差別是「誰最快出真能力而不假裝 network/approval」)。

**唯一能讓「廣度永遠不超前安全」的排序**:能力只准許到「**現有 pipeline(screen→PDP+AGT→cost→commit-before-effect→effect)+ sandbox SEAL(ephemeral、zero-credential、no-egress、finally 銷毀)可證明地約束**」的程度:
- **住在 seal 內的能力**(in-sandbox 檔案寫、git、結構化編輯)→ 今天就能騎 pipeline,**先出**(純 `{manifest + binding + registration}`,如 HDI2a 的 cat/grep)。
- **打穿 seal 的能力**(network egress、credentialed/external/irreversible、host-disk 寫)→ **在對應 fail-closed primitive 建好(含 failing test)之前,連註冊都不行**。

**Graft**:Approach 2 的「最便宜的真能力先出」(in-sandbox write_file/apply_patch,零新 primitive)+ Approach 4 的「`tools/list` 是產品 affordance 單一真相源 + 可行動的 redacted deny-reason 是 brain 的自我修正通道」+ Approach 1 的「一個 registry-wide 參數化 conformance suite」(但作為**後期 consolidation**,非前期把 ExecToolBinding 搬家的大重構——incrementality judge 把 Approach 1 排最後正因其 Slice 1 重 home + 改 5 個測檔卻 4 刀零新能力)。

## (2) ⚠️ 一個 grounded 的潛在 fail-open(務必先修)
`requiresApproval` 在每個 manifest 都宣告、且 destructive 被 schema 強制(`manifest.ts:38`),**但 `runGovernedToolCall` 完全沒引用它**——destructive⇒approval 的 guardrail 是「寫了卻被 pipeline 默默忽略」。**任何 destructive/external 工具之前先補這個**(Slice 4)。

## (3) 9-slice 建構順序(小、test-first、保不變量)
1. **In-sandbox 檔案寫 + 結構化編輯**(零新 primitive,**先出**):`exec.write_file` / `exec.apply_patch` 純 binding 加法(HDI2a 樣式),`sideEffect:'write'`、`requiresApproval:false`(理由:限在 ephemeral sandbox,與 exec.run 同姿態)。content 永不進 shell 字串(grep 的 `--` literal-guard 推廣)。RED:unknown arg→deny、`; rm -rf /` 當位元組寫入不執行、tools/list 廣告 derived schema。
2. **In-sandbox git read/write**(仍在 seal 內):status/diff/log(read)+ add/commit(write),argvPrefix 固定。`argSchemaToJsonSchema` **加性**擴 bounded string-enum(仍 fail-closed throw)。**`git.push` 明確延後**(network/destructive 邊 → Slice 5/6)。
3. **Capability classifier + REFUSE-to-register gate**(純治理、無 feature):(sideEffect × containment〔inside-seal | punches-seal〕)→ 所需 primitive 表;composition-time 檢查:punches-seal 但 primitive 未建 → **拒絕註冊**。讓 Slice 5/7/9 結構上不可能過早出。PDP 仍是唯一 runtime DENY 權威(這是准入 gate,非第二 deny path)。
4. **把 `requiresApproval` 接進 pipeline**(修上面的 fail-open):commit-before-effect **前**加 approval stage,destructive/punches-seal 才觸發,走**既有** ApprovalInbox(Personal)/ `enforceMakerChecker`(Enterprise)——兩者已存在、接 injected runner / 純 deny-by-default,是**接線非新基建**。**範圍關鍵**:seal-confined 工具(Slice 1-2)維持 `requiresApproval:false` 不中斷自主迴圈。
5. **Egress-allowlist primitive on SandboxSpec**(先建 primitive):`egressAllow: string[]`(default empty = deny-all),VERBATIM 抬 `src/inference/egress-allowlist.ts` 的 exact-match deny-by-default matcher;**substrate 強制(PRIMARY)+ PDP 用 projection 的 networkHosts 做 defense-in-depth**。port 規則:契約測 + OpenShell & Fake adapter 都真 deny-all。**之後才**加第一個 network 工具。
6. **Credential-placeholder 接線 + authenticated git.push / net.fetch**:把既有但未用的 `toEnv` 縫接上 `placeholderForKey`/`toProviderEnv` + lease FSM(只發 placeholder,真 secret 在 OpenShell SecretResolver 於 sandbox 邊界解析)。makeExecEffect input guard 拒 literal secret、放行 placeholder。然後 `git.push`(destructive⇒approval〔Slice4〕+ egress-allowlisted〔Slice5〕)。credential 永不走 positional argv。
7. **External-effect boundary ledger**(audit,非 gate):effect 跨出 sandbox 邊界時 append 一個有別於 commit-before-effect intent 的 WORM event 種類。denied/aborted 不留 boundary event。記 projection,非 raw args。**非第二 deny 權威**。
8. **Registry-wide conformance suite**(grafted Approach 1,consolidation):有 2+ effect family 後,一個 `describe.each(registry.all())` 證每個 capability:strict-args deny-by-default、schema-no-drift、credential-blind I/O、commit-before-effect ordering、effectful⇒projector。刪 exec-seed-tools.test.ts 的逐工具手寫斷言。誠實:證不變量成立,非證 effectAdapter 行為正確。
9. **(最後,gated)Host-write-target allowlist + host-persistent edit**:`writeTargets: string[]`(canonical、prefix-anchored、無 `..`/symlink/unicode traversal、default deny-all)+ PDP filesystem-resource 檢查 + substrate mount 強制;content-addressed artifact(壞寫不覆蓋好寫;effect 仍不可逆)。排最後因為它**同時打穿 seal + 碰使用者真實磁碟**,且 path canonicalization 是經典陷阱。

## (4) 評分摘要
- **product-value** 排:catalog(4)> builtins(2)> SDK(1)> governance-fit(3)〔但自承全卡同批 primitive〕。
- **governance-safety** 排:**governance-fit(3)** > builtins(2)> catalog(4)> SDK(1)。
- **build-pragmatism** 排:**governance-fit(3)** > builtins(2)> catalog(4)> SDK(1)〔SDK 最後:大重構零新能力〕。
- SDK 作為 spine 被否(effectAdapter 是 in-process agent-os 碼、**非 sandbox-confined**,conformance 證不變量非 adapter 行為 → 在 seal-control primitive 之前降低「加 seal-punch effect」成本 = 淨安全負債);只留其 conformance-suite kernel 作 Slice 8。

## (5) ⚠️ 需人工判斷的 open questions
1. **Personal 自主 vs 人工 approval(Slice 4)**:Personal 單人自主迴圈上,destructive/external 的同步人工 approval 與「會自己操作」衝突。要 (a) 阻塞於互動 ApprovalInbox、(b) 在預授權 policy budget/allowlist 內 auto-approve、還是 (c) 僅在 'supervised' session 模式跑?(Enterprise 明確走非互動 maker-checker。)
2. **每面 egress 姿態(Slice 5)**:`egressAllow` 是 per-sandbox deny-all-by-default,但**誰**允許哪些 host 是 deploy/policy 決定(Personal 預設無?Enterprise tenant-provisioned?Developer 僅 localhost?)。預設 allowlist policy + 誰 provision?
3. **Capability provenance / 3rd-party 工具**:AGENTS.md 提 signed skill/agent 生態。現在先 1st-party-only(in-repo、reviewed),還是很快要納 signed 3rd-party CapabilityDef?(決定是否要在任何外部作者工具前先開一個 signing/provenance slice——目前不在 9 刀內。)

## (6) 誠實邊界
**做到**:沿安全排序擴目錄;**立刻出真 in-sandbox 能力**(write/edit/git read+commit);**先補 requiresApproval fail-open** 再開 destructive/external;把 seal 變**顯式 per-tool**(egressAllow/writeTargets,default deny-all);保 tools/list 為忠實單一真相源。**不做**:不讓 effect 可逆(no-undo 不變,復原靠 snapshot-restore;approval+ledger 只降風險+證明,不能撤銷);不治理**語意**意圖(AGT advisory only,能多拒不能限到安全子集、不能 grant);credential-blind 仍 best-effort(非標準 secret 殘留 → credential 必走 toEnv placeholder、projection 只給 AGT 不進 WORM/log);不證 Hermes **會用**目錄(需 live capstone);**不涵蓋 non-argv app/API 動作(Gmail/Calendar/Drive 類)或瀏覽器**——需 sibling ActionBinding port + substrate(in-sandbox headless browser / egress-governed API path),刻意不在這 9 刀。**Deploy 事實**:sandbox 真零憑證/no-egress/ephemeral;egressAllow/writeTargets 強制力只等於實際 provision 的 OpenShell network-policy/mount-config;SecretResolver-at-egress 需真 OpenShell streaming exec(EXEC2,未落)→ 在那之前 git 僅本地、net.fetch 僅 unauth-to-allowlisted。
