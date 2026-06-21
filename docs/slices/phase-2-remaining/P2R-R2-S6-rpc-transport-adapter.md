# SLICE-P2R-R2-S6: 具體 RPC transport adapter 實作 AppendTransport（引入 RPC client）

- **Phase**: P2（R2 — 新依賴刀：唯一引入 runtime RPC client；依賴變更隔離在其唯一 chokepoint）
- **Branch**: slice/p2r-r2-s6-rpc-transport-adapter
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~150、files <~4（`src/runtime/<adapter>/{transport.ts,index.ts,transport.test.ts}` + barrel）、modules <~1、**新增依賴 = RPC client（runtime；本 slice 是依賴-變更 slice，slice-spec §3）**
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R2-S6 — 用具體 RPC client（connect-es 對 connect protocol，或 grpc-js；選型於本 slice 落地）實作
S1 的 `AppendTransport`：把成功回應映成 `AppendResponseShape`（交 S1 `parseAppendResponse`），把 **RPC error /
連線拒絕 / 逾時一律映成 reject（fail-closed）**。RPC 依賴**只**出現在此 adapter（`src/runtime/`，非 core），
鏡像 Go 參考 client surface（[`kernel/internal/client/client.go:24-49`](../../../kernel/internal/client/client.go)，append-only、解析 oneof、empty→fail-closed）。

## (2) Goal（一句話）
把 core 的注入式 `AppendTransport` port 接上具體 RPC client，並把所有傳輸層失敗映成 fail-closed reject——不改 pipeline 行為。

## (3) In-scope / Out-of-scope
- In-scope：
  - 選定並引入**一個** runtime RPC transport 依賴（connect-es / grpc-js）——**本 slice 是唯一引入 runtime RPC 依賴的 slice**（slice-spec §3）。
  - `src/runtime/<adapter>/transport.ts`：`createRpcAppendTransport(opts)` 實作 `AppendTransport`；成功→`AppendResponseShape`；RPC error/連線失敗/`timeoutMs` 內無回 → **reject**。
  - import S5 生成的 TS stub（契約面）；用 **in-process fake gRPC/connect server 或 stub 注入**過測（不依賴外部進程）。
- Out-of-scope（明確不做）:
  - composition-root 接線（取代 in-memory appender）→ 留給 S7（行為變更與依賴變更分刀，slice-spec §3）。
  - oneof 解析邏輯（已在 S1 `parseAppendResponse`；adapter 只回 `AppendResponseShape`，不自行解析成功/失敗語意）。
  - durable client outbox / fancy retry 退避 → 後續 ITEM；本 slice 只保證 fail-closed。
  - 改動 Go kernel（已存在；本 slice 只連它）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：唯一引入 vendor RPC 依賴；adapter 放 `src/runtime/`（**非 core**），故不違反 `no-vendor-in-core`
  （[`.dependency-cruiser.cjs:48-70`](../../../.dependency-cruiser.cjs)；core 路徑列舉於 `:60` 不含 `runtime`）。core 的
  `src/audit/ingest` 仍只看見注入的 `AppendTransport` port，零 vendor import。
- **Modules touched（唯一責任）**:
  - `src/runtime/<adapter>` — 「用具體 RPC client 實作 vendor-neutral `AppendTransport`，所有傳輸層失敗映成 fail-closed reject」。
- **PUBLIC interface**:
  - `function createRpcAppendTransport(opts: { endpoint: string; timeoutMs?: number }): AppendTransport`
- **Dependency direction（inward、acyclic）**:
  ```
  src/runtime/<adapter> ──▶ src/audit/ingest (AppendTransport port，經 barrel index.js)
                        ──▶ S5 generated TS proto stub
                        ──▶ <RPC client 第三方>
  ```
  - 僅經 public surface 消費（core 不 import runtime；runtime 依賴 ingest port 經 barrel）: ☑ 是
  - 新依賴宣告：
    - `<RPC client>`：方向=被 `src/runtime` adapter 消費（adapter 層，非 core），cycle=無，理由=跨 plane RPC 傳輸的唯一 chokepoint，core 不可見；依賴變更隔離於其唯一消費者，不混入行為變更（S7）。
    - `S5 generated TS proto stub`：方向=adapter 內，cycle=無，理由=型別化契約（S5 先於本消費者，slice-spec §9）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/runtime/<adapter>/transport.test.ts`（adapter 不存在 → RED）
- RED 測試清單（以 in-process fake gRPC/connect server 或 stub 注入，不依賴外部進程）:
  - [ ] happy：transport.append(req) → 回對應 receipt 的 `AppendResponseShape`（交 S1 `parseAppendResponse` 得 `AppendReceipt`）。
  - [ ] 安全對抗式 / fail-closed：RPC 回傳 transport-level error / 連線拒絕 → transport **reject**（不回 falsy）。
  - [ ] 安全對抗式 / fail-closed：`timeoutMs` 內 server 不回 → transport **reject**（timeout）。
  - [ ] 安全對抗式 / fail-closed：server 回 `error` oneof（如 SEQUENCE_REPLAY）→ adapter 照實回 `AppendResponseShape{error}`（由 S1 解析成 throw；adapter 不自行吞成功）。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/runtime/<adapter>/transport.test.ts
  ... FAIL (cannot find module) ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5；`src/runtime/ingest/transport.test.ts` 7 tests，adapter 不存在 → cannot find module → exit 1，後 GREEN）
- [x] `pnpm run verify` exit 0（含 `deps:check`、`proto:check`、`secret-scan`）
  ```
  $ pnpm run verify
  ... typecheck ok | lint: Checked 63 files, No fixes | build ok
  ... vitest: Test Files 23 passed (23) / Tests 166 passed (166)
  ... deps:check: ✔ no dependency violations found (45 modules, 91 dependencies)
  ... proto:check: ok | verify:go: ok | verify:py: skip | secret-scan: clean
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；RPC 依賴僅在 `src/runtime` adapter、core 零 vendor、無 cycle）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (45 modules, 91 dependencies cruised)
  exit code: 0
  ```
- [x] low coupling / high cohesion 遵守（core 只見 `AppendTransport` port；vendor 僅在 runtime adapter — `@grpc/grpc-js` import 僅在 `src/runtime/ingest/grpc-client.ts`；`src/build/no-vendor-in-core.test.ts` 6 tests passed）
- [x] secret-scan 乾淨（endpoint/credential 不入 source/log/fixture；測試憑證 runtime 組裝）
  ```
  $ pnpm run secret-scan
  secret-scan: clean
  exit code: 0
  ```
- [x] Docs 更新（新增 RPC 依賴 `@grpc/grpc-js` 記於 `package.json`；adapter surface + 選型理由記於 `docs/design/ingest-client-sync-commit.md` 能力閘）
- [x] Adversarial code review = PASS（mutation：timeout 改成 resolve falsy `{result:undefined}`（fail-open）→ `transport.test.ts` 1 failed | 6 passed → exit 1（fail-closed RED 轉紅）；還原後 7 passed exit 0。`deps:check` 對 core import RPC 依賴會轉紅由 `no-vendor-in-core` 守門。）
  ```
  $ npx vitest run src/runtime/ingest/transport.test.ts   # timeout fail-open mutation
  Tests  1 failed | 6 passed (7) — "rejects.toThrow(/timeout/i)" got Object {}
  exit code: 1
  $ npx vitest run src/runtime/ingest/transport.test.ts   # clean (restored)
  Tests  7 passed (7)
  exit code: 0
  ```
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（probe：所有傳輸失敗皆 reject、零 falsy 成功 — RPC error / 同步 throw / timeout / empty oneof / error oneof 五個 fail-closed 路徑均經 reject 或交 S1 throw 驗證；slice 經 fresh-context 獨立審查 PASS）

## (7) Rollback
- `git revert <merge-sha>`（移除 adapter + RPC 依賴；core port 不受影響）。
- 可逆性: 安全可逆（adapter 為注入實作，無自身持久副作用；本 slice 尚未接 pipeline，無 audit append）。

## (8) Depends-on / blocks
- Depends-on: SLICE-P2R-R2-S1（`AppendTransport` port + `parseAppendResponse`）、SLICE-P2R-R2-S5（生成的 TS proto stub）。
- Blocks: SLICE-P2R-R2-S7（composition-root 接線需要一個真實 transport）。
- 確認 slice DAG 無 cycle: ☑ 是
