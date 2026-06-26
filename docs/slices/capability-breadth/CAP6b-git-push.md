# SLICE-CAP6b: `git.push` — 第一個真 destructive 工具（end-to-end 驗 approval+egress+boundary+credential)

- **Phase**: capability breadth — Slice 6b（CAP6 的 destructive 對照:第一個 destructive 真工具,端到端走完 seal-punch 治理鏈)
- **Branch**: slice/cap6b-git-push
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機 + 為何現在可做(CAP2 當時 DEFER 的理由已解)
CAP2 把 git.push DEFER(egress 非 argv-visible + 需 approval/egress primitive)。現 CAP4(approval)/CAP5(egress)/CAP6(net.fetch URL validator + hostname projector)/CAP7(boundary)都在。**git.push 取顯式 https URL**({url, branch})而非 remote 名 → **URL host 在 argv → projectable** → egress fold 能 gate(且躲過 CAP6「network-egress 無 projectable host→deny」fail-closed 規則)。git.push 是**第一個 destructive 真工具**,端到端驗:**approval(CAP4)+ egress(CAP5/6)+ boundary ledger(CAP7)+ credential placeholder**——這是 CAP4 approval gate 第一次在**註冊的真工具**上跑(CAP4 用合成工具)。

## (1) 範圍
1. **`git.push` 工具**:
   - manifest:`name:"git.push"`、**`containment:"network-egress"`**、**`sideEffect:"destructive"`**(manifest superRefine ⇒ **`requiresApproval:true` 強制**)、`idempotent:false`。
   - binding:`argvPrefix:["git","push","--"]`(`--` 守,若 `git push --` 不被 git 接受則去掉 `--`、靠下方 branch 驗證為唯一守)、`argSchema: z.object({ url: <https-validated>, branch: <strict branch-name> }).strict()`——**url 複用 `isAllowedFetchUrl`(https-only、拒 userinfo/IP-literal/…)**;**branch 嚴格 regex**(`^[A-Za-z0-9._/-]+$` 且不以 `-` 開頭——防 flag 注入);`toArgv:(a)=>[a.url, a.branch]`;**`toEnv` 發 git credential placeholder**(`placeholderForKey`,絕非 literal);**`governanceProjector`:networkHosts = `[new URL(url).hostname]`(複用 net.fetch 的 hostname 投影,非 buildExecRunProjection——確保 host 精確 == git 實連 host)**。
   - 註冊:network-egress + destructive → requiredPrimitives `["egress-allowlist","approval"]`;bin wired = `{"approval","egress-allowlist"}` → **git.push 可註冊**(條件註冊,平行 net.fetch;缺任一 primitive 的 composition → CAP3 refuse)。
2. **端到端(核心)**:git.push 在 bin 走完:**screen → authorize(PDP+egress fold:url host ∈ allowlist?)→ approval(budget approver:git.push ∈ AGENTOS_APPROVE_PREAUTH?)→ commit-before-effect → effect → boundary event(network-egress+executed)**。
3. **能力面 15 → 16**。
4. **不做**:remote-name push(egress 非 argv-visible)、SSH URL(host 投影不清)、真 auth(EXEC2)。

## (2) 不變量
- **approval 真 gate(第一個註冊真 destructive 工具)**:git.push pre-authorized(∈ AGENTOS_APPROVE_PREAUTH)→ approved → 跑;**非 pre-authorized → denied@approval,effect 0**;unconfigured pre-auth(deny-all)→ denied。
- **egress 真 gate**:url host ∈ allowlist → 過;非 → denied@policy(egress fold);default deny-all。url host projectable(顯式 URL)→ 躲過 fail-closed 規則。
- **boundary event**:git.push(network-egress)executed → boundary WORM event(`boundarySummary`:networkHosts/operationClass,**無 argvRedacted**——CAP7 修正後);denied(approval/egress)→ 無 boundary。
- **credential-blind**:toEnv 只發 placeholder;url 經 isAllowedFetchUrl(拒 userinfo);projection networkHosts host-only。
- **strict/no-shell**:url + branch 嚴格驗(branch 無 leading `-`/空白)→ 無 flag 注入;argv 純向量。
- **destructive⇒requiresApproval** 由 manifest superRefine 強制(不可 false)。
- 缺省 byte-identical:純加工具 + 條件註冊;既有 15 工具 + CAP1-8 測不變;advertised 15→16(僅 bin)。無新依賴。

## (3) ⚠️ 誠實前提
- **真 push 抵達 remote + credential 解析 = deploy/EXEC2-gated**(同 net.fetch):git 在 sandbox 是 deploy fact;真 egress 強制 = OpenShell network policy(deploy);credential placeholder 真值 = SecretResolver at egress(EXEC2,未落)→ git.push **unauthenticated-to-allowlisted-until-EXEC2**。
- **in-repo 真的是**:approval gate(真擋非-pre-authorized)+ egress gate(真擋非-allowlist host)+ boundary record + credential placeholder 縫。**fake-proven**(Fake substrate 記 argv;不真 push);LIVE 需真 sandbox + git + 網路 + credential。

## (4) Test-first plan（RED 先行;Fake substrate）
- 註冊:git.push 在 wired `{"egress-allowlist","approval"}` 的 bin 註冊成功;缺 approval 或 egress 的 registry → CAP3 refuse(throw)。manifest `sideEffect:"destructive"`+`requiresApproval:false` → parseToolManifest 拒(superRefine)。
- argv/strict:`{url:"https://github.com/o/r.git", branch:"main"}` → `["git","push","--","https://github.com/o/r.git","main"]`(或無 `--`);unknown key 拒;branch=`"--force"`/`"-d"`/含空白 → argSchema 拒(無 flag 注入);url=`file://`/userinfo/IP → 拒(isAllowedFetchUrl)。
- **approval gate(核心)**:bin + url host allowlisted + `AGENTOS_APPROVE_PREAUTH="git.push"` → approved → effect 跑 + boundary event;**`AGENTOS_APPROVE_PREAUTH` 無 git.push → denied@approval,effect 0,無 boundary**;unconfigured → deny-all → denied。mutation:git.push manifest requiresApproval 假設能設 false → superRefine 擋(parse 拒)。
- **egress gate**:url host 非-allowlist → denied@policy,effect 0,無 boundary。
- **boundary**:executed git.push → boundary event(boundarySummary.networkHosts=[host],**無 argvRedacted/url-query**);denied → 0 boundary。
- **credential placeholder**:toEnv 發 placeholder;literal secret env → makeExecEffect 拒。
- byte-identical:既有 15 工具 + CAP1-8 測不變;advertised 15→16(bin)。

## (5) Definition of Done（實測）
- [x] **DONE（merged)**:`gitPushManifest`(network-egress、destructive⇒requiresApproval true 強制、idempotent false)+ `gitPushBinding`(`["git","push","--"]` ——`git push --` 經真 local push 驗證為有效 + 擋 `--upload-pack=evil`;`url` 複用 `isAllowedFetchUrl`、`branch` 嚴格 `^[A-Za-z0-9._/][A-Za-z0-9._/-]*$`、toEnv git credential placeholder、networkHosts=`[new URL(url).hostname]` 複用 net.fetch hostname projector)+ 條件註冊(需 `{egress-allowlist, approval}` 雙 wired,bin 有 → 註冊;缺任一 → CAP3 refuse)。**bin closure 無需改**(requiresApproval/external/egress-fold/git.** allow-rule 全既有)。RED → verify **exit 0**(1478 passed + 29 skipped;+29 新測)。獨立 Opus4.8 review **PASS**:**approval gate 在第一個註冊真 destructive 工具上 load-bearing**(非-pre-auth→denied@approval→effect 0;requiresApproval mutation 翻;superRefine 拒 false)、egress 真 gate(非-allowlist→denied@policy,在 approval 前)、boundary executed 無 argvRedacted(url path+query canary 零進 WORM)、branch+`--` 擋全部 flag/shell/traversal 注入、URL→host 無 egress bypass、byte-identical(default 14、bin 16)、depcruise bite/secret-scan clean/無新依賴。2 MINOR informational(branch 無長度上限、`../..` 配 regex——reviewer 判定不可利用〔單一 argv token、無 shell、refspec 位置〕;可加 `.max()` 為廉價 hardening)。**SLICE-P0-003〔depcruise-in-verify〕確認已解**。
- **能力面 15 → 16**(第一個 destructive 真工具;approval+egress+boundary+credential-placeholder 在註冊真工具上端到端接通)。
- **⚠️ 誠實**:真 push + credential 解析 = deploy/EXEC2-gated(unauthenticated-to-allowlisted-until-EXEC2;git/網路是 deploy fact);in-repo 真接通的是 approval/egress/boundary/credential-placeholder 鏈(fake-proven)。remote-name/SSH/真 auth 不在本刀。

## (6) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純加 git.push + 條件註冊)。
- Depends-on:CAP2(git family)、CAP4(approval gate + budget approver)、CAP5/6(egress fold + net.fetch URL validator/projector + 條件註冊樣式 + fail-closed 規則)、CAP7(boundary)、credential inject、manifest superRefine。Blocks:其他 destructive/network 工具。
- **誠實前提**:CAP6b = 第一個真 destructive 工具,**approval+egress+boundary+credential-placeholder 在-repo 真接通**(fake substrate);真 push + auth = deploy/EXEC2-gated(unauthenticated-to-allowlisted-until-EXEC2)。git 在 sandbox = deploy fact。remote-name/SSH push、真 auth 不在本刀。
