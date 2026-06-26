# SLICE-CAP9: host-write-target primitive（host 寫入 seal 顯式化;deny-all default)

- **Phase**: capability breadth — Slice 9（最後一個 punches-seal primitive:host-fs-write 的對照,平行 CAP5 egress)
- **Branch**: slice/cap9-host-write-target
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
CAP5 把「網路 egress」變顯式 per-tool deny-all primitive。CAP9 對「host disk 寫入」做同一件事——把 sandbox 寫到 host 持久層(逃出 ephemeral sandbox)從隱形 deploy 事實變成**顯式、per-tool、canonical-path-allowlist、deny-all-by-default**。capability-containment **已有** `host-write-target` primitive + `host-fs-write → ["host-write-target"]`(CAP3),CAP9 **建這個 primitive 的機制**(讓 host-fs-write 工具日後可註冊)。**無 real host-write 工具**(合成 projection 證 PDP 防禦層)。

## (1) 範圍（精確平行 CAP5)
1. **`matchHostWriteTarget(path, allowedRoots): boolean`**(新 `src/policy/host-write-target.ts`,vendor-neutral):**lexical canonicalization**(不碰 FS:normalize `.`/`..` 段)+ **under-root 包含**(以 `/` 邊界 prefix-anchored,`/allowedX` 不算在 `/allowed` 下)+ **deny-by-default**(空 allowlist / 相對路徑 / 正規化後逃出 root〔`..` 越界〕→ deny)。**static reason**。
2. **`hostWriteDecisionForProjection(writeTargets, hostWriteAllow): PolicyDecision`**(平行 `egressDecisionForProjection`):任一 target 經 `matchHostWriteTarget` 不過 → deny(count-only reason);全過或無 writeTargets → allow。
3. **`GovernanceProjection.writeTargets`**(平行 `networkHosts`):host-write 工具的寫入目標路徑(projector 設;無工具 → 合成)。redact/bound(路徑是 metadata;沿用 redactSecrets shape + 上限)。
4. **`SandboxSpec.hostWriteAllow?`**(平行 `egressAllow?`):allowed roots;**absent/empty → deny-all**;OpenShell adapter 朝 host-mount policy 傳(best-effort;**真 kernel/mount 強制 = deploy fact**;proto 無欄位 → documented intent,誠實標)。
5. **bin closure 折入**:對有 `writeTargets` 的 tool 折 `hostWriteDecisionForProjection(writeTargets, binHostWriteAllow)`(與 PDP/egress/secondaries 並,any-deny-wins)。`binHostWriteAllow` 由 `AGENTOS_HOST_WRITE_ALLOW`(default 空 = deny-all)。**host-fs-write 工具無 projectable writeTarget → fail-closed deny**(平行 CAP6 net-egress fail-closed)。
6. **wire `"host-write-target"` 進 binWired**(耦合:host-write 有強制 ⟺ wired)→ host-fs-write 工具日後可在 bin 註冊。
7. **boundarySummary 加 writeTargets**(CAP7 allow-list:安全 metadata 路徑,**非 raw args**)。
8. **無 real host-write 工具**(合成「有 writeTargets 的 projection」端到端證)。

## (2) 不變量
- **deny-all default**:hostWriteAllow absent/empty → 任何 path deny;bin default config 空 → deny-all。
- **traversal-resistant(核心新件)**:`/allowed/../etc/passwd`→`/etc/passwd`(deny)、`/allowedX`(sibling prefix,deny)、`/allowed/../../x`(deny)、相對路徑(deny)、`/allowed/./x`→`/allowed/x`(allow)、trailing-slash/`//`正規化一致。**lexical only**——symlink 解析 = substrate(deploy)。
- **substrate PRIMARY、PDP defense-in-depth**:真強制 = sandbox host-mount + kernel realpath(symlink-resistant,deploy);PDP lexical check 補強(catches `..`/sibling/non-root;**symlink 滑過 lexical → substrate 為主**,誠實標)。
- **PDP 仍唯一 DENY**:hostWrite decision 折進 authorize(any-deny-wins);不放寬 PDP deny。
- **fail-closed**:host-fs-write 工具無 projectable writeTarget → deny(平行 CAP6)。
- **credential-blind**:writeTargets 是路徑 metadata,redact/bound;boundarySummary 只記安全衍生(無 argvRedacted)。
- **缺省 byte-identical**:無 writeTargets 的 tool(現 16 個全無)→ hostWrite 檢查不觸發;`hostWriteAllow?`/`writeTargets?` optional;既有不變。無新依賴。

## (3) Test-first plan（RED 先行）
- matcher:under-root allow;`..` 越界 / sibling-prefix(`/allowedX`)/ 相對 / 空 allowlist / 空 path → deny;`.`/`//`/trailing-slash 正規化一致;mutation:用 raw `startsWith`(無正規化)→ `/allowed/../etc` 測翻紅。
- `hostWriteDecisionForProjection`:全 target under root → allow;任一不在 → deny;無 writeTargets → allow;空 allowlist + 有 target → deny。
- **bin closure**:合成 tool `writeTargets=["/etc/passwd"]` + binHostWriteAllow=["/work"] → authorize **deny**;`["/work/out.txt"]` + 同 → 不因 hostWrite deny;**無 writeTargets → 不觸發**(byte-identical);host-fs-write containment 無 projectable writeTarget → fail-closed deny。mutation:closure 不折 → /etc/passwd 測翻紅。
- SandboxSpec.hostWriteAllow:absent → deny-all;adapter 傳遞 best-effort(deploy-intent,wire byte-identical)。
- boundarySummary:含 writeTargets(安全路徑),無 argvRedacted;canary 路徑經 redact/bound。
- byte-identical:既有 16 工具 + CAP1-8/6b 測不變綠。

## (4) Definition of Done（實測）
- [x] **DONE（merged)**:`src/policy/host-write-target.ts`——`canonicalizeAbsolute`(hand-rolled segment-stack,無 fs/realpath,relative/empty/escape→undefined)+ `matchHostWriteTarget`(under-root `/` boundary,`/allowedX` 不算)+ `hostWriteDecisionForProjection`(count-only reason)。`GovernanceProjection.writeTargets`(default [])+ `SandboxSpec.hostWriteAllow?`(deploy-intent,proto 無欄位)+ bin fold(`AGENTOS_HOST_WRITE_ALLOW`,default deny-all)+ host-fs-write 無 projectable writeTarget fail-closed + `binWired += "host-write-target"` + boundarySummary writeTargets(strict allow-list)。RED → verify **exit 0**(1511 passed + 29 skipped;**raw-startsWith mutation 翻 6/9、drop-fold 翻 3**)。獨立 Opus4.8 review **PASS,零 findings**:path fuzz 23 例無 traversal/sibling bypass(URL-encoded/NUL 當字面 child、case-sensitive、`/allowed/..`→`/` deny)、writeTargets-in-WORM credential-blind(非-string 剝除、count-only、無 argvRedacted)、fail-closed、deny-all、PDP-sovereign、symlink=deploy 誠實、byte-identical(16 工具 writeTargets=[])、**AGT wire 完全未碰**(toAgtRequest 不含 writeTargets)。
- **punches-seal primitive set 完成**:network egress(CAP5)+ host-write(CAP9)皆顯式 deny-all。**誠實**:真 host-write 強制 = deploy(host-mount + kernel realpath symlink-resistant);PDP lexical check = best-effort defense-in-depth;hostWriteAllow = documented deploy-intent。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(新 policy 模組 + optional 欄位 + bin 折入 純加;缺省 byte-identical)。
- Depends-on:CAP3(host-write-target primitive/classifier 已 wired)、CAP5(egress 平行樣板 + bin fold 樣式 + fail-closed)、R9b-1 projection(加 writeTargets)、SandboxSpec/adapter、CAP7 boundarySummary。Blocks:第一個 host-fs-write 真工具(屆時 containment host-fs-write + writeTargets projector,需 host-write-target wired〔本刀〕才註冊)。
- **誠實前提**:CAP9 是 **host-write-target primitive**(機制),**無 real host-write 工具**(合成 projection 證 PDP 防禦層)。**真 host 寫入強制 = deploy fact**(sandbox host-mount + kernel realpath,symlink-resistant);PDP lexical check 是 best-effort defense-in-depth(catches `..`/sibling/non-root;**symlink 需 substrate**)。`SandboxSpec.hostWriteAllow` 在 proto 無欄位的環境是 documented intent(平行 CAP5 egressAllow)。各面具體 allowed roots = config(default deny-all)。
