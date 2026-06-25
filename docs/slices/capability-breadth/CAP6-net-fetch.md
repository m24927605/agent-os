# SLICE-CAP6: `net.fetch` — 第一個真 network-egress 工具（egress primitive 真 gate 它)

- **Phase**: capability breadth — Slice 6（payoff:第一個打穿 seal 的真工具,治理鏈〔egress〕in-repo 接通)
- **Branch**: slice/cap6-net-fetch
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機 + 為何 net.fetch（不是 git.push)
CAP3/4/5 把 seal-punch 的治理前置(classifier gate / approval / egress)都備好。CAP6 出**第一個真 network-egress 工具**。選 **net.fetch(`curl -sS -- <url>`)而非 git.push**:net.fetch 的 **URL 在 argv → `buildExecRunProjection` 抽出 networkHosts → bin 的 egress fold(CAP5)能 in-repo 真 gate 它**(只有 allowlist 內的 host 過;default deny-all)。git.push 的 egress 目標不在 argv(`git push origin main`,URL 在 git config)→ PDP 看不到,只能靠 substrate(deploy)→ in-repo 證明力弱。**net.fetch 最能在-repo 證 egress primitive 真的 gate 一個真工具。**

## (1) 範圍
1. **`net.fetch` 工具**:
   - manifest:`name:"net.fetch"`、**`containment:"network-egress"`**、`sideEffect:"read"`、`idempotent:false`、`requiresApproval:false`(network read 由 **egress** gate,非 approval;approval 是 destructive 的事)。
   - binding:`argvPrefix:["curl","-sS","--"]`、`argSchema: z.object({ url: z.string().min(1) }).strict()`、`toArgv:(a)=>[a.url]`(`--` 守 `-` 開頭)、**`toEnv`(選)發 credential placeholder**(`placeholderForKey`/`toProviderEnv`,**絕非 literal secret**——makeExecEffect input guard 拒 literal、放行 placeholder)、`governanceProjector: 包 buildExecRunProjection`(networkHosts = URL host)。
   - 註冊進 bin 的 seed(`extraSeedTools`/`seedRegistry`):containment network-egress → requiredPrimitives `["egress-allowlist"]`;bin wired = `{"approval","egress-allowlist"}`(CAP4b+CAP5)→ **net.fetch 可註冊**。
2. **bin egress fold 真 gate(核心,CAP5)**:net.fetch 的 projection.networkHosts=[URL host] → `egressDecisionForProjection(networkHosts, binEgressAllow)`:host ∈ `AGENTOS_EGRESS_ALLOW` → 過;否則 → **denied@policy**;default 空 → deny-all。
3. **credential placeholder 縫**:net.fetch 的 toEnv(若帶 auth token)發 placeholder;證 makeExecEffect 拒 literal secret env、放行 placeholder。
4. **能力面 14 → 15**。git.push(destructive/approval + credential,egress 非 argv-visible)= follow-up(CAP6b,更 deploy-gated)。

## (2) 不變量
- **egress 真 gate(in-repo)**:net.fetch 到非-allowlist host → denied@policy(egress fold);到 allowlist host → 過;default(空 allowlist)→ deny-all。**這是 CAP5 primitive 第一次 gate 真工具。**
- **credential-blind**:toEnv **只發 placeholder**(非 literal secret);makeExecEffect input guard 拒 literal secret env;URL 含 secret → screen/redact(projection networkHosts userinfo-stripped)。
- **deny-by-default / strict**:unknown key → deny;`--` 守 url。**無 shell**(argv 純向量)。
- **commit-before-effect**:net.fetch 騎不變 pipeline。
- **註冊 gated**:net.fetch 因 containment network-egress 需 "egress-allowlist" ∈ wired——bin 有(CAP5),故可註冊;若某 composition 未 wire egress → net.fetch 在那 refuse(CAP3 gate)。
- **缺省 byte-identical**:純加一個工具 + 註冊;既有 14 工具 + CAP1-5 測不變;advertised 14→15。
- 無新依賴。

## (3) ⚠️ 誠實前提
- **真網路抵達 + credential 解析 = deploy/EXEC2-gated**:curl 在 sandbox 是 deploy fact;真 egress 強制 = OpenShell network policy(deploy,CAP5 誠實前提);credential placeholder 的真值解析 = OpenShell SecretResolver at egress(**EXEC2,未落**)→ 在那之前 net.fetch **unauthenticated-to-allowlisted-hosts**。
- **in-repo 真的是**:egress **gating**(PDP networkHosts fold 真 deny 非-allowlist host)+ credential placeholder 縫(拒 literal、發 placeholder)。**fake-proven**(Fake substrate 記 argv;不真打網路);LIVE 需真 sandbox + curl + 網路。

## (4) Test-first plan（RED 先行;Fake substrate）
- 註冊:net.fetch 在 wired `{"egress-allowlist",...}` 的 bin registry 註冊成功;在無 egress-allowlist wired 的 registry → CAP3 refuse(throw)。
- argv/strict:`net.fetch {url:"https://api.allowed.example/x"}` → argv `["curl","-sS","--","https://api.allowed.example/x"]`;unknown key → deny;url=`"-X DELETE ..."` 仍是 `--` 後單一 token(無 flag 注入)。
- **egress gate(核心)**:bin + `AGENTOS_EGRESS_ALLOW="api.allowed.example"`:net.fetch 到 `https://api.allowed.example/x` → 過(effect);到 `https://evil.com/x` → **denied@policy**,effect 0;**default(無 env)→ deny-all**,任何 url denied。mutation:net.fetch 無 governanceProjector(無 networkHosts)→ egress 不 gate → evil-host 測翻紅(本該 deny)。
- **credential placeholder**:net.fetch toEnv 發 placeholder → makeExecEffect 放行;注入 literal secret env → makeExecEffect 拒(input guard)。
- byte-identical:既有 14 工具 + CAP1-5 測不變綠;advertised 14→15。

## (5) Definition of Done（實測）
- [x] **DONE（merged)**:`net.fetch`(`curl -q --globoff --noproxy * -sS -- {url}`,containment network-egress、sideEffect read、requiresApproval false)+ **`isAllowedFetchUrl`**(deny-by-default:拒 file://、mailto:、host-less、userinfo、IP-literal、integer/octal/hex-IP、IPv6、rawHost≠whatwgHost)+ governanceProjector(networkHosts = `new URL(url).hostname`)+ `netFetchAuthEnv`(credential placeholder,拒 curl-control/proxy/非-identifier key)。**只在 wired ⊇ {"egress-allowlist"} 的 registry 註冊**(bin);advertised 14→15 在 bin。`isInScope` 加 network-egress-always-in-scope。RED → verify **exit 0**(1418 passed + 29 skipped;net.fetch 20 + bin-cap6 10 測;**strip-projector mutation 翻〔→ network-egress fail-closed deny,非 egress〕**)。獨立 Opus4.8 review PASS + writer 的 Codex gate(5 輪 hardening)+ Independent Verifier:**URL validator fuzz ~45 對抗 URL 無 egress bypass(投影 host == curl 實連 host)**、egress fold 真 gate(非-allowlist→denied@policy、default deny-all)、credential placeholder fail-closed、strict/no-shell、deviations byte-identical。
- **能力面 14 → 15**(seal-punch 治理鏈〔classifier+approval+egress〕首次接通真工具)。
- **⚠️ 誠實(reviewer 核實)**:in-repo 真的是 egress **gating**(PDP networkHosts fold deny 非-allowlist host);**真網路抵達 + credential 解析 = deploy/EXEC2-gated**(net.fetch unauthenticated-to-allowlisted-until-EXEC2;curl/網路是 deploy fact)。**exec.run(in-sandbox)的任意網路命令 NOT 被 PDP egress fold gate**——靠 substrate seal(deploy,PRIMARY);誠實標示,非 overclaim。git.push(egress 非 argv-visible + destructive)= CAP6b。

## (6) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純加 net.fetch + toEnv placeholder)。
- Depends-on:CAP5(egress fold + binWired egress-allowlist)、CAP3(classifier gate)、R9b-1(projection networkHosts)、credential inject(placeholderForKey/toProviderEnv)、exec pattern。Blocks:git.push(CAP6b)、其他 network 工具。
- **誠實前提**:CAP6 = 第一個真 network 工具,**egress gating 在-repo 真的**(PDP fold deny 非-allowlist);真網路抵達 + credential 解析 = deploy/EXEC2-gated(unauthenticated-to-allowlisted-until-EXEC2)。curl 在 sandbox = deploy fact;fake-proven,LIVE 需真 sandbox。git.push(egress 非 argv-visible + destructive/approval)= CAP6b。
