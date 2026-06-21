# SLICE-P2R-R7-S7: Voice input adapter port（inactive capability gate）

- **Phase**: P2（R7 Personal 零技能殼 — voice 為後續 input adapter，不改管線）
- **Branch**: slice/p2r-r7-s7-voice-input-adapter-gate
- **Author**: Frontend Developer（agency-agents）   **Adversarial reviewer**: fresh-context 獨立 Opus 4.8（非作者）
- **Size budget**: <= 1 day；net LOC <~90、files <~4（`src/personal/voice/{port.ts,index.ts}` + `port.test.ts` + barrel 一行）、modules = 1（`personal/voice`）、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R7-S7 — 新增 vendor-neutral `SpeechToTextPort` + 一個 inactive `VoiceInput` 規格：voice 是 IntentGateway 前的 input adapter，transcribe→text 後**完全沿用 S1 text 路徑**；本 slice 只交付 port + 預設 **fail-closed inactive** 實作（capability gate G2），**不**接任何真實 STT vendor。

## (2) Goal（一句話）
把「voice later」這個能力閘**誠實落成可驗**：定義 STT port，預設 inactive（呼叫即 deny，不靜默假裝可用），證明 voice 只是 IntentGateway 的另一個 input、其餘管線零改動。

## (3) In-scope / Out-of-scope
- In-scope：
  - `SpeechToTextPort`：`transcribe(audio):Promise<{ ok:true; text:string } | { ok:false; reason:string }>`（vendor-neutral，無 vendor 名）。
  - `InactiveSpeechToText`：預設實作，**永遠回 `{ok:false, reason:"voice capability inactive"}`**（fail-closed、deny-by-default、capability gate G2）。
  - `voiceToIntent(stt, audio, ctx)`：transcribe 成功 → 轉呼 S1 `receiveText`（證明沿用 text 路徑）；transcribe 失敗 → 透傳 deny。
- Out-of-scope（明確不做）：
  - 任何真實 STT vendor adapter（Whisper/雲端 STT 等）→ 啟用條件見 §6 註記（G2）；本 slice 故意不接。
  - 音訊擷取 / 串流 / VAD → 後續。
  - 改動 IntentGateway/clarify/plan/approval 任何既有行為（voice 不得改管線）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 `personal/voice` 模組（port + inactive impl + adapter 函式）；對既有 text 路徑零改動。
- **Modules touched（唯一責任）**：
  - `src/personal/voice/port.ts` — 唯一責任：定義 STT port 與 inactive 預設實作（fail-closed）。
  - `src/personal/voice/index.ts` — barrel。
- **PUBLIC interface（`src/personal/voice/index.ts`）**：
  - `interface SpeechToTextPort { transcribe(audio:Uint8Array):Promise<{ok:true;text:string}|{ok:false;reason:string}> }`。
  - `const InactiveSpeechToText: SpeechToTextPort`（always-deny）。
  - `function voiceToIntent(stt:SpeechToTextPort, audio:Uint8Array, ctx:AgentContext): Promise<ReceiveOutcome>`。
- **Dependency direction（inward、acyclic）**：
  ```
  personal/voice ──▶ personal/intent (receiveText, ReceiveOutcome)   personal/voice ──▶ iam (AgentContext)
  ```
  - 僅經 public surface 消費（`personal/intent` 自有 barrel + `src/iam` barrel（B0 後）或 interim
    `src/iam/ids.ts` 例外）；STT vendor 為注入的 port impl（不 deep-import、core 無 vendor 名）；**不**經頂層
    `src/index.ts`：☐ 是。
  - 新依賴宣告：`personal/intent`（沿用 text 路徑，inward、無 cycle）；`iam`（AgentContext，inward；經
    `src/iam` barrel/B0 或 interim `ids.ts` 例外，使 `deps:check` exit 0）。

## (5) Test-first plan（RED 先行）
- 測試檔：`src/personal/voice/port.test.ts`（voice 不存在 → RED）。
- RED 測試清單：
  - [ ] **inactive fail-closed（對抗式）**：`InactiveSpeechToText.transcribe(...)` → `{ok:false, reason:"voice capability inactive"}`（永不回 text）。
  - [ ] `voiceToIntent(Inactive, audio, ctx)` → `{status:"denied"}`（透傳；voice 未啟用不得進管線）。
  - [ ] **沿用 text 路徑**：注入一個 fake STT（runtime 組裝，回固定 text）→ `voiceToIntent` 的輸出**等同**直接 `receiveText(該 text, ctx)`（證明 voice 只是 input adapter、管線零改動）。
  - [ ] fake STT transcribe 回 `{ok:false}` → `voiceToIntent` deny（不猜）。
- 首次紅燈證據（待填）：
  ```
  $ pnpm test src/personal/voice/port.test.ts
  ... FAIL ...
  exit code: 1   ← 待填
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（§5 首次 RED）。
- [ ] `pnpm run verify` exit 0（待填）。
- [ ] `pnpm run deps:check` exit 0（`personal/voice` 只 import personal/intent + iam barrel、無 cycle、**無 vendor 名於 core**、inward）。
- [ ] low coupling / high cohesion 遵守（voice 不改既有 text 路徑）。
- [ ] secret-scan 乾淨（fake STT canary runtime 組裝）。
- [ ] Docs 更新（`src/index.ts` barrel 加 `./personal/voice/index.js`；design §5 G2 標記 inactive）。
- [ ] Adversarial code review = PASS（fresh-context；攻擊：Inactive 偷偷回 text / voice 繞過 redaction 直入管線，須被測試抓到）— 摘要：<待填>。
- [ ] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（capability gate fail-closed、deny-by-default、voice 不旁路 text 路徑的 screen/redaction）。
> **能力閘 G2 註記**：本 slice 故意只交付 inactive port；啟用真實 voice 的條件 = 一個過 contract test 的 STT vendor adapter（落 `runtime/<vendor>` 或注入）且 S1 text 路徑全綠——屬後續 phase，不在 R7 核心不變量。

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `personal/voice` 模組 + barrel 一行）。
- 可逆性：安全可逆（純新增、inactive、無外部副作用）。

## (8) Depends-on / blocks
- Depends-on：S2（clarify 行為穩定後 voice 才沿用完整 text 路徑：receive→clarify）。
- Blocks：（無；S7 為 R7 收口之一）。
- 確認 slice DAG 無 cycle：☐ 是（S7 rank 3，依賴 rank 2 的 S2）。
