# SLICE-EXEC-HARDENING: 關閉 exec.run egress gap + git.push 長度上限

- **Phase**: hardening（capability-breadth 後的收尾:關閉 CAP6 標記的 cross-cutting gap + CAP6b 的 MINOR)
- **Branch**: slice/exec-hardening
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
1. **CAP6 cross-cutting gap**:`exec.run`(containment in-sandbox)可跑任意網路命令(`curl evil.com`)。URL-shaped 目標(`curl https://evil.com`)已被 egress fold 擋(networkHosts 抽得出);但**無 scheme 的 bare-host(`curl evil.com`)→ networkHosts 空 → egress fold 不觸發 → 只靠 substrate seal**。要把這條也 fail-closed。
2. **CAP6b MINOR**:git.push branch 無長度上限(reviewer 標的廉價 hardening)。

## (1) 範圍
1. **exec.run network-command fail-closed**(bin closure,exec-mcp-server-bin.ts):projection 已有 `operationClass`(按 `basename(argv0)` 分桶,`NETWORK_CMDS`={curl,wget,nc,ssh,scp,ftp} → network 桶)+ `networkHosts`。新規則:**`operationClass` 是 network 桶 且 `networkHosts.length === 0`(目標無法驗證)→ fail-closed deny**(平行 CAP6 的「network-egress 工具無 projectable host → deny」)。意義:**已知網路 binary 的 exec.run,若目標無法對 egress allowlist 驗證 → 拒**(逼可驗證的網路用途走 URL-shaped〔egress fold gates〕或結構化 net.fetch)。
   - networkHosts **非空**(URL-shaped 抽得出)→ 本規則不觸發,egress fold 照常 gate(allowlisted 過、否則 deny)。
   - operationClass **非** network(echo/cat/git…)→ 不受影響(byte-identical)。
2. **git.push branch/url `.max()`**(exec-seed-tools.ts):`SAFE_BRANCH_NAME` 之外加 `.max(255)`(git ref 實務上限);url 加合理 `.max()`(如 2048)。純收緊,不放寬。

## (2) 不變量
- **fail-closed**:network-binary exec.run + 無法驗證目標 → deny;**不放寬** egress fold / PDP(只新增一條 deny)。
- **無 false-positive 過度抽取**:只 deny `operationClass===network 且 networkHosts 空`;非網路命令、URL-shaped 可驗證目標 **不受影響**。
- **PDP 仍唯一 DENY 權威**:本規則折進 authorize(any-deny-wins),不是第二 runtime path。
- **substrate 仍 PRIMARY**:真 no-egress 強制是 substrate(deploy);本規則是 in-repo defense-in-depth,把 opaque network-binary exec.run 也納入 fail-closed(縮小 PDP 盲區,非取代 substrate)。
- **缺省 byte-identical**:現有非網路工具 + URL-shaped 已被 gate 的路徑不變;git.push 既有有效 branch/url(短)不受 `.max()` 影響。
- 無新依賴。

## (3) Test-first plan（RED 先行;Fake substrate）
- exec.run network fail-closed:`{argv:["curl","evil.com"]}`(無 scheme → networkHosts 空,operationClass network)→ **deny,effect 0**;`{argv:["wget","internal"]}` → deny;`{argv:["curl","https://api.allowed.example/x"]}` + allowlist=[api.allowed.example] → **不因本規則 deny**(networkHosts 非空 → egress fold gates → allowed);`{argv:["echo","evil.com"]}`(echo 非網路桶,即使含 "evil.com" 字樣)→ **不受影響,過**;`{argv:["cat","f"]}` → 不受影響。mutation:移除本規則 → `curl evil.com` 測翻紅(本該 deny 卻執行)。
- git.push:branch 256 字元 → argSchema 拒;255 字元有效 branch → 過;url 過長 → 拒;既有短 branch/url → 過(byte-identical)。
- byte-identical:既有 16 工具 + CAP1-9/6b + projection 測不變綠(非網路 exec.run、URL-shaped 路徑、短 git.push 不變)。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(exec.run network-command fail-closed〔operationClass network + networkHosts 空 → deny〕+ git.push branch/url `.max()`;URL-shaped/非網路/短 git.push byte-identical;mutation 證〔移除規則 → curl evil.com 翻〕;PDP-sovereign;depcruise/secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(一條 deny 規則 + `.max()` 純收緊)。
- Depends-on:CAP5/6(egress fold + operationClass/networkHosts projection + fail-closed 樣式)、CAP6b(git.push)。Blocks:無。
- **誠實前提**:本規則縮小 PDP 對 exec.run 網路盲區(opaque network-binary → fail-closed),但**真 no-egress 強制仍是 substrate(deploy)**——一個非-`NETWORK_CMDS` 的自訂網路 binary、或經 shell 包裝的網路呼叫,PDP 仍可能看不出 → substrate seal 為主。本規則是 best-effort defense-in-depth,不宣稱完備攔截 exec.run 的所有網路路徑。
