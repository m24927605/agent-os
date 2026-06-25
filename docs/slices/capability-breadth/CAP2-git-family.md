# SLICE-CAP2: in-sandbox git family（capability breadth 第 2 刀)

- **Phase**: capability breadth — Slice 2（仍住在 seal 內;純 pipeline-fit,零新 primitive)
- **Branch**: slice/cap2-git-family
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
CAP1 給了 in-sandbox 寫。CAP2 加 **in-sandbox git family**——agent 能在 sandbox 內看/記版本狀態,真實開發流程的常用動作。**仍在 seal 內、純 binding 加法、零新 primitive、零 seal-punch**(`git.push` 是 network/destructive 邊 → 延到 Slice 5/6)。

## (1) 範圍(5 個 git tool,FIXED argvPrefix,string-only args)
每個 = manifest + ExecToolBinding(`argvPrefix` 固定含子命令,brain 不能換子命令)+ 註冊。**沿用既有 `argSchemaToJsonSchema`**(已處理 ZodString / ZodArray<ZodString> / 空物件),**不需 converter 擴充**:
- **`git.status`**(read):`argvPrefix:["git","status","--porcelain"]`、`argSchema:z.object({}).strict()`(無 args)、`toArgv:()=>[]`。
- **`git.diff`**(read):`argvPrefix:["git","diff"]`、`z.object({}).strict()`、`toArgv:()=>[]`(diff working tree)。
- **`git.log`**(read):`argvPrefix:["git","log","--oneline","-n","50"]`(硬上限 50)、`z.object({}).strict()`、`toArgv:()=>[]`。
- **`git.add`**(write):`argvPrefix:["git","add","--"]`、`z.object({path:z.string().min(1)}).strict()`、`toArgv:(a)=>[a.path]`(`--` 守 `-` 開頭 path)。
- **`git.commit`**(write):`argvPrefix:["git","commit","-m"]`、`z.object({message:z.string().min(1)}).strict()`、`toArgv:(a)=>[a.message]`(message 是純 argv token,非 shell)。
- 全部 `idempotent:false`(read 可設 true?status/diff/log 無副作用 → `sideEffect:"read"`、`idempotent:true`;add/commit `sideEffect:"write"`、`idempotent:false`)、`requiresApproval:false`(in-sandbox,同 exec.run/write_file 姿態;**commit 是本機 in-sandbox commit,非 destructive**——destructive/network 是 `git.push`,延後)。
- 各宣告 `governanceProjector`(包 buildExecRunProjection on the tool's argv)。
- 註冊進 `seedRegistry()`/`seedBindings()`。
- **`git.push` 不在本刀**(network egress + destructive → 需 Slice 5 egress primitive + Slice 4 approval)。

## (2) 不變量
- **子命令固定**:argvPrefix 含子命令(`["git","status",…]`),brain 只供 string args(path/message),**不能注入子命令或 flag**(`.strict()` 擋 unknown key;`--` 守 path;message 是 `-m` 後的單一 token)。
- **無 shell**:argv 純字串向量,`; rm -rf /` 在 path/message 當 literal token,不被執行。
- **deny-by-default / strict**:unknown/extra key → deny,effect 不達。
- **credential-blind**:secret-shaped path/message → screen 拒。
- **commit-before-effect**:每個 git 工具騎不變 pipeline(write 類 effectful)。
- **sandbox boundary**:git 操作在 ephemeral sandbox 內;**git.push 延後**(不打穿 seal)。
- **缺省 byte-identical**:純加 5 個 binding;既有 9 工具 + EXEC4c 不變;advertised 9→14。
- **無新 primitive / 無 converter 擴充**(string-only args 既有 converter 已夠)。

## (3) ⚠️ 誠實前提
- **git binary 須在 sandbox image**(如 coreutils;deploy fact)。
- **git 命令需 git 工作樹**(sandbox cwd 是 repo);無 repo → git 自身報錯(runtime,非本刀治理問題)。
- **fake-proven**:in-repo 測證 argv/治理(Fake substrate 記 argv,不真跑 git);**LIVE 需真 sandbox + git + repo**(deploy fact)。
- brainstorm Slice 2 提的 `argSchemaToJsonSchema` string-enum 擴充 **本刀不需要**(5 工具 string-only)→ 延到真有工具需要 bounded enum 時(YAGNI)。

## (4) Test-first plan（RED 先行;Fake substrate）
- 每工具:argv == 固定 prefix(+ args);unknown key → deny(strict);tools/list 廣告 derived schema。
- **git.add path = `"-rf"` / `"; rm -rf /"`** → argv == `["git","add","--",<path>]`(path 是 `--` 後 literal token,不被當 flag/不被 shell 執行)。
- **git.commit message = shell-metachar / 多行** → argv == `["git","commit","-m",<message>]`(message 單一 literal token)。mutation:把 message 拆進多 token / 進 shell → 翻紅。
- credential-blind:secret-shaped message/path(runtime-built canary)→ screen 拒,substrate 0。
- read 類(status/diff/log)無 args:多給一個 key → deny。
- byte-identical:既有 9 工具 + EXEC4c-a/b + 既有 exec 測不變綠;advertised set 9→14。

## (5) Definition of Done（待實測填）
- [ ] RED → verify exit 0(5 git binding/manifest/registration + projector;argv 固定子命令、無 shell、strict deny、credential-blind;**缺省 byte-identical**〔advertised 9→14,既有不變〕;mutation 證;depcruise/secret-scan clean;無新依賴、無 converter 擴充);獨立 Opus 4.8 review PASS。

## (6) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純加 5 binding)。
- Depends-on:CAP1/EXEC pattern(ExecToolBinding/seed/argSchemaToJsonSchema)、R9b-2b(projector)、manifest。Blocks:`git.push`(Slice 5/6)。
- **誠實前提**:in-sandbox git only,`git.push` 延後;git binary + repo 是 sandbox/deploy fact;fake-proven,LIVE 需真 sandbox。
