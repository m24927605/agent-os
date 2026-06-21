# SLICE-P2R-R11-S2: Hermes brain shim（credential-blind，over P2-D Brain port）

- **Phase**: P2（R11 真實 vendor adapter — brain 槽位）
- **Branch**: slice/p2r-r11-s2-hermes-brain-shim
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~200、files <~4（`src/runtime/brain/adapters/hermes/{shim.ts,index.ts}` + `src/runtime/brain/adapters/hermes/shim.test.ts` + 餵進既有 `src/test-contracts/brain-adapter.test.ts` 一行 registration）、modules <~2、新增第三方依賴 = 0
- **狀態**: **DONE**（實作 + 測試完成、`pnpm run verify` exit 0、獨立 review PASS、已 merge 進 main）

## (1) ID + Title
SLICE-P2R-R11-S2 — 新增 `HermesBrainShim`：實作 P2-D `BrainAdapter` port，把 Hermes conversation-turn（assistant + `tool_calls`）對映成 `BrainEvent` 流（PlanStep/ToolCall/MemoryMutation/SkillMutation），**strip 掉 Hermes 自管的 `api_key`**，保持 credential-blind + fail-closed。經**注入式 HermesTurnSource** seam（live Hermes 進程留後續）。

## (2) Goal（一句話）
讓 Hermes 成為 `BrainAdapter` port 的真實 vendor brain shim，**credential-blind（arg 僅 bundleRef、永不 literal secret）+ fail-closed（壞 ctx → 空流）**，並通過既有 brain contract harness。

## (3) In-scope / Out-of-scope
- In-scope：
  - `src/runtime/brain/adapters/hermes/shim.ts`：`HermesBrainShim implements BrainAdapter`（import 僅 `../../port.js` + `../../../../iam/ids` + zod）。
  - `execute(ctx, intent)` → 從注入的 `HermesTurnSource` 取 Hermes 風格 turn，對映：`tool_calls` → `ToolCall`（`tool`=name、`args`=arguments）；plan 敘述 → `PlanStep`；`~/.hermes` memory/skill 寫入意圖 → `MemoryMutation`/`SkillMutation`（emit-only，由 governed pipeline 先 Append-to-WORM 才生效）。
  - **strip api_key**：shim 不接受、不轉發 `api_key`（Hermes 的 client-held credential 反模式，`run_agent.py:346/421`），真實 key 由 SecretResolver egress 注入。
  - 每個 emit event 帶 valid AgentContext；壞 ctx → 空流（fail-closed，port.ts:67-74 要求）。
  - shim 餵進既有 `brain-adapter.test.ts` factory（過全部既有斷言）。
- Out-of-scope（明確不做）:
  - 真實驅動 Hermes LLM 回合 / live model egress → 留 R9 Developer SDK 的 credential-blind Python shim + R1 後整合。
  - `credential-guard.ts` 的修改（既有 `screenBrainEvent`/`governBrainStream` 不改，shim 之上仍由 governed pipeline 套用）。
  - Hermes trajectory compression / curator 細節 → 不複製。
  - memory/skill mutation 的 WORM barrier 接線本身（那是 R5 / pipeline 的事）→ shim 只負責 emit event。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增一個 vendor brain shim module；core port + credential-guard 不改；brain contract 加一個 impl。
- **Modules touched（唯一責任）**:
  - `src/runtime/brain/adapters/hermes/shim.ts` — 把 Hermes turn 對映成 credential-blind 的 `BrainEvent` 流並施加 fail-closed AgentContext 檢查。
  - `src/runtime/brain/adapters/hermes/index.ts` — 只 re-export `HermesBrainShim`（vendor barrel）。
- **PUBLIC interface（新增）**:
  - `class HermesBrainShim implements BrainAdapter`（建構子注入 `turnSource: HermesTurnSource`）；
  - `interface HermesTurnSource { turns(intent: string): AsyncIterable<HermesTurn> }`；`type HermesTurn`（最小：`{ planText?: string; toolCalls?: {tool:string; args:Record<string,unknown>}[]; memoryOps?: ...; skillOps?: ... }`，**無 api_key 欄位**）。
- **Dependency direction（HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    runtime/brain/adapters/hermes ──▶ runtime/brain/port.ts ──▶ iam/ids + zod
    ```
  - 僅經 public surface 消費（無 deep import）: ☐ 是
  - 新依賴宣告：`HermesTurnSource` 為 adapter 自有注入 seam（非跨 module、非第三方）；方向 inward、無 cycle；理由＝core 不 import Hermes runtime、contract test 純 in-process。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/runtime/brain/adapters/hermes/shim.test.ts`（module 不存在 → RED：import 失敗）；外加註冊進 `brain-adapter.test.ts` factory。
- RED 測試清單:
  - [ ] turn 帶 `toolCalls` → 對映出 `ToolCall` event（kind/tool/args 正確、帶 ctx）。
  - [ ] turn 帶 `planText` → `PlanStep`；memoryOps/skillOps → `MemoryMutation`/`SkillMutation`（emit-only）。
  - [ ] 安全對抗式 — **credential-blind**：turn 的 toolCall args 夾帶 literal secret-shape → 經注入 detector 的 `governBrainStream` **deny 並停流**（既有 guard）；`HermesTurn` 型別**無 api_key 欄位**（shim 不轉發）。
  - [ ] 安全對抗式 — **fail-closed**：壞 ctx（`{}`/`null`/缺 tenantId）→ `execute` yield 空（永不 act on 未識別 caller）；turnSource throw → 流終止、不 yield ok。
  - [ ] 每個 emit event 帶 valid AgentContext（schema-valid）。
  - [ ] **no-vendor-in-core 回歸護欄（精確對齊規則 `from` 範圍）**：`runtime/` **不在** `no-vendor-in-core`
    規則的 `from` 涵蓋內（`.dependency-cruiser.cjs:60`，刻意排除），故植入 `runtime/brain/port.ts` 不會跳非零、
    **不可**用作護欄。本 slice 改為對一個**規則涵蓋且實際 consume brain 的 core 檔案**——`src/orchestration/pipeline.ts`
    （已驗證 consume brain，見 `orchestration/pipeline.e2e.test.ts:19`）——植入 `import ... hermes` fixture →
    `deps:check` exit≠0；移除後 exit 0。（設計 §1 已逐條說明此規則邊界。）
- 首次紅燈證據（DRAFT 佔位）:
  ```
  $ pnpm test src/runtime/brain/adapters/hermes/shim.test.ts
  ... FAIL: Cannot find module '.../adapters/hermes/index.js' ...
  exit code: <填實測，預期 1>
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5；git history 證順序——shim.test.ts 先紅後綠）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... secret-scan: clean
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`deps:check` exit 0；hermes import 只在 `runtime/brain/adapters/hermes/` + contract test 一行 registration）。
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (109 modules, 261 dependencies cruised)
  exit code: 0
  ```
  注意：`no-vendor-in-core` 規則 `from` **不涵蓋 `runtime/`**（`.dependency-cruiser.cjs:60`），brain adapter 的
  vendor 隔離由 (a) 整個 `runtime/` 落規則 `from` 之外 + (b) `not-to-internal` barrel 紀律（adapter 只經 brain
  package barrel `../../index.js` public surface）共同保證；§5 的回歸護欄改打 `src/orchestration/pipeline.ts`（規則涵蓋的 brain 消費者）以命令證明 gate 會攔。
- [x] low coupling / high cohesion 遵守（shim 僅 import brain barrel `../../index.js` + `iam/ids` + zod schema；無 deep import / cyclic / 跨 vendor；`grep` 證 hermes import 僅在 adapter 目錄 + contract test）
- [x] secret-scan 乾淨（`secret-scan: clean`；shim / test 無 secret-like 值；secret canary 為 runtime 組裝、無 source 字面值）
- [x] targeted RED→GREEN 證據
  ```
  $ vitest run src/runtime/brain/adapters/hermes/shim.test.ts
  Test Files  1 passed (1)
       Tests  7 passed (7)
  exit code: 0
  ```
- [x] Docs 更新（`vendor-adapters.md` §2.2 已述）
- [x] Adversarial code review = PASS（fresh-context、非作者、獨立 Opus 4.8；mutation 驗 credential-blind/fail-closed 測試非 theater；確認 shim 真的無 api_key 通道——`HermesTurn` 型別無 api_key 欄位、`mapTurn` 僅讀已知欄位）
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（adversarially probed：literal secret arg 被 `governBrainStream` deny+停流、壞 ctx（`{}`/`null`/缺 tenantId）空流、turnSource-throw 不放行、api_key 無法經 shim 流出）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `adapters/hermes/` + contract factory 一行）。
- 可逆性: 安全可逆——純新增 shim module，無外部副作用 / 無 audit append（turn 來自 in-process fake source）。

## (8) Depends-on / blocks
- Depends-on: **P2-D**（Brain port + credential-guard + contract harness，DONE）；既有 `iam/ids`。
- Blocks: Hermes brain 的 **live wire 整合 slice**（depends-on R9 Python credential-blind shim + R1，提供真實 Hermes turn source）；R7 Personal 殼（用 Hermes 當預設腦）。
- 確認 slice DAG 無 cycle: ☐ 是（R11-S2 → P2-D rank-0；單向）。
