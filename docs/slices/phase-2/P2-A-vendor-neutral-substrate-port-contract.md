# SLICE-P2-A: vendor-neutral ExecutionSubstrate port + Fake 第二實作 + contract harness

- **Phase**: P2（five-piece STEP 1 — ExecutionSubstrate 完成）
- **Branch**: slice/p2-a-substrate-port-contract
- **Author**: <id>    **Adversarial reviewer**: <fresh-context、非作者>
- **Size budget**: <= 1 day；net LOC <~300、files <~6（正名 + Fake + contract test + barrel + index 更新）、新增依賴 = 0
- **狀態**: **DONE**（merge；fresh-context IV = PASS、零 defect）

## (1) ID + Title
SLICE-P2-A — 把 vendor-named 路徑 `src/runtime/openshell/adapter.ts` **正名**為中立 `src/runtime/substrate/`（port/null/fake/barrel），新增 `FakeSandboxAdapter` 作為第二實作，並加一個 **factory-參數化 contract harness**，使 ExecutionSubstrate port 有 **≥2 impl + 共享 contract test**（可插拔的機械證明）。

## (2) Goal（一句話）
讓「身體」（ExecutionSubstrate）成為**真正可驗的可插拔槽位**：port 路徑不含 vendor 名、≥2 個實作（Null 失敗封閉 + Fake 記憶體）過同一 contract；OpenShell 將來是其下一個 adapter（P2 後續）。

## (3) In-scope / Out-of-scope
- In-scope：`src/runtime/substrate/{port.ts,null.ts,fake.ts,index.ts}`（port = SandboxAdapter 介面 + 共享 `deny()/ok()` 助手）；`FakeSandboxAdapter`（in-memory registry，仍 fail-closed on 壞 ctx）；`src/test-contracts/sandbox-adapter.test.ts`（factory over Null+Fake + 正向 import allowlist 防 egress）；刪除舊 `runtime/openshell/`；更新 `src/index.ts` barrel。
- Out-of-scope：真實 OpenShell gRPC client（P2 後續，落 `src/runtime/openshell/` 實作同 port）；start/stop 的真實 RPC（OpenShell proto 無，port 的 start/stop 為 noop/relay shim — 文件已記）。

## (4) Design + 模組 + 介面 + 依賴方向
- **Design delta**：搬移 + 新增第二實作 + 共享 contract。port 保持只 import `iam/ids` + zod（chokepoint 無 egress）。
- **PUBLIC interface**：`SandboxAdapter { create/start/stop/destroy(ctx, ...): Promise<AdapterResult> }`；`AdapterResult = {ok, sandboxId, event} | {denied, reason, event}`；`SandboxLifecycleEvent`（zod）。
- **依賴方向**：`null.ts`/`fake.ts` → `port.ts`（同模組）；port → `iam/ids`（allowlisted）。`src/index.ts`（頂層 barrel，exempt）re-export substrate barrel。

## (5) Test-first plan（RED 先行）
`src/test-contracts/sandbox-adapter.test.ts`（substrate 尚不存在 → RED：import 失敗）：
- `describe.each([Null, Fake])` 共享 contract：每個 lifecycle 回 schema-valid AdapterResult+event、`status===event.result`、ok⇒sandboxId、壞 ctx → denied+contextError、永不 throw。
- Null 專屬：全 deny + deny-by-default reason。Fake 專屬：create→ok→start/destroy ok、unknown id → denied。
- no-egress：port/null/fake 的 import 皆 ∈ allowlist {`zod`,`./port.js`,`../../iam/ids.js`}（正向 allowlist，涵蓋 bare-specifier）+ 無 fetch/import()/require()。
> 預期首次 RED：import `../runtime/substrate/index.js` 失敗（模組不存在）。

## (6) Definition of Done（實測）
- [x] **first RED**（substrate 不存在）：`vitest run sandbox-adapter.test.ts` → **Test Files 1 failed / no tests**（import 失敗，exit≠0）。
- [x] `pnpm run verify` **exit 0**（75 tests、deps 16 modules 0 violations、secret-scan clean）。
- [x] 舊 `runtime/openshell/` 已刪、無懸空 import（IV 確認）；`no-vendor-in-core` 仍綠、substrate path/import 零 vendor token。
- [x] secret-scan clean。
- [x] **Adversarial review = PASS**（fresh-context IV，零 defect；mutation：4 種壞 adapter — throws / status≠event / 允許壞 ctx / ok 無 id — 皆被 contract 抓；real Null+Fake 仍 PASS，證非 tautology；no-egress allowlist 對 `import fs from "fs"` 會咬）。

## (7) Rollback
revert commit；恢復 `runtime/openshell/adapter.ts`（git 還原）。

## (8) Depends-on / blocks
- Depends-on：P2-B（no-vendor-in-core 已 enforcing，正名後路徑須過規則）。
- Blocks：P2-D（沿用 port+contract-harness 模式）；真實 OpenShell adapter slice。
