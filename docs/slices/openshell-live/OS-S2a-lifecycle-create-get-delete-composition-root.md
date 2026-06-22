# SLICE-OS-S2a: OpenShell lifecycle (Create/Get/Delete) + production composition root

- **Phase**: OpenShell live(完整 transport 的 unary lifecycle + 收掉 NC-S11b 的 same-instance tracking)
- **Branch**: slice/os-s2a-lifecycle-create-get-delete
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1–2 day（不含 gateway）；net LOC <~320（codec 訊息 + 3 RPC + composition root + 測試;生成碼不計)、新增依賴 = 0
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8 + assertPinnedImageDigest 修正=main-loop/Opus4.8;獨立 Opus4.8 reviewer = PASS;**composition root 對真實 gateway full lifecycle LIVE 驗證,NC-S11b tracking 收掉**;1 MINOR 見 §6）

## (1) ID + Title
SLICE-OS-S2a — 在 `createOpenShellGrpcTransport` 實作真實的 **CreateSandbox / GetSandbox / DeleteSandbox**(unary,over 既有 mTLS channel),取代 NC-S11b 的 fail-closed lifecycle stub;並建**生產 composition root** `createNemoClawOnOpenShell(...)`:用**同一個 `OpenShellSandboxAdapter` 實例** create sandbox → 等 READY(getSandbox 輪詢)→ 經 NemoClaw host/exec → reconcile → delete。**收掉 NC-S11b 的 same-instance refById tracking(無 test seed)。**

## (2) Goal（一句話）
讓 adapter 能對真實 gateway 完整地 create→ready→exec→delete 一個 sandbox(同一實例,refById 由真 CreateSandbox 填),NemoClaw 端到端不需任何 test 反射 seed。

## (3) In-scope / Out-of-scope
- In-scope:
  - **proto 子集 + codec**(`openshell.subset.proto` + `openshell.subset.codec.ts`,re-pin sha):新增 `CreateSandboxRequest{spec:SandboxSpec=1,name=2,labels=3}`、`SandboxSpec{template:SandboxTemplate=6,...}`(只 encode 我們用的 `template`)、`SandboxTemplate{image=1}`、`SandboxResponse{sandbox:Sandbox=1}`、`Sandbox{metadata:ObjectMeta=1,status:SandboxStatus=3}`、`ObjectMeta{id=1,name=2}`、`SandboxStatus{phase=<由 proto 取確切號>}`、`GetSandboxRequest{name=1}`、`DeleteSandboxRequest{name=1}`、`DeleteSandboxResponse{deleted=1}`。method ids `/openshell.v1.OpenShell/{CreateSandbox,GetSandbox,DeleteSandbox}`。**只 encode/decode 我們消費的欄位**(其餘 skip,forward-compatible)。
  - **grpc-transport 實作**(取代 stub):`createSandbox(req): Promise<SandboxResponse>`、`getSandbox(req): Promise<SandboxResponse>`、`deleteSandbox(req): Promise<DeleteSandboxResponse>`(unary makeUnaryRequest);型別對齊 adapter 的 `OpenShellLifecycleTransport`/`OpenShellReadinessTransport`(client.ts)。**credential-blind**(error 靜態、無 endpoint/cert)。`watchSandbox` 仍可留 stub/未實作(→ OS-S2b);adapter readiness 改用 getSandbox 輪詢路徑(已支援 Partial)。
  - **composition root** `src/runtime/nemoclaw/openshell-host.ts`(或近似):`createNemoClawOnOpenShell({ adapter, ctx, sandboxImage })` → `adapter.createSandbox(ctx,{image})` → poll `adapter`-層 readiness(getSandbox 直到 `phase===READY(2)`,有上限/逾時 fail-closed)→ 用**同一 adapter** 經 `createNemoClawOpenShellExec` + `createOpenShellExecCommandSink` 組 `NemoClawAgentHosting` → 回 `{ host, sandboxId, dispose: () => adapter.deleteSandbox }`。**image 須 pinned digest**(openclaw 的 `@sha256:…`,過 `assertPinnedImageDigest`)。
  - 單元測試(fake transport):create→ref{name,id} 填入、exec 用同一 adapter 無需 seed;getSandbox phase 映射(PROVISIONING→not-ready、READY→ready);readiness 逾時 fail-closed;delete by name;codec byte-fixture(create/get/delete)。
  - **live e2e**(gated):createNemoClawOnOpenShell(openclaw digest)→ create→等 READY→ hostAgent ok(**無 refById seed**)→ status running → reconcile → delete。沿用 `e2e-live-nemoclaw.sh`(改成 composition root 自建/自刪,移除 NC-S11b 的 seed 路徑)。
- Out-of-scope:
  - **WatchSandbox**(streaming readiness)→ **OS-S2b**(本刀 readiness 用 getSandbox 輪詢)。
  - 其餘 30+ provider/service/policy RPC。
  - 完整 SandboxSpec(policy/providers/gpu/env)——實測 minimal `{template:{image}}` 即可 create(gateway 不強制 policy);只 encode template。

## (4) Design delta + 依賴方向
- grpc-transport 補滿 unary lifecycle(stub→真);composition root 接 create+exec 於**同一 adapter**(結 tracking)。grpc-js 仍限 `src/runtime/openshell`;composition root 在 `src/runtime/nemoclaw`(接線層)。depcruise 綠。
- **PUBLIC**:`createOpenShellGrpcTransport` 現回完整 `OpenShellReadinessTransport`(除 watch→OS-S2b);`createNemoClawOnOpenShell(opts)`。

## (5) Test-first plan（RED 先行）
- codec byte-fixture(create/get/delete decode/encode 不存在 → RED)。
- transport 對 fake：create→SandboxResponse、get→phase、delete→{deleted}。
- composition root 對 fake adapter:create 填 refById → exec 無 seed 成功;readiness 逾時 → fail-closed。
- live e2e:對未起 gateway → create reject → 測試 FAIL(RED);真 gateway → 綠。
- 我對真 gateway 跑 `pnpm run e2e:live-nemoclaw`(composition root 版)。

## (6) Definition of Done（實測）
- [x] RED:codec/transport/composition/live 測試在實作前紅(22 failed,`decodeDeleteSandboxResponse is not a function` 等)。
- [x] **tracking 收掉**:`pnpm run e2e:live-nemoclaw` 經 composition root **無 refById 反射 seed** 通(create→READY→host→reconcile→delete,同一 adapter);reviewer grep 確認 NC-S11b 的 `as unknown as {refById}` hack 已移除、mutation(create 不填 refById → exec unknown-sandbox 紅)證實同-adapter exec 真不需 seed。
- [x] `pnpm run verify` **exit 0**(816 passed + 8 skipped;gated live SKIP;codec/transport/composition 單元測試綠;`openshell:proto:check` re-pin 綠〔reviewer proto-tweak→FAIL 證實〕;depcruise grpc-js confined〔core 注入→exit 2 證實〕;secret-scan clean)。
- [x] **live(我對真實 gateway 跑)`pnpm run e2e:live-nemoclaw` exit 0**:3/3——composition root **真實 CreateSandbox**(openclaw @sha256 digest)→ poll READY → host → status running → reconcile('health-probe') → DeleteSandbox;sandbox 自清空。
- [x] credential-blind(deny reason 靜態、無 endpoint/cert;secret-scan clean);fail-closed(create/get/delete error→reject;readiness 逾時→deny+best-effort delete,絕不在 PROVISIONING 前進)。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8;codec phase=6 / tracking-no-seed / readiness / assertPinnedImageDigest 皆 mutation 證實非 vacuous;assertPinnedImageDigest 14-case 安全探測〔含 newline-injection〕全擋 mutable tag;8 攻擊面 HELD/N/A)。
- [x] **誠實回報 — 第 3 個 live-caught bug 修正**:`assertPinnedImageDigest` regex `/^sha256:[0-9a-f]{64}$/` 只收**裸 digest**,拒了 gateway-pullable 的完整 ref `ghcr.io/...@sha256:...` → live create denied;修為 `/(?:^|@)sha256:[0-9a-f]{64}$/`(收 bare 或 `@sha256:` digest-pinned ref,**仍拒 `:latest`/`:1.2.3` mutable tag**,供應鏈 pin 不弱化)+ 新測試。
> **MINOR(非阻斷,tracking)**:depcruise `not-to-internal` 以第一路徑段為界,**不強制** `runtime/nemoclaw`↔`runtime/openshell` 之間 barrel-only(本刀程式有遵守 `../openshell/index.js`;core→vendor 仍強制)。pre-existing 規則粒度,未來可細化。

## (7) Rollback
- `git revert <merge-sha>`(lifecycle 退回 stub + 移除 composition root)。NC-S11b exec 路徑不受影響(仍可 seed 測)。

## (8) Depends-on / blocks
- Depends-on:OS-S1(channel+codec)、NC-S11b(binding/exec/收斂)、OpenShell adapter(createSandbox/getSandbox/deleteSandbox 消費點)、真實 proto(v0.0.66)、運行 gateway。實測 minimal CreateSandbox(digest,無 policy)可行。
- Blocks:OS-S2b(watch)。
- **誠實前提**:live 需運行 gateway(我跑);verify hermetic。
