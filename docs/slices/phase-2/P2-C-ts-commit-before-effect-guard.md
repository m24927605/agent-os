# SLICE-P2-C: TS commit-before-effect guard — 關閉 BLOCKING「護城河空心」

- **Phase**: P2（five-piece STEP 2 — commit-before-effect 接線；BLOCKING #1）
- **Branch**: slice/p2-c-commit-before-effect
- **Author**: <id>    **Adversarial reviewer**: <fresh-context、非作者>
- **Size budget**: <= 0.5 day；net LOC <~190、files <~4（`src/commitgate/{guard.ts,index.ts,guard.test.ts}` + `.dependency-cruiser.cjs` 把 commitgate 納 core from-list + barrel）、新增依賴 = 0
- **狀態**: **DONE**（merge；fresh-context IV = PASS、零 defect）

## (1) ID + Title
SLICE-P2-C — 新增 TS 端 commit-before-effect guard `commitBeforeEffect({appender,event,effect,timeoutMs?})`：外部 effect **只在** WORM append 取得 durable receipt **之後**才執行；append 失敗或逾時 → effect **絕不執行**、回 `{status:"aborted"}`（fail-closed）。鏡像 Go `kernel/internal/commitgate`。

## (2) Goal（一句話）
補上整個證據/snapshot/rollback 所依賴的時序保證：TS 端先前**沒有**任何東西序列化「append→receipt→才 effect」，使護城河空心；本 slice 讓它成為有 guard + 測試的事實。

## (3) In-scope / Out-of-scope
- In-scope：泛型、**零 src 耦合**的 sequencing combinator（`CommitAppender<E,R>` 注入 append、`effect` 注入；timeout race）；`CommitOutcome = committed|aborted`；測試（ordering / reject→aborted / timeout→aborted / 接 FakeSandboxAdapter 證失敗 commit 無 sandbox effect）；把 `commitgate` 納 `no-vendor-in-core` core from-list；barrel export。
- Out-of-scope：真實 audit ingest client 串接（composition root / 後續 ingest wrapper slice）；effect 成功 commit 後自身 throw 的重試策略（讓它 reject 傳播，已記）。

## (4) Design + 模組 + 介面 + 依賴方向
- **Design delta**：純 sequencing；append 先、await receipt、才跑 effect；任何 append 失敗/逾時 → 不跑 effect。
- **PUBLIC interface**：`commitBeforeEffect<E,R,T>({appender:{append(e:E):Promise<R>}, event:E, effect:()=>Promise<T>, timeoutMs?}): Promise<{status:"committed",receipt:R,result:T}|{status:"aborted",reason:string}>`。
- **依賴方向**：`guard.ts` **import 任何 src 模組皆無**（純 combinator）；composition root/測試注入真實 appender + effect。故 commitgate 與 audit/substrate 零耦合。

## (5) Test-first plan（RED 先行）
`src/commitgate/guard.test.ts`（guard 不存在 → RED：import 失敗）：
- ordering：append resolve 後才 effect（記錄順序 `["append","effect"]`）。
- append reject → effect 未跑、status aborted、reason 含原因。
- append 永不 resolve + timeoutMs → effect 未跑、aborted、reason 含 timeout。
- 接 FakeSandboxAdapter：append reject 時 `effect=()=>fake.createSandbox(...)` 未跑（事後 start 該 id → denied，證 create 從未發生）；append resolve 時 createSandbox 回 ok。
> 預期首次 RED：import `./guard.js` 失敗。

## (6) Definition of Done（實測）
- [x] **first RED**（guard 不存在）：`vitest run guard.test.ts` → import 失敗、no tests（exit≠0）。
- [x] `pnpm run verify` **exit 0**（80 tests、deps 18 modules 0 violations、secret-scan clean）。
- [x] `deps:check` 綠（IV 確認 guard.ts 零 src import、無 cycle；commitgate 已在 core from-list）。
- [x] secret-scan clean。
- [x] **Adversarial review = PASS**（fresh-context IV，零 defect；mutation：effect 移 append 前 → 4 紅、append 失敗仍跑 effect → 3 紅；hung append 逾時後 resolve/reject 仍不跑 effect、0 open handle / 0 unhandled rejection；fail-closed 對 sync-throw/reject/non-Error 完整）。

## (7) Rollback
revert commit（移除 commitgate 模組 + barrel + from-list 一詞）。

## (8) Depends-on / blocks
- Depends-on：無硬性 src 依賴（承接 P1 commitgate 概念 + 用 P2-A 的 FakeSandboxAdapter 做接線測試）。
- Blocks：sync-commit ingest wrapper、orchestration、snapshot/rollback（皆依賴此時序保證）。
