# SLICE-P2-D: vendor-neutral Brain port + credential-blind guard + 2 impls

- **Phase**: P2（five-piece STEP 3 — Brain port）
- **Branch**: slice/p2-d-brain-port
- **Author**: <id>    **Adversarial reviewer**: <fresh-context、非作者>
- **Size budget**: <= 1 day；net LOC <~300、files <~6（`src/runtime/brain/{port.ts,credential-guard.ts,fakes.ts,index.ts}` + `src/test-contracts/brain-adapter.test.ts` + barrel）、新增依賴 = 0
- **狀態**: **DONE**（merge；fresh-context IV = PASS、零 defect）

## (1) ID + Title
SLICE-P2-D — 新增 vendor-neutral Brain port（`BrainEvent` 判別聯集 plan-step|tool-call|memory-mutation|skill-mutation，各帶 AgentContext；`BrainAdapter.execute(ctx,intent): AsyncIterable<BrainEvent>`）+ **credential-blind guard**（帶 literal secret 的事件在 effect 前被 deny）+ **≥2 impl**（ScriptedBrain、EchoBrain）。

## (2) Goal（一句話）
讓「腦」成為**可驗的可插拔槽位**（預設 Hermes，可換；real adapter 落 `brain/<vendor>/` P2 後續），並把「不可信的腦必須 credential-blind」變**強制**：腦只能以 bundleRef 參照憑證，絕不可發出 literal secret。

## (3) In-scope / Out-of-scope
- In-scope：`port.ts`（BrainEvent zod + BrainAdapter，只 import iam+zod）；`credential-guard.ts`（`screenBrainEvent` + `governBrainStream`，secret 偵測 predicate **注入**，模組不 import audit；fail-closed：secret → deny、detector 拋例外 → deny-by-default）；`fakes.ts`（ScriptedBrain + EchoBrain，皆 fail-closed on 壞 ctx）；`src/test-contracts/brain-adapter.test.ts`（factory over 2 impl + credential-blind 測試，注入真實 `redactSecrets` 偵測；secret canary runtime 組裝）；barrel export。
- Out-of-scope：真實 Hermes adapter（P2 後續 Python shim）；memory/skill mutation 的 governed Append-to-WORM 落地（P2/P5）；entropy/窮舉式 secret 偵測（覆蓋 = redactSecrets pattern，已記）。

## (4) Design + 模組 + 介面 + 依賴方向
- **Design delta**：腦是 untrusted、credential-blind；只 PROPOSE 事件，不 deny、不碰 secret、不直接寫 WORM。guard 在腦邊界攔截 secret。
- **PUBLIC interface**：`BrainAdapter.execute(ctx:unknown,intent:string):AsyncIterable<BrainEvent>`；`screenBrainEvent(event,detectSecret):{ok|denied}`；`governBrainStream(events,detectSecret):AsyncIterable<ScreenResult>`（首次違規即 stop，secret 事件永不以 ok 浮現）。
- **依賴方向**：`port.ts`→ iam+zod；`credential-guard.ts`→ 只 `./port.js`（**不** import audit；偵測器注入）；`fakes.ts`→ iam+`./port.js`。real detector（audit/redact）只在 composition root/測試注入。

## (5) Test-first plan（RED 先行）
`src/test-contracts/brain-adapter.test.ts`（brain 模組不存在 → RED：import 失敗）：
- factory over [ScriptedBrain, EchoBrain]：emit schema-valid BrainEvent、每事件帶有效 context；壞 ctx → yield 空（fail-closed）。
- credential-blind：`screenBrainEvent` deny 帶 secret-shaped 值（藏在無辜欄位，by-shape）；detector 拋例外 → denied（deny-by-default）；`governBrainStream` 在 secret 事件 deny 並 **stop**（其後事件不浮現）；clean bundleRef 事件放行。
> 預期首次 RED：import `../runtime/brain/index.js` 失敗。secret canary = runtime 組裝（`sk-${"d".repeat(24)}`）使 secret-scan 不誤報。

## (6) Definition of Done（實測）
- [x] **first RED**（brain 不存在）：`vitest run brain-adapter.test.ts` → import 失敗、no tests（exit≠0）。
- [x] `pnpm run verify` **exit 0**（88 tests、deps 22 modules 0 violations、secret-scan clean）。
- [x] `deps:check` 綠；IV 確認 credential-guard.ts **零 audit import**（偵測器注入）、brain path/import 無 vendor token、no-vendor-in-core 綠。
- [x] secret-scan clean（secret canary 為 runtime 組裝、無 source 字面值）。
- [x] **Adversarial review = PASS**（fresh-context IV，零 defect；mutation：guard 永遠 ok → 2 紅、governStream 不 stop → 1 紅；深層巢狀 secret、**全部 4 種事件 kind** 皆被 screen、stream 確實 stop、detector 拋例外 → deny-by-default、9 種壞 ctx 皆 yield 空）。

## (7) Rollback
revert commit（移除 brain 模組 + barrel）。

## (8) Depends-on / blocks
- Depends-on：P2-A（沿用 port + contract-harness 模式）；audit/redact（測試注入）。
- Blocks：真實 Hermes brain adapter；governed memory（P5）。
