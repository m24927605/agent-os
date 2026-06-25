# SLICE-CAP3: capability classifier + REFUSE-to-register gate（純治理,無 feature)

- **Phase**: capability breadth — Slice 3（spine 化為可執行:composition-time deny-by-default)
- **Branch**: slice/cap3-classifier-gate
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
brainstorm spine = 「先建 primitive 再開 capability」。CAP3 把它**化為可執行的閘**:一個 capability 若**打穿 seal**(network egress / host-fs / destructive)而其 fail-closed primitive **尚未接**,**連註冊都不行**(composition-time refuse)。今天 14 工具全 in-sandbox → 全過(零行為改變);CAP3 的價值是讓 **Slice 4/5/6/9 的工具結構上不可能早於其 primitive**(預防性治理 scaffolding)。**PDP 仍是唯一 runtime DENY 權威**——這是**註冊准入閘**,非第二 runtime deny path。

## (1) 範圍
1. **`ToolManifest` + `containment`(required,單一真相源)**(src/tools/manifest.ts):`containment: z.enum(["in-sandbox","network-egress","host-fs-write"])`。`in-sandbox`=住 seal 內(騎 pipeline+sandbox,無需 primitive);其餘=打穿 seal 且各自指名 primitive。更新**所有** manifest(14 exec/git + 任何其他 + test fixtures)為 `containment:"in-sandbox"`(機械式;RED:缺欄位 → schema 拒 → 補)。
2. **classifier(純函式)**(新 `src/tools/capability-containment.ts`,vendor-neutral core):
   - `Primitive` = `"egress-allowlist" | "host-write-target" | "approval"`(治理 primitive 名)。
   - `requiredPrimitives(manifest): readonly Primitive[]`:`in-sandbox`→[];`network-egress`→`["egress-allowlist"]`;`host-fs-write`→`["host-write-target"]`;**且** `sideEffect==="destructive"`→ 併入 `"approval"`。
   - `WIRED_PRIMITIVES: ReadonlySet<Primitive>` = **`new Set()`**(目前**全未接**——egress〔S5〕/host-write〔S9〕/approval〔S4〕都還沒建)。
3. **refuse-to-register gate**(在 `ToolRegistry` 註冊時,fail-closed):`assertRegisterable(manifest, wired=WIRED_PRIMITIVES)`——`requiredPrimitives(manifest)` 有任一 ∉ `wired` → **throw**(refuse,靜態 reason,不洩)。`ToolRegistry` 建構/register 對每個 manifest 呼叫它。所有 registry(三面 + bin)都受閘。
4. **本刀無新工具、無 feature**——14 工具全 in-sandbox → requiredPrimitives []→ 註冊不變(byte-identical 行為)。

## (2) 不變量
- **composition-time deny-by-default**:打穿 seal 且 primitive 未接 → **註冊期 refuse**(throw),工具根本進不了 registry。
- **PDP 仍唯一 runtime DENY**:CAP3 是**註冊准入閘**,不改 runtime authorize/pipeline(不是第二 deny path)。
- **今天零行為改變**:14 工具 in-sandbox → []→ 全註冊(既有測續綠);registry 內容、authorize、advertised set 不變。
- **fail-closed**:`containment` required(缺 → schema 拒);未知 containment 值 → schema 拒;destructive ⇒ requires "approval" ∉ wired → refuse(與既有 destructive⇒requiresApproval superRefine 一致,且現在連註冊都擋)。
- **未來保證**:Slice 5 接 egress primitive(加入 WIRED)前,network-egress 工具不能註冊;Slice 4 接 approval 前,destructive 工具不能註冊;Slice 9 接 host-write 前,host-fs-write 工具不能註冊。
- 無新依賴;classifier vendor-neutral(no-vendor-in-core 綠)。

## (3) Test-first plan（RED 先行）
- classifier 純函式:in-sandbox→[];network-egress→["egress-allowlist"];host-fs-write→["host-write-target"];destructive(+任一 containment)→ 含 "approval"。
- **gate(核心)**:`new ToolRegistry([<合成 network-egress manifest>])` → **throw**(egress-allowlist 未接);`<合成 destructive manifest>` → throw(approval 未接);`<合成 host-fs-write>` → throw;`<in-sandbox read/write>` → 註冊成功。mutation:gate 不檢查(直接註冊)→ network-egress 合成測翻紅(本該 refuse 卻過)。
- **WIRED 注入**:`assertRegisterable(networkManifest, new Set(["egress-allowlist"]))` → 過(證 primitive 接上後可註冊;閘不是永拒,是 gated-on-wired)。
- **14 工具全過**:`seedRegistry()` 不 throw,14 工具都在;advertised set 不變(14);既有 authorize/exec 測續綠。
- manifest schema:缺 containment → 拒;未知值 → 拒;in-sandbox/network-egress/host-fs-write → 接受。
- byte-identical:既有全測(扣掉加 containment 欄位的 fixture 更新)語義不變綠。

## (4) Definition of Done（待實測填）
- [ ] RED → verify exit 0(manifest containment〔required〕+ 全 manifest 更新 + classifier + gate〔ToolRegistry refuse〕+ WIRED 空;合成 network/destructive/host-fs 工具註冊期 refuse〔mutation 證〕;WIRED 注入後可註冊;**14 工具全過、今天零行為改變**;PDP runtime 不變;depcruise no-vendor-in-core 綠;secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(containment 欄位 + classifier + gate;14 工具 in-sandbox 行為不變)。
- Depends-on:manifest、ToolRegistry。Blocks:**Slice 4(approval)/5(egress)/6(push,fetch)/9(host-write)**——這些 slice 接其 primitive(加入 WIRED)+ 把工具 containment 設對,才能註冊。
- **誠實前提**:CAP3 是**預防性治理 scaffolding**——今天無打穿-seal 工具,故零行為改變;其價值純在「未來工具不能早於 primitive」。是**註冊准入閘**,非 runtime deny(PDP 仍唯一)。`WIRED_PRIMITIVES` 是 composition-time 事實,後續 slice 接 primitive 時擴充。
