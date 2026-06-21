# SLICE-P2R-R10-S6:【capability-gated】Brain memory 版本化 — BrainState{export/import/schemaVersion} port

- **Phase**: P2（time-travel ITEM R10；Brain memory 版本化，design §27-§37；Build-list #6、#10）
- **Branch**: slice/p2r-r10-s6-brain-memory-versioning
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~160、files <~4（`src/runtime/brain/state.ts` + `src/test-contracts/brain-state.test.ts` + `src/runtime/brain/fakes.ts` 擴一個 impl + barrel 一行）、modules <~1（runtime/brain）、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R10-S6 — 在既有 vendor-neutral Brain port 上新增 `BrainState{ export(): VersionedMemory; import(VersionedMemory): void; schemaVersion: number }` 抽象，讓 orchestration 能 snapshot/restore 腦的 memory 到某版本（`memory@T = fold(memory events ≤ N)`）**而不需懂 Hermes 內部**（保 pluggability，design §34）；export **credential-blind**（序列化前過 redact，design §52）。

## (2) Goal（一句話）
讓「腦的 memory 狀態」成為可版本化、可 export/import 的可插拔抽象，使 restore 後腦被還原到 T 當時狀態（不帶「未來」memory），且 export 永不外漏明文 credential。

## (3) In-scope / Out-of-scope
- In-scope：
  - `BrainState` interface（`export`/`import`/`schemaVersion`）+ `VersionedMemory` Zod schema（`{ schemaVersion, sequence(對映 SnapshotRecord.memoryVersion), entries: readonly {key, valueRef}[] }`，**只存參照/雜湊、不存 raw value**）。
  - **credential-blind 強制**：`export` 在序列化前過注入的 `redactSecrets` detector；偵測到 secret-shaped 值 → fail-closed（deny export，不吐半 redact 的物件）。
  - `import` 嚴格驗證 `schemaVersion`（不符 → reject，向後相容門檻）。
  - 第二 impl（沿用 P2-D 的 fakes 模式）：`ScriptedBrainState`（in-memory，可 export/import 驗證 round-trip）。
  - 對應既有 `MemoryMutation` BrainEvent（port.ts:41 已存在 `kind:"memory-mutation"`，本 slice 讓其可被版本化 fold——`memory@T` 用 R10-S1 的 fold 引擎對 memory-mutation 事件子集重建）。
- Out-of-scope（明確不做）：
  - 真實 Hermes adapter 發 `MemoryMutatedEvent` 進 WORM（Hermes 目前原地 mutate、無版本化事件——grounded `agent/memory_manager.py:515` `sync_all`：經 `provider.sync_turn(...)` 原地寫入、無版本化事件；design §30）→ 屬 R11 真實 vendor adapter / capability-gated 落地。**本 slice 只交付 port + fake，不接真 Hermes。**
  - skill mutation 版本化（同機制，留後續）。
  - OpenShell sandbox 記憶體還原（**不可能**：`ffi.rs` 僅綁 `krun_create_ctx`/`krun_start_enter` 等生命週期符號，無 CRIU/libkrun checkpoint symbol；design §50）→ 永遠 reprovision，不在本 slice 範圍。
  - **interim fallback**（design §37：rollback 時直接 reset memory + 下輪 prefetch 重載）作為能力閘記錄，不在本 slice 實作其接線。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：Brain port 新增可版本化 memory 抽象；解耦 orchestration 對 Hermes 內部的依賴（dependency-cruiser 仍擋 orchestration 直接 import hermes，design §34）。export 強制 credential-blind。
- **Modules touched（唯一責任）**：
  - `src/runtime/brain/state.ts` — 定義 BrainState 抽象 + VersionedMemory schema + credential-blind export 守則（high cohesion：只做 memory 版本化契約 + redact 守門；不做 WORM append、不 import audit 內部）。
  - `src/runtime/brain/fakes.ts` — 擴一個 `ScriptedBrainState` 第二 impl（contract test 用）。
- **PUBLIC interface（新增）**：
  - `const VersionedMemory = z.object({ schemaVersion: z.number().int(), sequence: z.number().int().nonnegative(), entries: z.array(z.object({ key: z.string().min(1), valueRef: z.string().min(1) })).readonly() }).strict()`。
  - `interface BrainState { readonly schemaVersion: number; export(detectSecret: (v: unknown) => boolean): VersionedMemory; import(mem: VersionedMemory): void; }`。
- **Dependency direction（inward、acyclic）**：
  ```
  runtime/brain/state.ts ──▶ zod, iam/ids (barrel) ──▶ domain
  fakes.ts ──▶ ./state.js, ./port.js
  ```
  - 僅經 public surface 消費（無 deep import）: 是；**不** import audit（secret detector 注入，沿用 P2-D credential-guard 模式）；orchestration 永不 import hermes（保 pluggability）。
  - 新依賴宣告：無新增第三方依賴；對 R10-S1 fold 的關聯為「memory@T 用 fold 重建」的設計連結（runtime 注入，非 module import 邊），不製造 cycle。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`src/test-contracts/brain-state.test.ts`（`state.ts` 不存在 → 首次 RED：import 失敗）。
- RED 測試清單：
  - [ ] round-trip：`export` 出的 VersionedMemory `import` 回去 → 狀態等價（contract over ≥1 fake impl）。
  - [ ] `schemaVersion` 不符 → `import` reject（向後相容門檻）。
  - [ ] **credential-blind（對抗式）**：memory 含 secret-shaped 值（藏在 entry value）→ `export` 經注入 detector **fail-closed**（不吐物件）；detector 拋例外 → deny-by-default（不 export）。
  - [ ] **`.strict()`**：VersionedMemory 多餘欄位 → parse fail。
  - [ ] `valueRef` 為參照字串（非 raw value）→ schema 接受；塞入 raw-looking secret value 於 `valueRef` → 仍被 credential-blind detector 攔。
- 首次紅燈證據（待填）：
  ```
  $ pnpm test src/test-contracts/brain-state.test.ts
  ... FAIL (cannot find module '../runtime/brain/state.js') ...
  exit code: <填實測>
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: <填實測>
  ```
- [ ] dependency-boundary 綠（`pnpm run deps:check` exit 0；state.ts 零 audit import、零 vendor token、no-vendor-in-core 綠；orchestration 不 import hermes）
- [ ] low coupling / high cohesion 遵守（state.ts 只做 memory 版本化契約 + redact 守門；detector 注入）
- [ ] secret-scan 乾淨（secret canary runtime 組裝、無 source 字面值）
- [ ] Docs 更新（design §27-§37、§50 能力閘已標：Hermes 未版本化為 capability-gated、sandbox 記憶體不可還原、interim = reset+prefetch fallback）
- [ ] Adversarial code review = PASS（fresh-context；mutation：把 export 的 redact 守則拿掉 → credential-blind 測試須轉紅；把 schemaVersion 檢查拿掉 → 相容門檻測試須轉紅）
- [ ] **安全不變量（credential-blind）**：Independent Verifier Pass 已執行——對抗式探測 secret 不出 export、detector 拋例外 → deny-by-default、深層巢狀 secret 亦攔

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `state.ts` + fakes 擴充 + barrel 一行）。
- 可逆性：安全可逆——純新增 port 抽象 + fake，無 IO、無 WORM append、無資料遷移、無外部副作用。

## (8) Depends-on / blocks
- Depends-on：P2-D（沿用既有 vendor-neutral Brain port + credential-guard 注入模式 + fakes 模式；`MemoryMutation` 事件 kind 已存在於 port.ts:41）。
- Blocks：R10-S3 的 composition root（restore 的 brain import 階段注入 `BrainState.import`）；R11 真實 Hermes adapter 落地版本化。
- 確認 slice DAG 無 cycle：是（S6 → P2-D，已 merge；與 S1 為 runtime 注入關聯、非 module import 邊，無 cycle）。
